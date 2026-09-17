// Content script for x.com/twitter.com:
// - Watches the timeline/status page for tweet articles.
// - Hides articles until the Jev text verdict arrives (no flashing).
// - Blurs media until NSFWJS scans it (placeholder, no flashing).
// - Hard-hides a tweet when any category exceeds its threshold; logs it.
import { load as loadNsfwCore, type NSFWJS } from 'nsfwjs/core';
import { MobileNetV2Model } from 'nsfwjs/models/mobilenet_v2';
import * as tf from '@tensorflow/tfjs';
import { appendBlocked } from '../shared/log';
import { loadSettings } from '../shared/settings';
import {
  sliderToThreshold,
  type CategoryKey,
  type JevReply,
  type Settings,
} from '../shared/types';

interface TweetContext {
  article: HTMLElement;
  id: string | null;
  author: string;
  text: string;
  quotedText: string;
  media: HTMLImageElement[];
}

interface Verdict {
  reasons: Array<{ key: CategoryKey; score: number }>;
}

const processedArticles = new WeakSet<HTMLElement>();
const hiddenByTweetId = new Map<string, HTMLElement>();
const verdictCache = new Map<string, Verdict>();
const inflightJev = new Map<string, Promise<JevReply>>();

let settings: Settings;
let nsfwLoadPromise: Promise<NSFWJS> | null = null;

export default defineContentScript({
  matches: [
    'https://x.com/*',
    'https://twitter.com/*',
    // Local mock feed for manual smoke tests in development builds only.
    ...(import.meta.env.DEV ? ['http://127.0.0.1:8811/*'] : []),
  ],
  runAt: 'document_idle',
  main() {
    void main();
  },
});

async function main(): Promise<void> {
  settings = await loadSettings();
  if (!settings.masterEnabled) return;
  scanExisting();
  new MutationObserver(scanExisting).observe(document.body, {
    childList: true,
    subtree: true,
  });

  browser.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local' || !changes['settings']) return;
    settings = await loadSettings();
    if (!settings.masterEnabled) unhideAll();
  });
}

function unhideAll(): void {
  for (const article of hiddenByTweetId.values()) {
    article.style.removeProperty('display');
  }
  hiddenByTweetId.clear();
}

function scanExisting(): void {
  if (!settings.masterEnabled) return;
  for (const article of document.querySelectorAll<HTMLElement>('article[data-testid="tweet"]')) {
    if (processedArticles.has(article)) continue;
    processedArticles.add(article);
    void processArticle(article);
  }
}

function extract(article: HTMLElement): TweetContext | null {
  const timestampLink = article.querySelector<HTMLAnchorElement>('a[href*="/status/"]:has(time)');
  const selfHref =
    timestampLink?.getAttribute('href') ??
    article.querySelector<HTMLAnchorElement>('a[href*="/status/"]')?.getAttribute('href');
  const id = selfHref?.match(/\/status\/(\d+)/)?.[1] ?? null;

  const author =
    article.querySelector('[data-testid="User-Name"]')?.textContent?.trim() ?? '';
  const text =
    article.querySelector('[data-testid="tweetText"]')?.textContent?.trim() ?? '';

  // Nested quoted article: fold its text into the parent's Jev state; its
  // media is scanned with the parent's (nested articles are not queued).
  const nested = article.querySelector('article[data-testid="tweet"]');
  const quotedText =
    nested?.querySelector('[data-testid="tweetText"]')?.textContent?.trim() ?? '';

  const media = [
    ...article.querySelectorAll<HTMLImageElement>('img[src*="pbs.twimg.com/media"]'),
  ].filter((img) => img.width > 100 && img.height > 100);

  if (!id && !text) return null; // ads and skeleton rows
  return { article, id, author, text, quotedText, media };
}

async function processArticle(article: HTMLElement): Promise<void> {
  const ctx = extract(article);
  if (!ctx) return;

  const surface = location.pathname.includes('/status/')
    ? 'status/replies'
    : 'timeline';

  if (ctx.id) {
    const cached = verdictCache.get(ctx.id);
    if (cached) {
      applyVerdict(ctx, cached, surface);
      return;
    }
    // Gate visibility until Jev answers; media blurs independently.
    article.style.setProperty('display', 'none');
  }

  const verdict: Verdict = { reasons: [] };
  if (ctx.id) verdictCache.set(ctx.id, verdict);

  const jobs: Promise<void>[] = [];
  if (ctx.id) jobs.push(jevJob(ctx, verdict));
  if (ctx.media.length > 0) jobs.push(imagesJob(ctx, verdict));
  await Promise.allSettled(jobs);

  applyVerdict(ctx, verdict, surface);
}

async function jevJob(ctx: TweetContext, verdict: Verdict): Promise<void> {
  const tweetId = ctx.id as string;
  let inflight = inflightJev.get(tweetId);
  if (!inflight) {
    const text = [ctx.text, ctx.quotedText && `Quoted tweet: ${ctx.quotedText}`]
      .filter(Boolean)
      .join('\n\n');
    inflight = browser.runtime.sendMessage({
      type: 'jev',
      tweetId,
      author: ctx.author,
      text,
    }) as Promise<JevReply>;
    inflightJev.set(tweetId, inflight);
  }
  const reply = await inflight;
  if (reply.ok) {
    addThresholdHits(verdict, [
      { key: 'sexualText', score: reply.sexual },
      { key: 'aiGenerated', score: reply.ai },
    ]);
  }
  // !reply.ok → fail-open: no reason added, article becomes visible.
}

async function imagesJob(ctx: TweetContext, verdict: Verdict): Promise<void> {
  const model = await loadNsfw();
  await Promise.all(
    ctx.media.map(async (img) => {
      blurMedia(img);
      try {
        await imageLoaded(img);
        const bitmap = await bitmapFromElement(img);
        const pixels = tf.browser.fromPixels(bitmap, 3);
        const predictions = await model.classify(pixels);
        console.debug('[jev-filter] nsfw scores', ctx.id, Object.fromEntries(predictions.map((p) => [p.className, p.probability])));
        const scores = new Map(
          predictions.map((p) => [p.className.toLowerCase(), p.probability]),
        );
        addThresholdHits(verdict, [
          { key: 'porn', score: scores.get('porn') ?? 0 },
          { key: 'hentai', score: scores.get('hentai') ?? 0 },
          { key: 'sexy', score: scores.get('sexy') ?? 0 },
          { key: 'drawings', score: scores.get('drawings') ?? 0 },
        ]);
      } catch {
        // Scan failed for this image: lift the blur, keep the feed usable.
      } finally {
        unblurMedia(img);
      }
    }),
  );
}

async function bitmapFromElement(img: HTMLImageElement): Promise<ImageBitmap> {
  const url = img.currentSrc || img.src;
  try {
    // twimg images are cache-hot; a direct fetch usually succeeds.
    const response = await fetch(url, { credentials: 'omit' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await createImageBitmap(await response.blob());
  } catch {
    // CORS-blocked: proxy through the background (host permissions).
    const reply = (await browser.runtime.sendMessage({
      type: 'fetch-image',
      url,
    })) as { ok: boolean; dataUrl?: string; error?: string };
    if (!reply.ok || !reply.dataUrl) throw new Error(reply.error ?? 'image proxy failed');
    const proxied = await fetch(reply.dataUrl);
    return createImageBitmap(await proxied.blob());
  }
}

function imageLoaded(img: HTMLImageElement): Promise<void> {
  if (img.complete && img.naturalWidth > 0) return Promise.resolve();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  img.addEventListener('load', () => resolve(), { once: true });
  img.addEventListener(
    'error',
    () => reject(new Error('image failed to load')),
    { once: true },
  );
  return promise;
}

function loadNsfw(): Promise<NSFWJS> {
  if (!nsfwLoadPromise) {
    // Registering only MobileNetV2 keeps InceptionV3's 29MB of weights
    // out of the content-script bundle.
    nsfwLoadPromise = loadNsfwCore('MobileNetV2', {
      size: 224,
      modelDefinitions: [MobileNetV2Model],
    }).catch((error) => {
      nsfwLoadPromise = null;
      throw error;
    });
  }
  return nsfwLoadPromise;
}

function addThresholdHits(
  verdict: Verdict,
  candidates: Array<{ key: CategoryKey; score: number }>,
): void {
  for (const { key, score } of candidates) {
    if (score < sliderToThreshold(settings.sliders[key])) continue;
    if (!verdict.reasons.some((r) => r.key === key)) {
      verdict.reasons.push({ key, score });
    }
  }
}

function blurMedia(img: HTMLImageElement): void {
  img.style.setProperty('filter', 'blur(32px)');
}

function unblurMedia(img: HTMLImageElement): void {
  img.style.removeProperty('filter');
}

function applyVerdict(
  ctx: TweetContext,
  verdict: Verdict,
  surface: string,
): void {
  if (verdict.reasons.length > 0 && ctx.id) {
    ctx.article.style.setProperty('display', 'none');
    hiddenByTweetId.set(ctx.id, ctx.article);
    void appendBlocked({
      tweetId: ctx.id,
      author: ctx.author,
      snippet: (ctx.text || ctx.quotedText).slice(0, 140),
      surface,
      ts: Date.now(),
      reasons: verdict.reasons,
    });
    return;
  }
  ctx.article.style.removeProperty('display');
}
