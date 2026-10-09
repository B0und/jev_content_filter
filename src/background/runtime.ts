import { Predicate, Effect, ManagedRuntime } from 'effect';
// MV3 listeners register synchronously before the runtime initializes its Layer.
import * as Schema from 'effect/Schema';
import { browser } from 'wxt/browser';
import type { BrowserError } from '../platform/browser';
import { BgRequestSchema } from '../filtering/schemas';
import { STORAGE_KEYS } from '../filtering/types';
import { BackgroundWorker, type MessageSender } from './worker';

const BG_REQUEST_TYPES = {
  jev: true,
  'follow-bootstrap': true,
  'update-settings': true,
  'classify-image': true,
  'extract-image-text': true,
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
    .catch((cause: unknown) => console.error(`[jev-filter] ${operation}`, cause));
}

function onMessageListener(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This boundary validates untrusted data before exposing domain values.
  request: unknown,
  sender: MessageSender,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Browser messaging owns the callback contract; the worker supplies schema-validated replies.
  sendResponse: (reply: unknown) => void,
): true | undefined {
  if (
    !Predicate.isObject(request) ||
    !('type' in request) ||
    !Schema.is(Schema.String)(request.type) ||
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
    .catch((cause: unknown) =>
      sendResponse({
        ok: false,
        error: cause instanceof Error ? cause.message : String(cause),
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
