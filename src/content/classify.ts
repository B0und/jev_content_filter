// Classification owns cache access, provider-revision checks, and cancellable
// text/image scoring. DOM and block policy stay in their dedicated modules.
import { Clock, Effect, Semaphore } from 'effect';
import * as Schema from 'effect/Schema';
import { browser } from 'wxt/browser';
import { browserEffect, BrowserError } from '../platform/browser';
import {
  CATEGORY_KEYS,
  STORAGE_KEYS,
  type CategoryKey,
  type TextProvider,
} from '../filtering/types';
import { CategoryKeySchema } from '../filtering/schemas';
import { settings, type Post } from './state';
import { canonicalMediaUrl } from './dom';
import { OCR_PIPELINE_REVISION, ocrImageUrl } from '../inference/ocr-policy';
import { InferenceReplySchema, OcrReplyCodec } from '../inference/contracts';
import { IMAGE_PIPELINE_REVISION, SELECTED_MODELS } from '../inference/model-catalog';
const JevReplySchema = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    sexual: Schema.Finite,
    provider: Schema.String,
    revision: Schema.Finite,
  }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
]);

class ClassificationError extends Schema.TaggedError<ClassificationError>()('ClassificationError', {
  message: Schema.String,
}) {}

// --- Persistent score cache -------------------------------------------------

/**
 * Bump when cache shape/read rules change so stale entries are ignored by
 * construction (keys carry the version).
 */
const CACHE_VERSION = 7;
const CACHE_PREFIX = `${STORAGE_KEYS.scores}:v${CACHE_VERSION}:`;
/** Legacy prefixes are only ever evicted, never read. */
const ALL_CACHE_PREFIX = `${STORAGE_KEYS.scores}:`;
const CACHE_LIMIT = 4000;
let cacheWrites = 0;

const CachedProbabilitySchema = Schema.Finite.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1)),
);
const CachedScoresSchema = Schema.Record(
  CategoryKeySchema,
  Schema.optionalKey(CachedProbabilitySchema),
);
const CachedScoreEntrySchema = Schema.Struct({
  scores: CachedScoresSchema,
  ts: Schema.Finite,
});
const CachedTimestampEntrySchema = Schema.Struct({ ts: Schema.Finite });
const isCachedScoreEntry = Schema.is(CachedScoreEntrySchema);
const isCachedTimestampEntry = Schema.is(CachedTimestampEntrySchema);
const isCategoryKey = Schema.is(CategoryKeySchema);

type CacheIdentity =
  | { task: 'image' | 'imageText'; url: string }
  | { task: 'sexualText'; provider: TextProvider; text: string }
  | { task: 'aiText'; text: string };

/** Build the single versioned cache key for every classifier input. */
function cacheKey(identity: CacheIdentity): string {
  let kind: string;
  let revision: string;
  let input: string;
  switch (identity.task) {
    case 'image':
      kind = 'i';
      revision = IMAGE_PIPELINE_REVISION;
      input = canonicalMediaUrl(identity.url);
      break;
    case 'imageText':
      kind = 'o';
      revision = OCR_PIPELINE_REVISION;
      input = canonicalMediaUrl(identity.url);
      break;
    case 'sexualText':
      kind = 't';
      revision = `${identity.provider}:${OCR_PIPELINE_REVISION}`;
      input = identity.text;
      break;
    case 'aiText': {
      kind = 'a';
      const descriptor = SELECTED_MODELS.aiText;
      revision = `${descriptor.id}:${descriptor.revision}`;
      input = identity.text;
      break;
    }
  }
  return `${CACHE_PREFIX}${kind}:${revision}:${hash64(input)}`;
}

/** 64-bit-ish FNV-1a + djb2 pair, base36: collisions become vanishingly unlikely. */
function hash64(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 5381;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193);
    h2 = (Math.imul(h2, 33) ^ code) >>> 0;
  }
  return `${(h1 >>> 0).toString(36)}${h2.toString(36)}`;
}

export const readCache = Effect.fnUntraced(function* (key: string) {
  // Older cache versions are never read, only evicted.
  if (!key.startsWith(CACHE_PREFIX)) return null;
  const stored = yield* browserEffect('read score cache', () =>
    browser.storage.local.get(key),
  ).pipe(Effect.orElseSucceed(() => null));
  if (stored === null) return null;
  const value: unknown = stored[key];
  if (!isCachedScoreEntry(value)) return null;
  const scoreKeys = Object.keys(value.scores);
  if (scoreKeys.length === 0 || !scoreKeys.every(isCategoryKey)) return null;
  return value;
});

export const writeCache = Effect.fnUntraced(function* (
  key: string,
  scores: Partial<Record<CategoryKey, number>>,
) {
  const shouldEvict = yield* Effect.sync(() => ++cacheWrites % 250 === 0);
  const timestamp = yield* Clock.currentTimeMillis;
  yield* browserEffect('write score cache', () =>
    browser.storage.local.set({ [key]: { scores, ts: timestamp } }),
  ).pipe(Effect.ignore);
  if (shouldEvict) yield* evictCache();
});

function cacheTimestamp(value: unknown): number {
  return isCachedTimestampEntry(value) ? value.ts : 0;
}

export const evictCache = Effect.fnUntraced(function* () {
  const all = yield* browserEffect('read score cache for eviction', () =>
    browser.storage.local.get(null),
  ).pipe(Effect.orElseSucceed(() => null));
  if (all === null) return;
  const entries = Object.entries(all).filter(([key]) => key.startsWith(ALL_CACHE_PREFIX));
  if (entries.length <= CACHE_LIMIT) return;
  // Keep the newest entries; drop the rest.
  const dropKeys = entries
    .sort((a, b) => cacheTimestamp(b[1]) - cacheTimestamp(a[1]))
    .slice(CACHE_LIMIT)
    .map(([key]) => key);
  yield* browserEffect('evict score cache', () => browser.storage.local.remove(dropKeys)).pipe(
    Effect.ignore,
  );
});

// --- Retry policy -----------------------------------------------------------

/**
 * Persistent failures (missing/invalid key, billing) must not auto-retry
 * forever; transient ones (network, 5xx) may.
 */
export function canRetry(error: string): boolean {
  return !/no .*key|add an .*key|missing .*key|401|403|unauthorized|forbidden|invalid.*key|billing|payment|insufficient/i.test(
    error,
  );
}

/** Give up on a post after this many failed scans, whatever the error. */
export const MAX_RETRIES = 5;

const CachedImageTextSchema = Schema.Struct({ text: Schema.String, ts: Schema.Finite });
const imageTextLock = Semaphore.makeUnsafe(1);
const imageText = Effect.fnUntraced(function* (urls: string[]) {
  const texts: string[] = [];
  const errors: string[] = [];
  for (const url of urls) {
    const outcome = yield* Effect.result(
      imageTextLock.withPermits(1)(
        Effect.gen(function* () {
          const key = cacheKey({ task: 'imageText', url });
          const stored = yield* browserEffect('read image text cache', () =>
            browser.storage.local.get(key),
          );
          if (Schema.is(CachedImageTextSchema)(stored[key])) return stored[key].text;
          const raw: unknown = yield* browserEffect('read text in image locally', () =>
            browser.runtime.sendMessage({ type: 'extract-image-text', url: ocrImageUrl(url) }),
          );
          const words = yield* Schema.decodeUnknownEffect(OcrReplyCodec)(raw).pipe(
            Effect.flatMap(Effect.fromResult),
            Effect.mapError(
              (cause) => new ClassificationError({ message: `Image text: ${cause.message}` }),
            ),
          );
          const ts = yield* Clock.currentTimeMillis;
          yield* browserEffect('cache image text', () =>
            browser.storage.local.set({ [key]: { text: words, ts } }),
          ).pipe(Effect.ignore);
          if (++cacheWrites % 250 === 0) yield* evictCache();
          return words;
        }),
      ),
    );
    if (outcome._tag === 'Failure') errors.push(message(outcome.failure));
    else if (outcome.success.trim()) texts.push(outcome.success.trim());
  }
  return { texts, errors };
});

// --- Text scores ------------------------------------------------------------

export const textScores = Effect.fnUntraced(function* (
  post: Post,
  text: string,
  urls: string[] = [],
): Effect.fn.Return<
  { scores: Partial<Record<CategoryKey, number>>; errors: string[] },
  BrowserError | ClassificationError
> {
  const current = settings.current;
  const provider = current.textProvider;
  const revision = current.textConfigRevision;
  const extractionErrors: string[] = [];
  const jobs: Array<
    Effect.Effect<Partial<Record<CategoryKey, number>>, BrowserError | ClassificationError>
  > = [];
  jobs.push(
    Effect.gen(function* () {
      const ocr = yield* imageText(urls);
      extractionErrors.push(...ocr.errors);
      if (!current.enabled.sexualText) return {};
      const combined = [
        text && `Tweet text:\n${text}`,
        ...ocr.texts.map((words, index) => `Text in attached image ${index + 1}:\n${words}`),
      ]
        .filter(Boolean)
        .join('\n\n');
      if (!combined) return {};
      const input = ocr.texts.length ? combined : text;
      const key = cacheKey({ task: 'sexualText', provider, text: input });
      const cached = yield* readCache(key);
      if (cached?.scores.sexualText !== undefined) return { sexualText: cached.scores.sexualText };
      if (
        !settings.current.masterEnabled ||
        !settings.current.enabled.sexualText ||
        settings.current.textProvider !== provider ||
        settings.current.textConfigRevision !== revision
      )
        return {};
      if (!settings.current.providerKeys[provider])
        return yield* new ClassificationError({
          message:
            'Add an API key in the Text tab to check sexual text. Local AI-written-text detection does not need a key.',
        });
      const rawReply: unknown = yield* browserEffect('classify sexual text', () =>
        browser.runtime.sendMessage({
          type: 'jev',
          tweetId: post.id,
          text: input,
          provider,
          revision,
        }),
      );
      const reply = yield* Schema.decodeUnknownEffect(JevReplySchema)(rawReply).pipe(
        Effect.mapError(
          () => new ClassificationError({ message: 'Invalid text classification response.' }),
        ),
      );
      if (!reply.ok) return yield* new ClassificationError({ message: reply.error });
      if (reply.provider !== provider || reply.revision !== revision)
        return yield* new ClassificationError({ message: 'Text configuration changed.' });
      if (!Number.isFinite(reply.sexual) || reply.sexual < 0 || reply.sexual > 1)
        return yield* new ClassificationError({ message: 'Invalid text scores.' });
      const scores = { sexualText: reply.sexual };
      if (
        ocr.errors.length === 0 &&
        settings.current.textProvider === provider &&
        settings.current.textConfigRevision === revision
      )
        yield* writeCache(key, scores);
      return scores;
    }),
  );
  if (current.enabled.aiGenerated && text)
    jobs.push(
      Effect.gen(function* () {
        const key = cacheKey({ task: 'aiText', text });
        const cached = yield* readCache(key);
        if (cached?.scores.aiGenerated !== undefined)
          return { aiGenerated: cached.scores.aiGenerated };
        const rawReply: unknown = yield* browserEffect('classify AI-written text locally', () =>
          browser.runtime.sendMessage({ type: 'classify-ai', text }),
        );
        const reply = yield* Schema.decodeUnknownEffect(InferenceReplySchema)(rawReply).pipe(
          Effect.mapError(
            () => new ClassificationError({ message: 'Invalid local AI-text response.' }),
          ),
        );
        if (!reply.ok) return yield* new ClassificationError({ message: reply.error });
        if (reply.scores.aiGenerated === undefined)
          return yield* new ClassificationError({
            message: 'Local AI-text model returned no score.',
          });
        const scores = { aiGenerated: reply.scores.aiGenerated };
        yield* writeCache(key, scores);
        return scores;
      }),
    );
  const outcomes = yield* Effect.forEach(jobs, (job) => Effect.result(job), {
    concurrency: 'unbounded',
  });
  if (
    settings.current.textProvider !== provider ||
    settings.current.textConfigRevision !== revision
  )
    return yield* new ClassificationError({ message: 'Text configuration changed.' });
  const scores: Partial<Record<CategoryKey, number>> = {};
  const errors: string[] = [...extractionErrors];
  for (const outcome of outcomes) {
    if (outcome._tag === 'Failure') errors.push(message(outcome.failure));
    else Object.assign(scores, outcome.success);
  }
  return { scores, errors };
});

// --- Image scores -----------------------------------------------------------

// Serialize image batches per page; the shared inference worker also serializes
// execution across tabs.
const imageInference = Semaphore.makeUnsafe(1);

export const imageScores = Effect.fnUntraced(function* (urls: string[]) {
  return yield* Semaphore.withPermit(imageInference, classifyImages(urls));
});

const classifyImages = Effect.fnUntraced(function* (
  urls: string[],
): Effect.fn.Return<
  { scores: Partial<Record<CategoryKey, number>>; errors: string[] },
  BrowserError | ClassificationError
> {
  const scores: Partial<Record<CategoryKey, number>> = {};
  const errors: string[] = [];
  const misses: Array<{ url: string; index: number }> = [];
  for (let index = 0; index < urls.length; index++) {
    const url = urls[index] ?? '';
    const cached = yield* readCache(cacheKey({ task: 'image', url }));
    if (cached) {
      for (const category of CATEGORY_KEYS) {
        const value = cached.scores[category];
        if (value !== undefined) scores[category] = Math.max(scores[category] ?? 0, value);
      }
    } else {
      misses.push({ url, index });
    }
  }
  if (!misses.length) return { scores, errors };
  for (const miss of misses) {
    const outcome = yield* browserEffect('classify image locally', () =>
      browser.runtime.sendMessage({ type: 'classify-image', url: miss.url }),
    ).pipe(
      Effect.flatMap((reply) => Schema.decodeUnknownEffect(InferenceReplySchema)(reply)),
      Effect.mapError((cause) => new ClassificationError({ message: message(cause) })),
      Effect.flatMap((reply) =>
        reply.ok
          ? Effect.succeed({ predictions: reply.scores, warning: reply.warning })
          : Effect.fail(new ClassificationError({ message: reply.error })),
      ),
      Effect.catch((error) => Effect.succeed({ error } as const)),
    );
    if ('error' in outcome) {
      errors.push(`Image ${miss.index + 1}: ${message(outcome.error)}`);
      continue;
    }
    const imageScores = outcome.predictions;
    for (const category of CATEGORY_KEYS) {
      const probability = imageScores[category];
      if (probability !== undefined)
        scores[category] = Math.max(scores[category] ?? 0, probability);
    }
    if (outcome.warning) {
      errors.push(`Image ${miss.index + 1}: ${outcome.warning}`);
      continue; // Preserve available scores, but retry the incomplete check instead of caching it.
    }
    yield* writeCache(cacheKey({ task: 'image', url: miss.url }), imageScores);
  }
  return { scores, errors };
});

export function message(error: unknown): string {
  if (error instanceof BrowserError) {
    const cause = error.cause;
    return cause instanceof Error ? cause.message : String(cause);
  }
  return error instanceof Error ? error.message : String(error);
}
