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
  send(message: { id: number; request?: unknown }): Error | undefined;
  complete(id: number): void;
  cancel(id: number): void;
  terminate(): void;
}

export function createWorkerSupervisor(options: {
  start: (handlers: WorkerHandlers) => SupervisedWorker;
  onMessage: (event: MessageEvent<unknown>) => void;
  onFailure: (error: Error) => void;
  requestTimeoutMs?: number;
}): WorkerSupervisor {
  let worker: SupervisedWorker | undefined;
  const queued: Array<{ id: number; request?: unknown }> = [];
  let activeId: number | undefined;
  const deadlines = new Map<number, ReturnType<typeof setTimeout>>();
  const clearDeadlines = () => {
    for (const timer of deadlines.values()) clearTimeout(timer);
    deadlines.clear();
    queued.length = 0;
    activeId = undefined;
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
  const dispatch = () => {
    if (activeId !== undefined) return;
    const message = queued.shift();
    if (!message) return;
    let instance: SupervisedWorker;
    try {
      instance = worker ?? start();
    } catch (cause) {
      clearDeadlines();
      options.onFailure(cause instanceof Error ? cause : new Error(String(cause)));
      return;
    }
    activeId = message.id;
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
  };
  return {
    send(message) {
      // Keep at most one active request and eight waiting payloads. Queue time
      // cannot expire the active worker's execution deadline.
      if (queued.length >= 8) return new Error('Local inference queue full. Retry shortly.');
      queued.push(message);
      dispatch();
      return undefined;
    },
    complete(id) {
      clearTimeout(deadlines.get(id));
      deadlines.delete(id);
      if (activeId === id) {
        activeId = undefined;
        dispatch();
      }
    },
    cancel(id) {
      const index = queued.findIndex((message) => message.id === id);
      if (index !== -1) queued.splice(index, 1);
      // Already-dispatched execution keeps its deadline and completion path;
      // cancelling a caller must not release the worker for concurrent work.
    },
    terminate() {
      const instance = worker;
      worker = undefined;
      clearDeadlines();
      instance?.terminate();
    },
  };
}
