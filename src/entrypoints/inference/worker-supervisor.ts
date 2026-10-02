// Supervises the local-inference module worker. A worker that stops (WASM
// abort, failed worker setup) must not disable local filtering for the rest of
// the browser session, so failures drop the instance and the next request
// starts a fresh one. Extracted from the offscreen page so the recovery path is
// testable without a browser.
export interface WorkerHandlers {
  onMessage: (event: MessageEvent<unknown>) => void;
  onError: (event: ErrorEvent) => void;
}

export interface SupervisedWorker {
  postMessage(message: unknown): void;
  terminate(): void;
}

export interface WorkerSupervisor {
  send(message: { id: number; request?: unknown }): void;
  complete(id: number): void;
  terminate(): void;
}

export function createWorkerSupervisor(options: {
  start: (handlers: WorkerHandlers) => SupervisedWorker;
  onMessage: (event: MessageEvent<unknown>) => void;
  onFailure: (error: Error) => void;
  requestTimeoutMs?: number;
}): WorkerSupervisor {
  let worker: SupervisedWorker | undefined;
  const deadlines = new Map<number, ReturnType<typeof setTimeout>>();
  const clearDeadlines = () => {
    for (const timer of deadlines.values()) clearTimeout(timer);
    deadlines.clear();
  };
  const fail = (instance: SupervisedWorker, error: Error) => {
    if (worker !== instance) return;
    worker = undefined;
    clearDeadlines();
    instance.terminate();
    options.onFailure(error);
  };
  const start = (): SupervisedWorker => {
    const created = options.start({
      onMessage: (event) => {
        if (worker === created) options.onMessage(event);
      },
      onError: (event) => {
        // A late error from an already-replaced worker must not reject requests
        // pending on the replacement or mark the models as failed.
        fail(
          created,
          new Error(event.message || 'Local inference worker stopped. Retry to restart it.'),
        );
      },
    });
    worker = created;
    return created;
  };
  return {
    send(message) {
      const instance = worker ?? start();
      // Bound queueing, model loading and inference together. Terminating the
      // worker also releases a permit held by a non-settling model operation.
      deadlines.set(
        message.id,
        setTimeout(() => {
          fail(instance, new Error('Local inference timed out. Retry to restart it.'));
        }, options.requestTimeoutMs ?? 300_000),
      );
      try {
        instance.postMessage(message);
      } catch (cause) {
        fail(instance, cause instanceof Error ? cause : new Error(String(cause)));
      }
    },
    complete(id) {
      clearTimeout(deadlines.get(id));
      deadlines.delete(id);
    },
    terminate() {
      const instance = worker;
      worker = undefined;
      clearDeadlines();
      instance?.terminate();
    },
  };
}
