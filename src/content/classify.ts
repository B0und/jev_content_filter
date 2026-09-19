// Classification: persistent score cache, Jev text scores, local NSFWJS
// image inference, and the retry policy. External compute (the Jev gateway
// via background messages, and the bundled NSFWJS model) lives behind these
// functions only.
import { load as loadNsfwCore, type NSFWJS } from 'nsfwjs/core';
import { MobileNetV2Model } from 'nsfwjs/models/mobilenet_v2';
import * as tf from '@tensorflow/tfjs';
import { browser } from 'wxt/browser';
import {
  CATEGORY_KEYS,
  IMAGE_KEYS,
  STORAGE_KEYS,
  type CategoryKey,
  type ImageReply,
  type JevReply,
} from '../shared/types';
import { settings, type Post } from './state';
import { canonicalMediaUrl } from './dom';

// --- Persistent score cache -------------------------------------------------

/**
 * Bump when cache shape/read rules change so stale entries are ignored by
 * construction (keys carry the version).
 */
const CACHE_VERSION = 5;
const CACHE_PREFIX = `${STORAGE_KEYS.scores}:v${CACHE_VERSION}:`;
/** Legacy prefixes are only ever evicted, never read. */
const ALL_CACHE_PREFIX = `${STORAGE_KEYS.scores}:`;
const CACHE_LIMIT = 4000;
let cacheWrites = 0;

interface CachedScores {
  scores: Partial<Record<CategoryKey, number>>;
  ts: number;
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

/**
 * Scores are valid only when every value is a finite probability under a
 * known category. Anything else is treated as a miss and overwritten by the
 * next write.
 */
function validScores(scores: unknown): scores is Partial<Record<CategoryKey, number>> {
  if (typeof scores !== 'object' || scores === null) return false;
  const entries = Object.entries(scores as Record<string, unknown>);
  return (
    entries.length > 0 &&
    entries.every(
      ([key, value]) =>
        (CATEGORY_KEYS as string[]).includes(key) &&
        typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= 0 &&
        value <= 1,
    )
  );
}

export async function readCache(key: string): Promise<CachedScores | null> {
  // Older cache versions are never read, only evicted.
  if (!key.startsWith(CACHE_PREFIX)) return null;
  try {
    const stored = await browser.storage.local.get(key);
    const value = stored[key] as CachedScores | undefined;
    if (value === undefined || typeof value.ts !== 'number' || !validScores(value.scores))
      return null;
    return value;
  } catch {
    return null;
  }
}

export function writeCache(key: string, scores: Partial<Record<CategoryKey, number>>): void {
  cacheWrites += 1;
  void browser.storage.local.set({ [key]: { scores, ts: Date.now() } }).catch(() => {});
  if (cacheWrites % 250 === 0) void evictCache();
}

export async function evictCache(): Promise<void> {
  try {
    const all = await browser.storage.local.get(null);
    const entries = Object.entries(all).filter(([key]) => key.startsWith(ALL_CACHE_PREFIX));
    if (entries.length <= CACHE_LIMIT) return;
    // Keep the newest entries; drop the rest.
    const dropKeys = entries
      .sort((a, b) => ((b[1] as CachedScores)?.ts ?? 0) - ((a[1] as CachedScores)?.ts ?? 0))
      .slice(CACHE_LIMIT)
      .map(([key]) => key);
    await browser.storage.local.remove(dropKeys);
  } catch {
    /* cache is best-effort */
  }
}

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

export function cancelRetry(post: Post): void {
  clearTimeout(post.retryTimer);
  post.retryTimer = undefined;
  post.retryAt = null;
  if (post.partErrors.text.length) post.textDone = false;
  if (post.partErrors.images.length) post.imagesDone = false;
  if (post.partErrors.preview.length) post.previewDone = false;
}

// --- Text scores ------------------------------------------------------------

export async function textScores(
  post: Post,
  text: string,
): Promise<Partial<Record<CategoryKey, number>>> {
  // Provider changes must not reuse scores produced by a different API.
  const key = `${CACHE_PREFIX}t:${settings.current.textProvider}:${hash64(text)}`;
  const cached = await readCache(key);
  if (cached) return cached.scores;
  if (!settings.current.gatewayKey)
    throw new Error('Add an API key in the extension popup to check text.');
  const reply = (await browser.runtime.sendMessage({
    type: 'jev',
    tweetId: post.id,
    text,
  })) as JevReply;
  if (!reply.ok) throw new Error(reply.error);
  if (
    ![reply.sexual, reply.ai].every((score) => Number.isFinite(score) && score >= 0 && score <= 1)
  )
    throw new Error('Invalid text scores');
  const scores = { sexualText: reply.sexual, aiGenerated: reply.ai };
  writeCache(key, scores);
  return scores;
}

// --- Image scores -----------------------------------------------------------

// Serialize all local image inference; TF models must not classify in
// parallel or memory blows up.
let imageQueue: Promise<unknown> = Promise.resolve();

export function imageScores(urls: string[]) {
  const work = imageQueue.then(() => classifyImages(urls));
  imageQueue = work.catch(() => {});
  return work;
}

/**
 * NSFWJS model class names are singular ('Drawing') while our category key
 * is 'drawings'; map explicitly instead of matching the enum by accident.
 */
const NSFW_CLASS_TO_CATEGORY: Record<string, CategoryKey> = {
  drawing: 'drawings',
  drawings: 'drawings',
  hentai: 'hentai',
  porn: 'porn',
  sexy: 'sexy',
};

async function classifyImages(
  urls: string[],
): Promise<{ scores: Partial<Record<CategoryKey, number>>; errors: string[] }> {
  const scores: Partial<Record<CategoryKey, number>> = {};
  const errors: string[] = [];
  const misses: Array<{ url: string; index: number }> = [];
  for (let index = 0; index < urls.length; index++) {
    const cached = await readCache(
      `${CACHE_PREFIX}i:${hash64(canonicalMediaUrl(urls[index] ?? ''))}`,
    );
    if (cached) {
      for (const [key, value] of Object.entries(cached.scores)) {
        const category = key as CategoryKey;
        scores[category] = Math.max(scores[category] ?? 0, value);
      }
    } else {
      misses.push({ url: urls[index] ?? '', index });
    }
  }
  if (!misses.length) return { scores, errors };
  const model = await loadModel();
  for (const miss of misses) {
    let bitmap: ImageBitmap | undefined;
    let pixels: tf.Tensor3D | undefined;
    try {
      bitmap = await fetchBitmap(miss.url);
      pixels = tf.browser.fromPixels(bitmap, 3);
      const predictions = await model.classify(pixels);
      const imageScores: Partial<Record<CategoryKey, number>> = {};
      for (const prediction of predictions) {
        const category =
          NSFW_CLASS_TO_CATEGORY[prediction.className.toLowerCase().replace(/s$/, '')];
        if (category && IMAGE_KEYS.includes(category)) {
          imageScores[category] = Math.max(imageScores[category] ?? 0, prediction.probability);
          scores[category] = Math.max(scores[category] ?? 0, prediction.probability);
        }
      }
      writeCache(`${CACHE_PREFIX}i:${hash64(canonicalMediaUrl(miss.url))}`, imageScores);
    } catch (error) {
      errors.push(`Image ${miss.index + 1}: ${message(error)}`);
    } finally {
      pixels?.dispose();
      bitmap?.close();
    }
  }
  return { scores, errors };
}

async function fetchBitmap(url: string): Promise<ImageBitmap> {
  if (!url) throw new Error('No image URL found.');
  try {
    const response = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await createImageBitmap(await response.blob());
  } catch {
    const reply = await timeout(
      browser.runtime.sendMessage({ type: 'fetch-image', url }) as Promise<ImageReply>,
      10000,
      'Image download',
    );
    if (!reply.ok) throw new Error(reply.error);
    return createImageBitmap(await (await fetch(reply.dataUrl)).blob());
  }
}

function loadModel(): Promise<NSFWJS> {
  if (!modelPromise)
    modelPromise = loadNsfwCore('MobileNetV2', {
      size: 224,
      modelDefinitions: [MobileNetV2Model],
    }).catch((error) => {
      modelPromise = null;
      throw error;
    });
  return modelPromise;
}
let modelPromise: Promise<NSFWJS> | null = null;

function timeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  const { promise: timed, resolve, reject } = Promise.withResolvers<T>();
  const timer = setTimeout(() => reject(new Error(`${label} timed out.`)), ms);
  promise.then(resolve, reject).finally(() => clearTimeout(timer));
  return timed;
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
