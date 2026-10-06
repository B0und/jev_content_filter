// Content runtime lifecycle: discovery, scan orchestration, statistics, and
// teardown. The session Layer owns every scan and retry fiber.
import { Clock, Context, Duration, Effect, Fiber, Layer, ManagedRuntime, Scope } from 'effect';
import * as Schema from 'effect/Schema';
import { browser } from 'wxt/browser';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { browserEffect, type BrowserError } from '../platform/browser';
import { loadSettings } from '../filtering/settings';
import { MODEL_STATUS_KEY, ModelStatusesSchema } from '../inference/contracts';
import {
  IMAGE_KEYS,
  STORAGE_KEYS,
  TEXT_KEYS,
  type ScoreKey,
  type CategoryKey,
  type TabReport,
} from '../filtering/types';
import { canRetry, imageScores, MAX_RETRIES, message, textScores } from './classify';
import { readArticle, sameUrls } from './dom';
import {
  createBinding,
  injectGlobalStyle,
  installActivation,
  logEffects,
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
  clearBindingIndex,
  isAttached,
  newPost,
  overrides,
  posts,
  report,
  resetPageStats,
  settings,
  trackBinding,
  untrackBinding,
  type Post,
} from './state';

const overridePrefix = `${STORAGE_KEYS.overrides}:`;

const GetReportRequestSchema = Schema.Struct({ type: Schema.Literal('get-report') });
const MAX_DETACHED_POSTS = 200;
/** Tracks what blocked count we last told the background for this tab. */
let lastBadgeBlocked = -1;
let observer: MutationObserver | null = null;
/** The live script context; all callbacks become inert when it is invalidated. */
let activeCtx: ContentScriptContext | null = null;

type ScanPart = 'text' | 'images' | 'preview';
const SCAN_PART_LABELS: Record<ScanPart, string> = {
  text: 'Text',
  images: 'Images',
  preview: 'Link preview',
};
type Scores = Partial<Record<CategoryKey, number>>;
type PartResult = { scores: Scores; errors: string[] };
type Dispatch = (effect: Effect.Effect<void, BrowserError>) => void;

export interface ContentHandle {
  /** Force a discovery pass; the observer batches mutations into this. */
  discover(): void;
  /** Live scan statistics and cumulative totals for this page load. */
  report(): TabReport;
}

interface ContentSessionApi {
  initialize(dispatch: Dispatch): Effect.Effect<void, BrowserError>;
  readonly discover: Effect.Effect<void>;
  handleStorageChanges(
    changes: Record<string, { newValue?: unknown; oldValue?: unknown }>,
    area: string,
  ): Effect.Effect<void, BrowserError>;
}

class ContentSession extends Context.Service<ContentSession, ContentSessionApi>()(
  'jev/content/ContentSession',
) {
  static readonly layer = (ctx: ContentScriptContext) =>
    Layer.effect(
      ContentSession,
      Effect.gen(function* () {
        const scope: Scope.Scope = yield* Effect.scope;
        const retryFibers = new Map<Post, Fiber.Fiber<void, never>>();

        const reportStats = Effect.fnUntraced(function* () {
          const blocked = report().pageBlocked;
          if (blocked === lastBadgeBlocked) return;
          lastBadgeBlocked = blocked;
          yield* Effect.forkIn(
            browserEffect('send tab stats', () =>
              browser.runtime.sendMessage({ type: 'tab-stats', blocked }),
            ).pipe(Effect.catch(() => Effect.void)),
            scope,
          );
        });

        const renderPost = Effect.fnUntraced(function* (post: Post) {
          for (const logging of renderPostUi(post)) yield* Effect.forkIn(logging, scope);
          yield* reportStats();
        });

        const cancelRetry = Effect.fnUntraced(function* (post: Post) {
          const fiber = retryFibers.get(post);
          if (fiber) {
            retryFibers.delete(post);
            // Interrupt without delaying synchronous DOM discovery on the
            // retry fiber's finalizers.
            yield* Effect.forkIn(Fiber.interrupt(fiber), scope, { startImmediately: true });
          }
          post.retryAt = null;
          if (post.partErrors.text.length) post.textDone = false;
          if (post.partErrors.images.length) post.imagesDone = false;
          if (post.partErrors.preview.length) post.previewDone = false;
        });
        const detachBinding = Effect.fnUntraced(function* (article: HTMLElement) {
          const binding = untrackBinding(article);
          if (!binding) return;
          binding.host.remove();
          if (isAttached(binding.post)) return;
          yield* cancelRetry(binding.post);
          if (posts.get(binding.post.id) === binding.post) {
            posts.delete(binding.post.id);
            posts.set(binding.post.id, binding.post);
          }
          if (panelOpenFor(binding.post.id)) closePanelIfOpen();
        });

        const evictDetachedPosts = Effect.fnUntraced(function* () {
          let detachedCount = 0;
          for (const post of posts.values()) if (!isAttached(post)) detachedCount++;
          if (detachedCount <= MAX_DETACHED_POSTS) return;

          for (const [id, post] of posts) {
            if (detachedCount <= MAX_DETACHED_POSTS) break;
            if (isAttached(post)) continue;
            yield* cancelRetry(post);
            post.version++;
            post.pending = false;
            posts.delete(id);
            detachedCount--;
          }
        });

        let scan: (post: Post) => Effect.Effect<void>;
        const startScan = (post: Post): Effect.Effect<void> =>
          Effect.forkIn(scan(post), scope).pipe(Effect.asVoid);

        const scheduleRetry = (
          post: Post,
          parts: ReadonlyArray<ScanPart>,
          delay: number,
        ): Effect.Effect<void> =>
          Effect.gen(function* () {
            const previous = retryFibers.get(post);
            if (previous) {
              retryFibers.delete(post);
              yield* Effect.forkIn(Fiber.interrupt(previous), scope, { startImmediately: true });
            }
            post.retryAt = (yield* Clock.currentTimeMillis) + delay;
            let retryFiber: Fiber.Fiber<void, never> | undefined;
            const retry: Effect.Effect<void> = Effect.gen(function* () {
              yield* Effect.sleep(Duration.millis(delay));
              if (
                !retryFiber ||
                retryFibers.get(post) !== retryFiber ||
                activeCtx !== ctx ||
                ctx.isInvalid ||
                posts.get(post.id) !== post
              )
                return;
              retryFibers.delete(post);
              post.retryAt = null;
              for (const part of parts) {
                if (part === 'text') post.textDone = false;
                else if (part === 'images') post.imagesDone = false;
                else post.previewDone = false;
              }
              yield* startScan(post);
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  if (retryFiber && retryFibers.get(post) === retryFiber) retryFibers.delete(post);
                }),
              ),
            );
            retryFiber = yield* Effect.forkIn(retry, scope);
            retryFibers.set(post, retryFiber);
          });

        scan = (post: Post): Effect.Effect<void> =>
          Effect.gen(function* () {
            if (activeCtx !== ctx || ctx.isInvalid || posts.get(post.id) !== post) return;
            if (!settings.current.masterEnabled) {
              restoreAll();
              return;
            }
            if (post.pending || post.retryAt !== null || !isAttached(post)) return;
            const textEnabled =
              TEXT_KEYS.some((key) => settings.current.enabled[key]) ||
              settings.current.textFilters.some((filter) => filter.enabled);
            const imageEnabled = IMAGE_KEYS.some((key) => settings.current.enabled[key]);
            const textNeeded = !post.textDone && !!post.text && textEnabled;
            const imagesNeeded = !post.imagesDone && post.urls.length > 0 && imageEnabled;
            const previewNeeded =
              !post.previewDone &&
              ((!!post.previewUrl && imageEnabled) || (!!post.previewText && textEnabled));
            if (!textNeeded && !imagesNeeded && !previewNeeded) return;
            const version = post.version;
            const text = post.text;
            const urls = post.urls;
            const previewUrl = post.previewUrl;
            const previewText = post.previewText;
            post.pending = true;
            post.retryAt = null;
            yield* renderPost(post);

            const capture = <A>(effect: Effect.Effect<A, BrowserError | Error>) =>
              effect.pipe(
                Effect.map((value) => ({ value }) as const),
                Effect.catch((error) => Effect.succeed({ error } as const)),
              );
            const part = (name: ScanPart, work: Effect.Effect<PartResult, BrowserError | Error>) =>
              work.pipe(
                Effect.map((result) => ({ name, result }) as const),
                Effect.catch((error) =>
                  Effect.succeed({
                    name,
                    result: { scores: {}, errors: [message(error)] },
                  } as const),
                ),
                Effect.tap(({ result }) =>
                  Effect.sync(() => {
                    if (
                      activeCtx !== ctx ||
                      ctx.isInvalid ||
                      posts.get(post.id) !== post ||
                      post.version !== version
                    )
                      return;
                    post.partErrors[name] = result.errors.map(
                      (error) => `${SCAN_PART_LABELS[name]}: ${error}`,
                    );
                    if (name === 'preview') {
                      post.previewScores = result.scores;
                      post.previewDone = true;
                    } else {
                      for (const key of name === 'text' ? textScoreKeys(post) : IMAGE_KEYS)
                        delete post.scores[key];
                      Object.assign(post.scores, result.scores);
                      if (name === 'text') post.textDone = true;
                      else post.imagesDone = true;
                    }
                  }),
                ),
              );

            const jobs: Array<Effect.Effect<unknown>> = [];
            if (textNeeded) jobs.push(part('text', textScores(post, text)));
            if (imagesNeeded) jobs.push(part('images', imageScores(urls)));
            if (previewNeeded) {
              const previewImage =
                previewUrl && imageEnabled
                  ? capture(imageScores([previewUrl]))
                  : Effect.succeed({ value: { scores: {}, errors: [] } } as const);
              const previewTextResult =
                previewText && textEnabled
                  ? capture(textScores(post, previewText))
                  : Effect.succeed({ value: { scores: {}, errors: [] } } as const);
              const previewWork = Effect.gen(function* () {
                const [image, textResult] = yield* Effect.all([previewImage, previewTextResult], {
                  concurrency: 'unbounded',
                });
                const scores: Scores = {};
                const errors: string[] = [];
                for (const result of [image, textResult]) {
                  if ('error' in result) errors.push(message(result.error));
                  else {
                    Object.assign(scores, result.value.scores);
                    errors.push(...result.value.errors);
                  }
                }
                return { scores, errors };
              });
              jobs.push(part('preview', previewWork));
            }
            yield* Effect.all(jobs, { concurrency: 'unbounded' });
            if (activeCtx !== ctx || ctx.isInvalid || posts.get(post.id) !== post) return;
            post.pending = false;
            if (post.version !== version) {
              yield* startScan(post);
              return;
            }
            post.errors = Object.values(post.partErrors).flat();
            post.scannedAt = yield* Clock.currentTimeMillis;
            for (const error of post.errors) {
              if (post.recorded.has(error)) continue;
              post.recorded.add(error);
              yield* Effect.forkIn(
                browserEffect('log scan error', () =>
                  browser.runtime.sendMessage({
                    type: 'log-error',
                    message: error,
                    tweetId: post.id,
                    handle: post.handle,
                  }),
                ).pipe(
                  Effect.catch(() => Effect.sync(() => post.recorded.delete(error))),
                  Effect.asVoid,
                ),
                scope,
              );
            }
            const retryParts = (['text', 'images', 'preview'] as const).filter((name) =>
              post.partErrors[name].some(canRetry),
            );
            if (
              retryParts.length &&
              settings.current.masterEnabled &&
              post.retryCount < MAX_RETRIES &&
              isAttached(post)
            ) {
              const delay = Math.min(4_000 * 2 ** Math.min(post.retryCount++, 4), 60_000);
              yield* scheduleRetry(post, retryParts, delay);
            } else if (!post.errors.length) post.retryCount = 0;
            yield* renderPost(post);
            yield* reportStats();
          });

        const discover = Effect.fnUntraced(function* () {
          if (activeCtx !== ctx || ctx.isInvalid) return;
          let bindingsChanged = false;
          for (const [article] of bindings) {
            if (!article.isConnected) {
              yield* detachBinding(article);
              bindingsChanged = true;
            }
          }
          for (const article of document.querySelectorAll<HTMLElement>(
            'article[data-testid="tweet"]',
          )) {
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
                yield* cancelRetry(post);
                post.version++;
                post.retryCount = 0;
                if (post.text !== content.text) {
                  post.text = content.text;
                  post.textDone = false;
                  post.partErrors.text = [];
                  post.logged = false;
                  for (const key of textScoreKeys(post)) delete post.scores[key];
                }
                if (!sameUrls(post.urls, content.urls)) {
                  post.urls = content.urls;
                  post.imagesDone = false;
                  post.partErrors.images = [];
                  for (const key of IMAGE_KEYS) delete post.scores[key];
                }
                if (
                  post.previewUrl !== content.previewUrl ||
                  post.previewText !== content.previewText
                ) {
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
            if (binding && binding.post !== post) {
              // X recycles article nodes for new tweets: release the old post first.
              yield* detachBinding(article);
              binding = undefined;
              bindingsChanged = true;
            }
            if (!binding) {
              binding = createBinding(post);
              trackBinding(article, binding);
              bindingsChanged = true;
            }
            render(article, binding);
            // Visibility can flip without a scan, so blocked content is
            // reported here too, not only when a scan finishes.
            for (const logging of logEffects(post)) yield* Effect.forkIn(logging, scope);
            yield* startScan(post);
          }
          yield* evictDetachedPosts();
          if (bindingsChanged) yield* reportStats();
        });

        const handleStorageChanges: ContentSessionApi['handleStorageChanges'] = (changes, area) =>
          Effect.gen(function* () {
            if (area !== 'local') return;
            let changed = false;
            const previous = settings.current;
            if (changes[STORAGE_KEYS.settings]) {
              settings.current = yield* loadSettings();
              const current = settings.current;
              const resuming = !previous.masterEnabled && current.masterEnabled;
              const textConfigChanged =
                previous.textConfigRevision !== current.textConfigRevision ||
                previous.textProvider !== current.textProvider ||
                previous.providerKeys[previous.textProvider] !==
                  current.providerKeys[current.textProvider];
              for (const post of posts.values()) {
                if (!current.masterEnabled || textConfigChanged) yield* cancelRetry(post);
                if (textConfigChanged) {
                  post.version++;
                  post.textDone = false;
                  post.previewDone = false;
                  post.partErrors.text = [];
                  post.partErrors.preview = [];
                  post.retryCount = 0;
                  for (const key of [
                    ...TEXT_KEYS,
                    ...previous.textFilters.map((filter) => `custom:${filter.id}` as const),
                  ]) {
                    delete post.scores[key];
                    delete post.previewScores[key];
                  }
                }
                // Enabling a category triggers checks skipped while it was off.
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
            const modelChange = changes[MODEL_STATUS_KEY];
            if (modelChange && Schema.is(ModelStatusesSchema)(modelChange.newValue)) {
              const current = modelChange.newValue;
              const before = Schema.is(ModelStatusesSchema)(modelChange.oldValue)
                ? modelChange.oldValue
                : undefined;
              const aiReady = current.aiText.state === 'ready' && before?.aiText.state !== 'ready';
              const imageReady = current.image.state === 'ready' && before?.image.state !== 'ready';
              const aiEnabled = settings.current.enabled.aiGenerated;
              const imageEnabled = IMAGE_KEYS.some((key) => settings.current.enabled[key]);
              if (aiReady || imageReady) {
                for (const post of posts.values()) {
                  if (post.pending) continue;
                  const retryText =
                    aiReady &&
                    aiEnabled &&
                    post.partErrors.text.length > 0 &&
                    post.scores.aiGenerated === undefined;
                  const retryImages =
                    imageReady && imageEnabled && post.partErrors.images.length > 0;
                  const retryPreview =
                    post.partErrors.preview.length > 0 &&
                    ((aiReady &&
                      aiEnabled &&
                      Boolean(post.previewText) &&
                      post.previewScores.aiGenerated === undefined) ||
                      (imageReady && imageEnabled && Boolean(post.previewUrl)));
                  if (!retryText && !retryImages && !retryPreview) continue;
                  yield* cancelRetry(post);
                  post.version++;
                  post.retryCount = 0;
                  if (retryText) {
                    post.textDone = false;
                    post.partErrors.text = [];
                  }
                  if (retryImages) {
                    post.imagesDone = false;
                    post.partErrors.images = [];
                  }
                  if (retryPreview) {
                    post.previewDone = false;
                    post.partErrors.preview = [];
                  }
                  post.errors = Object.values(post.partErrors).flat();
                  changed = true;
                }
              }
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
              // Pause: unhide before the render pass strips the UI.
              restoreAll();
              renderAll();
              yield* reportStats();
              return;
            }
            renderAll();
            yield* discover();
            for (const post of posts.values()) if (isAttached(post)) yield* startScan(post);
            yield* reportStats();
          });

        const initialize: ContentSessionApi['initialize'] = (dispatch) =>
          Effect.gen(function* () {
            settings.current = yield* loadSettings();
            const stored = yield* browserEffect('load post overrides', () =>
              browser.storage.local.get(null),
            );
            for (const [key, value] of Object.entries(stored)) {
              if (key.startsWith(overridePrefix) && value === 'allow')
                overrides.set(key.slice(overridePrefix.length), 'allow');
            }
            injectGlobalStyle();
            installActivation(ctx);

            const onMessage = (request: unknown) => {
              if (Schema.is(GetReportRequestSchema)(request)) return Promise.resolve(report());
              return undefined;
            };
            yield* Effect.sync(() => browser.runtime.onMessage.addListener(onMessage));
            yield* Scope.addFinalizer(
              scope,
              Effect.sync(() => browser.runtime.onMessage.removeListener(onMessage)),
            );

            const onStorageChanged = (
              changes: Record<string, { newValue?: unknown; oldValue?: unknown }>,
              area: string,
            ) => {
              dispatch(handleStorageChanges(changes, area));
            };
            yield* Effect.sync(() => browser.storage.onChanged.addListener(onStorageChanged));
            yield* Scope.addFinalizer(
              scope,
              Effect.sync(() => browser.storage.onChanged.removeListener(onStorageChanged)),
            );

            let scheduled = false;
            const schedule = () => {
              if (activeCtx !== ctx || ctx.isInvalid || scheduled) return;
              scheduled = true;
              ctx.requestAnimationFrame(() => {
                scheduled = false;
                if (activeCtx === ctx && !ctx.isInvalid)
                  dispatch(discover().pipe(Effect.andThen(reportStats())));
              });
            };
            const navigation = window.navigation;
            navigation?.addEventListener('currententrychange', schedule);
            const removeNavigationListener = () =>
              navigation?.removeEventListener('currententrychange', schedule);
            yield* Scope.addFinalizer(scope, Effect.sync(removeNavigationListener));
            ctx.onInvalidated(removeNavigationListener);
            const currentObserver = yield* Effect.sync(() => {
              const current = new MutationObserver((mutations) => {
                if (activeCtx !== ctx || ctx.isInvalid) return;
                if (!mutations.some((record) => !isOwnMutation(record))) return;
                schedule();
              });
              observer?.disconnect();
              observer = current;
              if (document.body) {
                current.observe(document.body, {
                  childList: true,
                  subtree: true,
                  characterData: true,
                  attributes: true,
                  attributeFilter: ['src', 'srcset', 'href', 'poster'],
                });
              }
              return current;
            });
            yield* Scope.addFinalizer(
              scope,
              Effect.sync(() => {
                currentObserver.disconnect();
                if (observer === currentObserver) observer = null;
              }),
            );
            ctx.onInvalidated(() => {
              browser.runtime.onMessage.removeListener(onMessage);
              browser.storage.onChanged.removeListener(onStorageChanged);
              currentObserver.disconnect();
              if (observer === currentObserver) observer = null;
            });
            yield* discover();
            yield* reportStats();
          });

        return ContentSession.of({ initialize, discover: discover(), handleStorageChanges });
      }),
    );
}

export async function startContentFilter(ctx: ContentScriptContext): Promise<ContentHandle> {
  activeCtx = ctx;
  const contentRuntime = ManagedRuntime.make(ContentSession.layer(ctx));
  const dispose = () => {
    void contentRuntime.dispose().catch((error: unknown) => {
      console.error('Content runtime disposal failed', error);
    });
  };
  ctx.onInvalidated(() => {
    teardown(ctx);
    dispose();
  });

  try {
    const session = await contentRuntime.runPromise(ContentSession);
    const dispatch: Dispatch = (effect) => {
      void contentRuntime.runPromise(effect).catch((error: unknown) => {
        if (!ctx.isInvalid) console.error('Content runtime effect failed', error);
      });
    };
    await contentRuntime.runPromise(session.initialize(dispatch));
    return {
      discover() {
        if (activeCtx === ctx && !ctx.isInvalid) contentRuntime.runSync(session.discover);
      },
      report,
    };
  } catch (error) {
    if (ctx.isInvalid) return { discover() {}, report };
    teardown(ctx);
    dispose();
    throw error;
  }
}

// --- Discovery helpers ------------------------------------------------------

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

// --- Teardown ---------------------------------------------------------------

function teardown(ctx: ContentScriptContext): void {
  if (activeCtx !== ctx) return;
  observer?.disconnect();
  observer = null;
  activeCtx = null;
  posts.clear();
  resetPageStats();
  overrides.clear();
  lastBadgeBlocked = -1;
  removeAllUI();
  clearBindingIndex();
}

/** Include retained custom scores, even if their rules have since been deleted. */
function textScoreKeys(post: Post): ScoreKey[] {
  return [
    ...TEXT_KEYS,
    ...Object.keys(post.scores).filter((key): key is `custom:${string}` =>
      key.startsWith('custom:'),
    ),
  ];
}
