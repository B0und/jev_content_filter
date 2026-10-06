import { Clock, Context, Deferred, Effect, Layer, Option, Queue, Ref, Semaphore } from 'effect';
import * as Schema from 'effect/Schema';
import { browser } from 'wxt/browser';
import { BrowserError, browserEffect } from '../platform/browser';
import { appendBlocked, appendScanError, clearLog, clearScanErrors } from '../history/log';
import { applySettingsChange, loadSettings, loadStatus, saveStatus } from '../filtering/settings';
import {
  STORAGE_KEYS,
  formatCount,
  type BgRequest,
  type FilterStatus,
  type JevReply,
  type Settings,
  type SettingsChange,
  type TextProvider,
} from '../filtering/types';
import { evaluateText, type TextScores } from './text-provider';
import { runLocalInference, warmLocalModels } from './local-inference';
import { MODEL_STATUS_KEY, initialModelStatuses, type ModelKind } from '../inference/contracts';

const QUEUE_CONCURRENCY = 3;
// The admission semaphore bounds all work to three active plus 64 waiting.
const MAX_WAITING = 64;
const TAB_COUNT_PREFIX = 'jevTabBlocked:';
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const BTOA_CHUNK = 0x8000;
const IMAGE_FETCH_TIMEOUT_MS = 10_000;
export interface MessageSender {
  tab?: { id?: number | undefined } | undefined;
  id?: string | undefined;
  url?: string | undefined;
}

interface ClassificationJob {
  request: Extract<BgRequest, { type: 'jev' }>;
  reply: Deferred.Deferred<JevReply, BrowserError>;
}

interface BackgroundWorkerApi {
  initialize: Effect.Effect<void, BrowserError>;
  handleRequest: (
    request: BgRequest,
    sender: MessageSender,
  ) => Effect.Effect<unknown, BrowserError>;
  settingsChanged: Effect.Effect<void, BrowserError>;
  tabRemoved: (tabId: number) => Effect.Effect<void, BrowserError>;
  tabNavigated: (tabId: number) => Effect.Effect<void, BrowserError>;
}

class ImageProxyError extends Schema.TaggedError<ImageProxyError>()('ImageProxyError', {
  message: Schema.String,
}) {}
function isAllowedImageUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') {
    return parsed.hostname === 'pbs.twimg.com' || parsed.hostname === 'video.twimg.com';
  }
  // Dev-only fixture server (mock/ mirrors the twimg path layout).
  if (import.meta.env.DEV && parsed.protocol === 'http:') {
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  }
  return false;
}

function badgeTextFor(count: number, settings: Settings | null): string {
  return !settings?.masterEnabled || count <= 0 ? '' : formatCount(count);
}

function isStaleSettings(
  settings: Settings | null,
  provider: TextProvider,
  revision: number,
): boolean {
  return (
    settings === null ||
    settings.textProvider !== provider ||
    settings.textConfigRevision !== revision
  );
}

export class BackgroundWorker extends Context.Service<BackgroundWorker, BackgroundWorkerApi>()(
  'jev/background/BackgroundWorker',
) {
  static readonly layer = Layer.effect(
    BackgroundWorker,
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const settingsState = yield* Ref.make<Settings | null>(null);
      const settingsLock = yield* Semaphore.make(1);
      const settingsReady = yield* Deferred.make<void, BrowserError>();
      const failingReason = yield* Ref.make<string | null>(null);
      const statusLock = yield* Semaphore.make(1);
      const iconLock = yield* Semaphore.make(1);
      const logLock = yield* Semaphore.make(1);
      const tabCountLock = yield* Semaphore.make(1);
      const tabCounts = yield* Ref.make(new Map<number, number>());
      const tabCountsLoaded = yield* Ref.make(false);
      // Extra queue room covers initial worker handoff; admission remains the
      // authoritative limit across both queued and active requests.
      const classificationAdmission = yield* Semaphore.make(QUEUE_CONCURRENCY + MAX_WAITING);
      const classificationQueue = yield* Queue.dropping<ClassificationJob>(
        QUEUE_CONCURRENCY + MAX_WAITING,
      );

      const updateIcon = Effect.fnUntraced(function* () {
        yield* iconLock.withPermits(1)(
          Effect.gen(function* () {
            const settings = yield* Ref.get(settingsState);
            const paused = !settings?.masterEnabled;
            const name = paused ? 'paused' : 'normal';
            yield* browserEffect('set toolbar icon', () =>
              browser.action.setIcon({
                path: {
                  16: `/icons/${name}-16.png`,
                  32: `/icons/${name}-32.png`,
                  48: `/icons/${name}-48.png`,
                  128: `/icons/${name}-128.png`,
                },
              }),
            ).pipe(
              Effect.catchTag('BrowserError', (error) =>
                Effect.sync(() => console.warn('[jev-filter] setIcon failed', error)),
              ),
            );
            const failure = yield* Ref.get(failingReason);
            const reason = failure ? ` — failing: ${failure.slice(0, 120)}` : '';
            yield* browserEffect('set toolbar title', () =>
              browser.action.setTitle({
                title: `Jev Feed Filter${paused ? ' (paused)' : reason}`,
              }),
            ).pipe(
              Effect.catchTag('BrowserError', (error) =>
                Effect.sync(() => console.warn('[jev-filter] setTitle failed', error)),
              ),
            );
          }),
        );
      });

      const setFailing = Effect.fnUntraced(function* (reason: string | null) {
        yield* statusLock.withPermits(1)(
          Effect.gen(function* () {
            yield* Ref.set(failingReason, reason);
            const status: FilterStatus = {
              state: reason ? 'failing' : 'ok',
              updatedAt: yield* Clock.currentTimeMillis,
            };
            if (reason !== null) status.reason = reason;
            yield* saveStatus(status);
          }),
        );
        yield* updateIcon();
      });

      const synchronizeSettings = Effect.fnUntraced(function* () {
        yield* settingsLock.withPermits(1)(
          Effect.gen(function* () {
            yield* Ref.set(settingsState, yield* loadSettings());
          }).pipe(
            Effect.catchTag('BrowserError', (error) =>
              Effect.sync(() => console.error('[jev-filter] failed to load settings', error)),
            ),
          ),
        );
      });

      const changeSettings = Effect.fnUntraced(function* (change: SettingsChange) {
        return yield* settingsLock.withPermits(1)(
          Effect.gen(function* () {
            const next = applySettingsChange(yield* loadSettings(), change);
            yield* browserEffect('save settings', () =>
              browser.storage.local.set({ [STORAGE_KEYS.settings]: next }),
            );
            yield* Ref.set(settingsState, next);
            return next;
          }),
        );
      });

      const setTabBadge = (tabId: number, text: string) =>
        browserEffect('set tab badge', () => browser.action.setBadgeText({ text, tabId })).pipe(
          Effect.catchTag('BrowserError', () => Effect.void),
        );

      const loadTabCounts = Effect.fnUntraced(function* () {
        if (yield* Ref.get(tabCountsLoaded)) return;
        const stored = yield* browserEffect('load tab counts', () =>
          browser.storage.session.get(null),
        );
        const next = new Map<number, number>();
        for (const [key, value] of Object.entries(stored)) {
          if (
            key.startsWith(TAB_COUNT_PREFIX) &&
            typeof value === 'number' &&
            Number.isFinite(value) &&
            value >= 0
          ) {
            next.set(Number(key.slice(TAB_COUNT_PREFIX.length)), value);
          }
        }
        yield* Ref.set(tabCounts, next);
        yield* Ref.set(tabCountsLoaded, true);
      });

      const updateTabCount = Effect.fnUntraced(function* (tabId: number, blocked: number) {
        yield* tabCountLock.withPermits(1)(
          Effect.gen(function* () {
            yield* loadTabCounts();
            const counts = yield* Ref.get(tabCounts);
            counts.set(tabId, blocked);
            yield* Ref.set(tabCounts, counts);
            yield* browserEffect('save tab count', () =>
              browser.storage.session.set({ [TAB_COUNT_PREFIX + tabId]: blocked }),
            );
            yield* setTabBadge(tabId, badgeTextFor(blocked, yield* Ref.get(settingsState)));
          }),
        );
      });

      const clearTabCount = Effect.fnUntraced(function* (tabId: number) {
        yield* tabCountLock.withPermits(1)(
          Effect.gen(function* () {
            const counts = yield* Ref.get(tabCounts);
            counts.delete(tabId);
            yield* Ref.set(tabCounts, counts);
            yield* browserEffect('remove tab count', () =>
              browser.storage.session.remove(TAB_COUNT_PREFIX + tabId),
            ).pipe(Effect.catchTag('BrowserError', () => Effect.void));
            yield* setTabBadge(tabId, '');
          }),
        );
      });

      const repaintTabBadges = Effect.fnUntraced(function* () {
        yield* tabCountLock.withPermits(1)(
          Effect.gen(function* () {
            yield* loadTabCounts();
            const settings = yield* Ref.get(settingsState);
            for (const [tabId, count] of yield* Ref.get(tabCounts)) {
              yield* setTabBadge(tabId, badgeTextFor(count, settings));
            }
          }),
        );
      });
      const warmEnabledModels = Effect.gen(function* () {
        const settings = yield* Ref.get(settingsState);
        if (!settings?.masterEnabled) return;
        const kinds: ModelKind[] = [];
        if (
          settings.enabled.porn ||
          settings.enabled.hentai ||
          settings.enabled.sexy ||
          settings.enabled.drawings
        )
          kinds.push('image');
        if (settings.enabled.aiGenerated) kinds.push('aiText');
        yield* warmLocalModels(kinds).pipe(
          Effect.catch((error) => {
            if (error.operation === 'load local models') return Effect.void;
            return browserEffect('save local model initialization error', () => {
              const statuses = initialModelStatuses();
              for (const kind of kinds)
                statuses[kind] = { ...statuses[kind], state: 'error', error: error.message };
              return browser.storage.local.set({ [MODEL_STATUS_KEY]: statuses });
            }).pipe(Effect.ignore);
          }),
        );
      });

      const updateSettingsAfterStorageChange = Effect.fnUntraced(function* () {
        yield* synchronizeSettings();
        yield* updateIcon();
        yield* repaintTabBadges();
        yield* Effect.forkIn(warmEnabledModels, scope);
      });

      const logOperation = <A>(operation: Effect.Effect<A, BrowserError>) =>
        logLock.withPermits(1)(operation);

      const classifyRequest = Effect.fnUntraced(function* (
        request: Extract<BgRequest, { type: 'jev' }>,
      ): Effect.fn.Return<JevReply, BrowserError> {
        const settings = yield* settingsLock.withPermits(1)(Ref.get(settingsState));
        if (isStaleSettings(settings, request.provider, request.revision)) {
          return { ok: false, stale: true, error: 'Text configuration changed.' };
        }

        const apiKey = settings?.providerKeys[request.provider];
        if (!apiKey) {
          const message = 'no API key configured';
          yield* setFailing(message);
          return { ok: false, error: message };
        }

        const outcome = yield* Effect.result(
          evaluateText({ provider: request.provider, apiKey, text: request.text }),
        );
        const current = yield* Ref.get(settingsState);
        if (isStaleSettings(current, request.provider, request.revision)) {
          return { ok: false, stale: true, error: 'Text configuration changed.' };
        }

        if (outcome._tag === 'Failure') {
          let message = outcome.failure.message;
          const statusCode = outcome.failure.statusCode;
          if (typeof statusCode === 'number' && !message.includes(String(statusCode))) {
            message = `${statusCode}: ${message}`;
          }
          yield* setFailing(message);
          return { ok: false, error: message };
        }

        if (yield* Ref.get(failingReason)) yield* setFailing(null);
        const scores: TextScores = outcome.success;
        return { ok: true, provider: request.provider, revision: request.revision, ...scores };
      });

      const classify = Effect.fnUntraced(function* (
        request: Extract<BgRequest, { type: 'jev' }>,
      ): Effect.fn.Return<JevReply, BrowserError> {
        yield* Deferred.await(settingsReady);
        const settings = yield* settingsLock.withPermits(1)(Ref.get(settingsState));
        if (isStaleSettings(settings, request.provider, request.revision)) {
          return { ok: false, stale: true, error: 'Text configuration changed.' };
        }

        const admitted = yield* classificationAdmission.withPermitsIfAvailable(1)(
          Effect.gen(function* () {
            const reply = yield* Deferred.make<JevReply, BrowserError>();
            const offered = yield* Queue.offer(classificationQueue, { request, reply });
            if (!offered) return undefined;
            return yield* Deferred.await(reply);
          }),
        );
        if (Option.isNone(admitted) || admitted.value === undefined) {
          const current = yield* Ref.get(settingsState);
          if (isStaleSettings(current, request.provider, request.revision)) {
            return { ok: false, stale: true, error: 'Text configuration changed.' };
          }
          const message = `classification queue full (${MAX_WAITING} waiting)`;
          yield* setFailing(message);
          return { ok: false, error: message };
        }
        return admitted.value;
      });

      const workerLoop = Effect.forever(
        Effect.gen(function* () {
          const job = yield* Queue.take(classificationQueue);
          const exit = yield* Effect.exit(classifyRequest(job.request));
          yield* Deferred.done(job.reply, exit);
        }),
      );

      for (let index = 0; index < QUEUE_CONCURRENCY; index++) {
        yield* Effect.forkScoped(workerLoop);
      }

      const initialize = Effect.gen(function* () {
        yield* Effect.forkDetach(
          browserEffect('set badge background color', () =>
            browser.action.setBadgeBackgroundColor({ color: '#1d9bf0' }),
          ).pipe(Effect.catchTag('BrowserError', () => Effect.void)),
        );
        yield* Effect.forkDetach(
          browserEffect('set badge text color', () =>
            browser.action.setBadgeTextColor({ color: '#ffffff' }),
          ).pipe(Effect.catchTag('BrowserError', () => Effect.void)),
        );

        yield* synchronizeSettings();
        const settings = yield* Ref.get(settingsState);
        // Rewrite normalized historical settings once, removing the old shared key.
        if (settings) {
          yield* browserEffect('normalize settings', () =>
            browser.storage.local.set({ [STORAGE_KEYS.settings]: settings }),
          );
        }
        const status = yield* loadStatus();
        yield* Ref.set(
          failingReason,
          status.state === 'failing' ? (status.reason ?? 'unknown') : null,
        );
        yield* updateIcon();
        yield* Deferred.succeed(settingsReady, undefined);
        yield* Effect.forkIn(warmEnabledModels, scope);
      }).pipe(Effect.tapError((error) => Deferred.fail(settingsReady, error)));

      const handleRequest = Effect.fnUntraced(function* (
        request: BgRequest,
        sender: MessageSender,
      ): Effect.fn.Return<unknown, BrowserError> {
        yield* Deferred.await(settingsReady);
        switch (request.type) {
          case 'local-model-status':
            if (
              sender.id !== browser.runtime.id ||
              sender.tab ||
              sender.url !== browser.runtime.getURL('/inference.html')
            )
              return {
                ok: false,
                error: 'Local model status must come from the inference document.',
              };
            yield* browserEffect('save local model status', () =>
              browser.storage.local.set({ [MODEL_STATUS_KEY]: request.models }),
            );
            return { ok: true };
          case 'jev':
            return yield* classify(request);
          case 'extract-image-text':
          case 'classify-image': {
            const image = yield* fetchImageDataUrl(request.url);
            if (!image.ok) return image;
            return yield* runLocalInference({
              target: 'local-inference',
              operation: request.type === 'extract-image-text' ? 'ocr' : 'image',
              dataUrl: image.dataUrl,
            });
          }
          case 'classify-ai':
            return yield* runLocalInference({
              target: 'local-inference',
              operation: 'aiText',
              text: request.text,
            });
          case 'load-model':
            return yield* runLocalInference({
              target: 'local-inference',
              operation: 'warmup',
              models: [request.kind],
            });
          case 'update-settings': {
            const settings = yield* changeSettings(request.change);
            return { ok: true, settings };
          }
          case 'get-status':
            return yield* statusLock.withPermits(1)(loadStatus());
          case 'log-blocked':
            yield* logOperation(appendBlocked(request.entry));
            return { ok: true };
          case 'log-error':
            yield* logOperation(
              !request.tweetId
                ? appendScanError(request.message)
                : appendScanError(request.message, {
                    tweetId: request.tweetId,
                    ...(request.handle === undefined ? {} : { handle: request.handle }),
                  }),
            );
            return { ok: true };
          case 'clear-log':
            return { ok: true, type: request.type, cleared: yield* logOperation(clearLog) };
          case 'clear-errors':
            return { ok: true, type: request.type, cleared: yield* logOperation(clearScanErrors) };
          case 'open-logs': {
            // Page contexts cannot navigate to chrome-extension:// URLs; open the
            // log from the privileged worker instead. Keep the existing immediate reply.
            const url = browser.runtime.getURL('/logs.html') + (request.errors ? '#errors' : '');
            yield* Effect.forkDetach(
              browserEffect('open logs page', () => browser.tabs.create({ url })).pipe(
                Effect.catchTag('BrowserError', () => Effect.void),
              ),
            );
            return { ok: true };
          }
          case 'tab-stats': {
            const tabId = sender.tab?.id;
            if (typeof tabId !== 'number') return { ok: false };
            if (!Number.isFinite(request.blocked) || request.blocked < 0) return { ok: false };
            yield* updateTabCount(tabId, Math.floor(request.blocked));
            return { ok: true };
          }
        }
      });

      return BackgroundWorker.of({
        initialize,
        handleRequest,
        settingsChanged: updateSettingsAfterStorageChange(),
        tabRemoved: clearTabCount,
        tabNavigated: clearTabCount,
      });
    }),
  );
}

function fetchImageDataUrl(
  url: string,
): Effect.Effect<{ ok: true; dataUrl: string } | { ok: false; error: string }> {
  if (!isAllowedImageUrl(url)) {
    return Effect.succeed({ ok: false, error: `image proxy: host not allowed for ${url}` });
  }

  const fetchData = Effect.tryPromise({
    try: async (signal) => {
      const timeoutSignal = AbortSignal.any([signal, AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS)]);
      const response = await fetch(url, { credentials: 'omit', signal: timeoutSignal });
      if (!response.ok) throw new Error(`image fetch HTTP ${response.status}`);
      const blob = await response.blob();
      if (blob.size > MAX_IMAGE_BYTES) {
        throw new Error(`image too large: ${blob.size} bytes (limit ${MAX_IMAGE_BYTES})`);
      }
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const mime = blob.type || 'application/octet-stream';
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += BTOA_CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + BTOA_CHUNK));
      }
      return `data:${mime};base64,${btoa(binary)}`;
    },
    catch: (cause) => {
      let message: string;
      if (cause instanceof DOMException && cause.name === 'TimeoutError')
        message = `image fetch timed out after ${IMAGE_FETCH_TIMEOUT_MS}ms`;
      else if (cause instanceof Error) message = cause.message;
      else message = String(cause);
      return new ImageProxyError({ message });
    },
  });

  return Effect.result(fetchData).pipe(
    Effect.map((result) =>
      result._tag === 'Failure'
        ? { ok: false, error: `image proxy failed for ${url}: ${result.failure.message}` }
        : { ok: true, dataUrl: result.success },
    ),
  );
}
