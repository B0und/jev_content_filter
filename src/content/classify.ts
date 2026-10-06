// Classification owns cache access, provider-revision checks, and cancellable
// text/image scoring. DOM and block policy stay in their dedicated modules.
import { Clock, Effect, Semaphore } from 'effect';
import * as Schema from 'effect/Schema';
import { browser } from 'wxt/browser';
import { browserEffect, BrowserError } from '../platform/browser';
import { CATEGORY_KEYS, STORAGE_KEYS, type ScoreKey } from '../filtering/types';
import { ScoreKeySchema } from '../filtering/schemas';
import { settings, type Post } from './state';
import { canonicalMediaUrl } from './dom';
import { InferenceReplySchema } from '../inference/contracts';
import { IMAGE_PIPELINE_REVISION, SELECTED_MODELS } from '../inference/model-catalog';
const JevReplySchema = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    sexual: Schema.Finite,
    custom: Schema.optionalKey(Schema.Record(Schema.String, Schema.Finite)),
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
const CachedScoresSchema = Schema.Record(Schema.String, CachedProbabilitySchema);
const CachedScoreEntrySchema = Schema.Struct({
  scores: CachedScoresSchema,
  ts: Schema.Finite,
});
const CachedTimestampEntrySchema = Schema.Struct({ ts: Schema.Finite });
const isCachedScoreEntry = Schema.is(CachedScoreEntrySchema);
const isCachedTimestampEntry = Schema.is(CachedTimestampEntrySchema);
const isCategoryKey = Schema.is(ScoreKeySchema);
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
  scores: Partial<Record<ScoreKey, number>>,
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

// --- Text scores ------------------------------------------------------------

export const textScores = Effect.fnUntraced(function* (
  post: Post,
  text: string,
): Effect.fn.Return<
  { scores: Partial<Record<ScoreKey, number>>; errors: string[] },
  BrowserError | ClassificationError
> {
  const current = settings.current;
  const provider = current.textProvider;
  const revision = current.textConfigRevision;
  const jobs: Array<
    Effect.Effect<Partial<Record<ScoreKey, number>>, BrowserError | ClassificationError>
  > = [];
  if (current.enabled.sexualText || current.textFilters.some((filter) => filter.enabled))
    jobs.push(
      Effect.gen(function* () {
        const key = `${CACHE_PREFIX}t:${provider}:${hash64(JSON.stringify(current.textFilters))}:${hash64(text)}`;
        const cached = yield* readCache(key);
        if (
          cached?.scores.sexualText !== undefined &&
          current.textFilters
            .filter((filter) => filter.enabled)
            .every((filter) => cached.scores[`custom:${filter.id}`] !== undefined)
        )
          return cached.scores;
        if (!current.providerKeys[provider])
          return yield* new ClassificationError({
            message:
              'Add an API key in the Text tab to check Jev text filters. Local AI-written-text detection does not need a key.',
          });
        const rawReply: unknown = yield* browserEffect('classify sexual text', () =>
          browser.runtime.sendMessage({ type: 'jev', tweetId: post.id, text, provider, revision }),
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
        const scores: Partial<Record<ScoreKey, number>> = { sexualText: reply.sexual };
        for (const filter of current.textFilters.filter((item) => item.enabled)) {
          const score = reply.custom?.[filter.id];
          if (score === undefined || !Number.isFinite(score) || score < 0 || score > 1)
            return yield* new ClassificationError({
              message: 'Invalid custom text filter scores.',
            });
          scores[`custom:${filter.id}`] = score;
        }
        if (
          settings.current.textProvider === provider &&
          settings.current.textConfigRevision === revision
        )
          yield* writeCache(key, scores);
        return scores;
      }),
    );
  if (current.enabled.aiGenerated)
    jobs.push(
      Effect.gen(function* () {
        const descriptor = SELECTED_MODELS.aiText;
        const key = `${CACHE_PREFIX}a:${descriptor.id}:${descriptor.revision}:${hash64(text)}`;
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
  const scores: Partial<Record<ScoreKey, number>> = {};
  const errors: string[] = [];
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
  { scores: Partial<Record<ScoreKey, number>>; errors: string[] },
  BrowserError | ClassificationError
> {
  const scores: Partial<Record<ScoreKey, number>> = {};
  const errors: string[] = [];
  const misses: Array<{ url: string; index: number }> = [];
  for (let index = 0; index < urls.length; index++) {
    const url = urls[index] ?? '';
    const cached = yield* readCache(
      `${CACHE_PREFIX}i:${IMAGE_PIPELINE_REVISION}:${hash64(canonicalMediaUrl(url))}`,
    );
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
    yield* writeCache(
      `${CACHE_PREFIX}i:${IMAGE_PIPELINE_REVISION}:${hash64(canonicalMediaUrl(miss.url))}`,
      imageScores,
    );
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
