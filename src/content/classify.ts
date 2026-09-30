// Classification owns cache access, provider-revision checks, and cancellable
// text/image scoring. DOM and block policy stay in their dedicated modules.
import { Clock, Duration, Effect, Option, Semaphore } from 'effect';
import * as Schema from 'effect/Schema';
import { browser } from 'wxt/browser';
import { browserEffect, BrowserError } from '../shared/browser';
import { CATEGORY_KEYS, IMAGE_KEYS, STORAGE_KEYS, type CategoryKey } from '../shared/types';
import { CategoryKeySchema } from '../shared/schemas';
import { settings, type Post } from './state';
import { canonicalMediaUrl } from './dom';
import { loadImageClassifier } from './image-loader';
const JevReplySchema = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    sexual: Schema.Finite,
    ai: Schema.Finite,
    provider: Schema.String,
    revision: Schema.Finite,
  }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
]);

const ImageReplySchema = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), dataUrl: Schema.String }),
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
const CACHE_VERSION = 6;
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

// --- Text scores ------------------------------------------------------------

export const textScores = Effect.fnUntraced(function* (
  post: Post,
  text: string,
): Effect.fn.Return<Partial<Record<CategoryKey, number>>, BrowserError | ClassificationError> {
  const current = settings.current;
  const provider = current.textProvider;
  const revision = current.textConfigRevision;
  const key = `${CACHE_PREFIX}t:${provider}:${hash64(text)}`;
  const cached = yield* readCache(key);
  if (
    settings.current.textProvider !== provider ||
    settings.current.textConfigRevision !== revision
  )
    return yield* new ClassificationError({ message: 'Text configuration changed.' });
  if (cached) return cached.scores;
  if (!current.providerKeys[provider])
    return yield* new ClassificationError({
      message: 'Add an API key in the extension popup to check text.',
    });
  const rawReply: unknown = yield* browserEffect('classify text', () =>
    browser.runtime.sendMessage({
      type: 'jev',
      tweetId: post.id,
      text,
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
  if (
    reply.provider !== provider ||
    reply.revision !== revision ||
    settings.current.textProvider !== provider ||
    settings.current.textConfigRevision !== revision
  )
    return yield* new ClassificationError({ message: 'Text configuration changed.' });
  if (
    ![reply.sexual, reply.ai].every((score) => Number.isFinite(score) && score >= 0 && score <= 1)
  )
    return yield* new ClassificationError({ message: 'Invalid text scores' });
  const scores = { sexualText: reply.sexual, aiGenerated: reply.ai };
  yield* writeCache(key, scores);
  return scores;
});

// --- Image scores -----------------------------------------------------------

// TF models must not classify in parallel or memory blows up. Semaphore
// acquisition is interruptible, so queued scans disappear with their scope.
const imageInference = Semaphore.makeUnsafe(1);

export const imageScores = Effect.fnUntraced(function* (urls: string[]) {
  return yield* Semaphore.withPermit(imageInference, classifyImages(urls));
});

/**
 * NSFWJS model class names are singular ('Drawing') while our category key
 * is 'drawings'; map explicitly instead of matching the enum by accident.
 */
type NsfwClassName = 'drawing' | 'drawings' | 'hentai' | 'porn' | 'sexy';
const NsfwClassNameSchema = Schema.Literals(['drawing', 'drawings', 'hentai', 'porn', 'sexy']);
const isNsfwClassName = Schema.is(NsfwClassNameSchema);
const NSFW_CLASS_TO_CATEGORY: Record<NsfwClassName, CategoryKey> = {
  drawing: 'drawings',
  drawings: 'drawings',
  hentai: 'hentai',
  porn: 'porn',
  sexy: 'sexy',
};

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
    const cached = yield* readCache(`${CACHE_PREFIX}i:${hash64(canonicalMediaUrl(url))}`);
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
  const model = yield* loadImageClassifier();
  for (const miss of misses) {
    const outcome = yield* Effect.acquireUseRelease(
      fetchBitmap(miss.url),
      (bitmap) => model.classify(bitmap),
      (bitmap) => Effect.sync(() => bitmap.close()),
    ).pipe(
      Effect.map((predictions) => ({ predictions }) as const),
      Effect.catch((error) => Effect.succeed({ error } as const)),
    );
    if ('error' in outcome) {
      errors.push(`Image ${miss.index + 1}: ${message(outcome.error)}`);
      continue;
    }
    const imageScores: Partial<Record<CategoryKey, number>> = {};
    for (const prediction of outcome.predictions) {
      const className = prediction.className.toLowerCase().replace(/s$/, '');
      if (!isNsfwClassName(className)) continue;
      const category = NSFW_CLASS_TO_CATEGORY[className];
      if (IMAGE_KEYS.includes(category)) {
        imageScores[category] = Math.max(imageScores[category] ?? 0, prediction.probability);
        scores[category] = Math.max(scores[category] ?? 0, prediction.probability);
      }
    }
    yield* writeCache(`${CACHE_PREFIX}i:${hash64(canonicalMediaUrl(miss.url))}`, imageScores);
  }
  return { scores, errors };
});

function fetchBitmap(url: string): Effect.Effect<ImageBitmap, BrowserError | ClassificationError> {
  if (!url) return Effect.fail(new ClassificationError({ message: 'No image URL found.' }));
  const direct = Effect.gen(function* () {
    const response = yield* browserEffect('download image', (signal) =>
      fetch(url, {
        credentials: 'omit',
        signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
      }),
    );
    if (!response.ok) return yield* new ClassificationError({ message: `HTTP ${response.status}` });
    const blob = yield* browserEffect('read downloaded image', () => response.blob());
    return yield* browserEffect('decode image', () => createImageBitmap(blob));
  });
  const fallback = Effect.gen(function* () {
    const rawReply = yield* browserEffect('request image from background', () =>
      browser.runtime.sendMessage({ type: 'fetch-image', url }),
    ).pipe(Effect.timeoutOption(Duration.millis(10_000)));
    if (Option.isNone(rawReply))
      return yield* new ClassificationError({ message: 'Image download timed out.' });
    const reply = yield* Schema.decodeUnknownEffect(ImageReplySchema)(rawReply.value).pipe(
      Effect.mapError(
        () => new ClassificationError({ message: 'Invalid image download response.' }),
      ),
    );
    if (!reply.ok) return yield* new ClassificationError({ message: reply.error });
    const response = yield* browserEffect('read background image data', () => fetch(reply.dataUrl));
    const blob = yield* browserEffect('read background image body', () => response.blob());
    return yield* browserEffect('decode background image', () => createImageBitmap(blob));
  });
  return direct.pipe(Effect.catch(() => fallback));
}

export function message(error: unknown): string {
  if (error instanceof BrowserError) {
    const cause = error.cause;
    return cause instanceof Error ? cause.message : String(cause);
  }
  return error instanceof Error ? error.message : String(error);
}
