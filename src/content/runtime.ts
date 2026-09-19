// Content runtime lifecycle: boot, discovery, scan orchestration, stats,
// and teardown. All document/window listeners go through the
// ContentScriptContext so every trace of the script is removed on
// invalidation.
import { browser } from 'wxt/browser';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { loadSettings } from '../shared/settings';
import {
  IMAGE_KEYS,
  STORAGE_KEYS,
  TEXT_KEYS,
  type CategoryKey,
  type TabReport,
} from '../shared/types';
import { canRetry, cancelRetry, imageScores, MAX_RETRIES, message, textScores } from './classify';
import { readArticle, sameUrls } from './dom';
import {
  createBinding,
  injectGlobalStyle,
  installActivation,
  panelOpenFor,
  removeAllUI,
  render,
  renderAll,
  renderPost as renderPostUi,
  restoreAll,
} from './ui';
import { closePanelIfOpen } from './ui';
import {
  bindings,
  isAttached,
  newPost,
  overrides,
  posts,
  report,
  reviewMode,
  settings,
  type Post,
} from './state';

const overridePrefix = `${STORAGE_KEYS.overrides}:`;
/** Tracks what blocked count we last told the background for this tab. */
let lastBadgeBlocked = -1;
let observer: MutationObserver | null = null;
/** The live script context; scans and retry timers die with it. */
let activeCtx: ContentScriptContext | null = null;

export interface ContentHandle {
  /** Force a discovery pass; the observer batches mutations into this. */
  discover(): void;
  /** Current report for the visible posts. */
  report(): TabReport;
}

export async function startContentFilter(ctx: ContentScriptContext): Promise<ContentHandle> {
  reviewMode.current = new URLSearchParams(location.search).get('jev') === 'review';
  activeCtx = ctx;
  settings.current = await loadSettings();
  for (const [key, value] of Object.entries(await browser.storage.local.get(null))) {
    if (key.startsWith(overridePrefix) && value === 'allow')
      overrides.set(key.slice(overridePrefix.length), 'allow');
  }
  injectGlobalStyle();
  installActivation(ctx);
  const onMessage = (request: unknown) => {
    if ((request as { type?: string } | null)?.type === 'get-report')
      return Promise.resolve(report());
    return undefined;
  };
  browser.runtime.onMessage.addListener(onMessage);
  ctx.onInvalidated(() => browser.runtime.onMessage.removeListener(onMessage));

  const onStorageChanged = (
    changes: Record<string, { newValue?: unknown }>,
    area: string,
  ): void => {
    void handleStorageChanges(changes, area);
  };
  browser.storage.onChanged.addListener(onStorageChanged);
  ctx.onInvalidated(() => browser.storage.onChanged.removeListener(onStorageChanged));

  // Schedule one coalesced discovery pass per frame for X's DOM churn.
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    ctx.requestAnimationFrame(() => {
      scheduled = false;
      discover();
    });
  };
  // Only changes X can make: our own writes (hosts, panel, card link) are
  // filtered out in the record handler so the runtime never reschedules
  // itself.
  observer = new MutationObserver((mutations) => {
    if (!mutations.some((record) => !isOwnMutation(record))) return;
    schedule();
  });
  if (document.body) {
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['src', 'srcset', 'href'],
    });
  }
  ctx.onInvalidated(teardown);

  discover();
  sendStats();
  return {
    discover,
    report,
  };
}

// --- Storage reactions ------------------------------------------------------

async function handleStorageChanges(
  changes: Record<string, { newValue?: unknown }>,
  area: string,
): Promise<void> {
  if (area !== 'local') return;
  let changed = false;
  const previous = settings.current;
  if (changes[STORAGE_KEYS.settings]) {
    settings.current = await loadSettings();
    const current = settings.current;
    const resuming = !previous.masterEnabled && current.masterEnabled;
    const textConfigChanged =
      previous.gatewayKey !== current.gatewayKey || previous.textProvider !== current.textProvider;
    for (const post of posts.values()) {
      if (!current.masterEnabled || textConfigChanged) cancelRetry(post);
      if (textConfigChanged) {
        post.version++;
        post.textDone = false;
        post.previewDone = false;
        post.partErrors.text = [];
        post.partErrors.preview = [];
        post.retryCount = 0;
      }
      // Enabling a category must trigger the missing checks: a post scanned
      // while a category was off has no scores for it and stays done until
      // the part is reset here.
      if (TEXT_KEYS.some((key) => previous.enabled[key] !== current.enabled[key])) {
        post.textDone = false;
        post.previewDone = false;
        post.partErrors.text = [];
        post.partErrors.preview = [];
      }
      if (IMAGE_KEYS.some((key) => previous.enabled[key] !== current.enabled[key])) {
        post.imagesDone = false;
        post.previewDone = false;
        post.partErrors.images = [];
        post.partErrors.preview = [];
      }
      post.errors = Object.values(post.partErrors).flat();
      if (resuming) post.retryCount = 0;
    }
    changed = true;
  }
  for (const [key, change] of Object.entries(changes)) {
    if (!key.startsWith(overridePrefix)) continue;
    const id = key.slice(overridePrefix.length);
    if (change.newValue === 'allow') overrides.set(id, 'allow');
    else overrides.delete(id);
    changed = true;
  }
  if (!changed) return;
  if (!settings.current.masterEnabled) {
    // Pause: unhide everything before the render pass strips the UI.
    restoreAll();
    renderAll();
    sendStats();
    return;
  }
  renderAll();
  discover();
  for (const post of posts.values()) if (isAttached(post)) void scan(post);
  sendStats();
}

// --- Discovery --------------------------------------------------------------

/**
 * A mutation we caused ourselves: inserted/removed hosts, panel host, the
 * global style, or our link-preview placeholder (including its href write).
 * Reacting to these would reschedule discovery forever.
 */
function isOwnMutation(record: MutationRecord): boolean {
  if (record.target instanceof Element && record.target.hasAttribute('data-jev-card-link'))
    return true;
  for (const node of [...record.addedNodes, ...record.removedNodes]) {
    if (
      node instanceof Element &&
      (node.hasAttribute('data-jev-host') ||
        node.hasAttribute('data-jev-panel') ||
        node.hasAttribute('data-jev-style') ||
        node.hasAttribute('data-jev-card-link'))
    )
      return true;
  }
  return false;
}

function discover(): void {
  if (!activeCtx || activeCtx.isInvalid) return;
  for (const [article, binding] of bindings) {
    if (!article.isConnected) {
      binding.host.remove();
      bindings.delete(article);
      if (panelOpenFor(binding.post.id)) closePanelIfOpen();
    }
  }
  for (const article of document.querySelectorAll<HTMLElement>('article[data-testid="tweet"]')) {
    if (article.parentElement?.closest('article[data-testid="tweet"]')) continue;
    const content = readArticle(article);
    if (!content) continue;
    let post = posts.get(content.id);
    if (!post) {
      post = newPost(
        content.id,
        content.handle,
        content.text,
        content.urls,
        content.previewUrl,
        content.previewText,
      );
      posts.set(content.id, post);
    } else {
      const changed =
        post.text !== content.text ||
        !sameUrls(post.urls, content.urls) ||
        post.previewUrl !== content.previewUrl ||
        post.previewText !== content.previewText;
      if (changed) {
        cancelRetry(post);
        post.version++;
        post.retryCount = 0;
        if (post.text !== content.text) {
          post.text = content.text;
          post.textDone = false;
          post.partErrors.text = [];
          post.logged = false; // changed content is a new blocking decision
          for (const key of TEXT_KEYS) delete post.scores[key];
        }
        if (!sameUrls(post.urls, content.urls)) {
          post.urls = content.urls;
          post.imagesDone = false;
          post.partErrors.images = [];
          for (const key of IMAGE_KEYS) delete post.scores[key];
        }
        if (post.previewUrl !== content.previewUrl || post.previewText !== content.previewText) {
          post.previewUrl = content.previewUrl;
          post.previewText = content.previewText;
          post.previewDone = false;
          post.previewScores = {};
          post.partErrors.preview = [];
          post.previewLogged = false;
        }
        post.errors = Object.values(post.partErrors).flat();
      }
      if (!post.handle && content.handle) post.handle = content.handle;
    }
    if (content.author) post.author = content.author;
    let binding = bindings.get(article);
    if (!binding || binding.post !== post) {
      // X recycles article nodes for new tweets: rebuild the binding when
      // the node now shows a different post.
      binding?.host.remove();
      binding = createBinding(post);
      bindings.set(article, binding);
    }
    render(article, binding);
    void scan(post);
  }
  for (const post of posts.values()) if (!isAttached(post)) cancelRetry(post);
}

// --- Scan orchestration -----------------------------------------------------

async function scan(post: Post): Promise<void> {
  if (!activeCtx || activeCtx.isInvalid) return;
  if (!settings.current.masterEnabled) {
    restoreAll();
    return;
  }
  if (post.pending || post.retryTimer || !isAttached(post)) return;
  const textEnabled = TEXT_KEYS.some((key) => settings.current.enabled[key]);
  const imageEnabled = IMAGE_KEYS.some((key) => settings.current.enabled[key]);
  const textNeeded = !post.textDone && !!post.text && textEnabled;
  const imagesNeeded = !post.imagesDone && post.urls.length > 0 && imageEnabled;
  const previewNeeded =
    !post.previewDone &&
    ((!!post.previewUrl && imageEnabled) || (!!post.previewText && textEnabled));
  if (!textNeeded && !imagesNeeded && !previewNeeded) return;
  const version = post.version;
  const text = post.text,
    urls = post.urls,
    previewUrl = post.previewUrl,
    previewText = post.previewText;
  post.pending = true;
  post.retryAt = null;
  renderPost(post);
  const run = async (
    part: 'text' | 'images' | 'preview',
    work: () => Promise<{ scores: Partial<Record<CategoryKey, number>>; errors: string[] }>,
  ) => {
    let result;
    try {
      result = await work();
    } catch (error) {
      result = { scores: {}, errors: [message(error)] };
    }
    if (post.version !== version) return;
    post.partErrors[part] = result.errors.map(
      (error) =>
        `${part === 'text' ? 'Text' : part === 'images' ? 'Images' : 'Link preview'}: ${error}`,
    );
    if (part === 'preview') {
      post.previewScores = result.scores;
      post.previewDone = true;
    } else {
      for (const key of part === 'text' ? TEXT_KEYS : IMAGE_KEYS) delete post.scores[key];
      Object.assign(post.scores, result.scores);
      if (part === 'text') post.textDone = true;
      else post.imagesDone = true;
    }
  };
  const jobs: Promise<void>[] = [];
  if (textNeeded)
    jobs.push(run('text', async () => ({ scores: await textScores(post, text), errors: [] })));
  if (imagesNeeded) jobs.push(run('images', () => imageScores(urls)));
  if (previewNeeded)
    jobs.push(
      run('preview', async () => {
        const results = await Promise.allSettled([
          previewUrl && imageEnabled
            ? imageScores([previewUrl])
            : Promise.resolve({ scores: {}, errors: [] }),
          previewText && textEnabled
            ? textScores(post, previewText).then((scores) => ({ scores, errors: [] as string[] }))
            : Promise.resolve({ scores: {}, errors: [] }),
        ]);
        const scores: Partial<Record<CategoryKey, number>> = {},
          errors: string[] = [];
        for (const result of results) {
          if (result.status === 'fulfilled') {
            Object.assign(scores, result.value.scores);
            errors.push(...result.value.errors);
          } else errors.push(message(result.reason));
        }
        return { scores, errors };
      }),
    );
  await Promise.all(jobs);
  // Context died mid-scan: drop the result, don't touch DOM or background.
  if (!activeCtx || activeCtx.isInvalid) return;
  post.pending = false;
  if (post.version !== version) {
    void scan(post);
    return;
  }
  post.errors = Object.values(post.partErrors).flat();
  post.scannedAt = Date.now();
  for (const error of post.errors)
    if (!post.recorded.has(error)) {
      post.recorded.add(error);
      void browser.runtime
        .sendMessage({ type: 'log-error', message: error, tweetId: post.id, handle: post.handle })
        .catch(() => post.recorded.delete(error));
    }
  const retryParts = (['text', 'images', 'preview'] as const).filter((part) =>
    post.partErrors[part].some(canRetry),
  );
  if (
    retryParts.length &&
    settings.current.masterEnabled &&
    post.retryCount < MAX_RETRIES &&
    isAttached(post)
  ) {
    const delay = Math.min(4_000 * 2 ** Math.min(post.retryCount++, 4), 60_000);
    scheduleRetry(post, retryParts, delay);
  } else if (!post.errors.length) post.retryCount = 0;
  renderPost(post);
  sendStats();
}

function scheduleRetry(
  post: Post,
  parts: Array<'text' | 'images' | 'preview'>,
  delay: number,
): void {
  const pendingCtx = activeCtx;
  if (!pendingCtx || pendingCtx.isInvalid) return;
  post.retryAt = Date.now() + delay;
  post.retryTimer = pendingCtx.setTimeout(() => {
    post.retryTimer = undefined;
    post.retryAt = null;
    for (const part of parts) {
      if (part === 'text') post.textDone = false;
      else if (part === 'images') post.imagesDone = false;
      else post.previewDone = false;
    }
    void scan(post);
  }, delay);
}

function renderPost(post: Post): void {
  renderPostUi(post);
  void flushBadge();
}

// --- Stats ------------------------------------------------------------------

function sendStats(): void {
  void flushBadge();
}

function flushBadge(): Promise<void> {
  const blocked = report().blocked;
  if (blocked === lastBadgeBlocked) return Promise.resolve();
  lastBadgeBlocked = blocked;
  return browser.runtime.sendMessage({ type: 'tab-stats', blocked }).catch(() => {});
}

// --- Teardown ---------------------------------------------------------------

function teardown(): void {
  observer?.disconnect();
  observer = null;
  activeCtx = null;
  reviewMode.current = false;
  for (const post of posts.values()) cancelRetry(post);
  posts.clear();
  overrides.clear();
  lastBadgeBlocked = -1;
  removeAllUI();
}
