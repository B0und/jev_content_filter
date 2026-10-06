// MV3 listeners register synchronously before the runtime initializes its Layer.
import { Effect, ManagedRuntime } from 'effect';
import * as Schema from 'effect/Schema';
import { browser } from 'wxt/browser';
import type { BrowserError } from '../platform/browser';
import { BgRequestSchema } from '../filtering/schemas';
import { STORAGE_KEYS } from '../filtering/types';
import { BackgroundWorker, type MessageSender } from './worker';

const BG_REQUEST_TYPES: Record<string, true> = {
  jev: true,
  'update-settings': true,
  'classify-image': true,
  'classify-ai': true,
  'load-model': true,
  'local-model-status': true,
  'get-status': true,
  'log-blocked': true,
  'log-error': true,
  'clear-log': true,
  'clear-errors': true,
  'open-logs': true,
  'tab-stats': true,
};

const isBgRequest = Schema.is(BgRequestSchema);

const backgroundRuntime = ManagedRuntime.make(BackgroundWorker.layer);

function runBackgroundEffect(
  effect: Effect.Effect<unknown, BrowserError, BackgroundWorker>,
  operation: string,
): void {
  void backgroundRuntime
    .runPromise(effect)
    .catch((error: unknown) => console.error(`[jev-filter] ${operation}`, error));
}

function onMessageListener(
  request: unknown,
  sender: MessageSender,
  sendResponse: (reply: unknown) => void,
): true | undefined {
  if (
    typeof request !== 'object' ||
    request === null ||
    !('type' in request) ||
    typeof request.type !== 'string' ||
    !Object.hasOwn(BG_REQUEST_TYPES, request.type)
  ) {
    return;
  }
  if (!isBgRequest(request)) {
    sendResponse({ ok: false, error: 'Invalid request.' });
    return true;
  }
  const effect = Effect.flatMap(BackgroundWorker, (worker) =>
    worker.handleRequest(request, sender),
  );
  void backgroundRuntime
    .runPromise(effect)
    .then((reply) => sendResponse(reply))
    .catch((error: unknown) =>
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  return true;
}

/**
 * Register every listener before starting asynchronous initialization. MV3 can
 * wake this worker for an event as soon as listener registration returns.
 */
export function startBackground(): void {
  browser.runtime.onMessage.addListener(onMessageListener);

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[STORAGE_KEYS.settings]) return;
    runBackgroundEffect(
      Effect.flatMap(BackgroundWorker, (worker) => worker.settingsChanged),
      'failed to synchronize settings',
    );
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    runBackgroundEffect(
      Effect.flatMap(BackgroundWorker, (worker) => worker.tabRemoved(tabId)),
      'failed to clear removed tab count',
    );
  });
  browser.webNavigation.onCommitted.addListener(({ tabId, frameId }) => {
    if (frameId !== 0) return;
    runBackgroundEffect(
      Effect.flatMap(BackgroundWorker, (worker) => worker.tabNavigated(tabId)),
      'failed to clear navigating tab count',
    );
  });

  runBackgroundEffect(
    Effect.flatMap(BackgroundWorker, (worker) => worker.initialize),
    'failed to initialize worker',
  );
}
