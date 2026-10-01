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
  send(message: unknown): void;
  terminate(): void;
}

export function createWorkerSupervisor(options: {
  start: (handlers: WorkerHandlers) => SupervisedWorker;
  onMessage: (event: MessageEvent<unknown>) => void;
  onFailure: (error: Error) => void;
}): WorkerSupervisor {
  let worker: SupervisedWorker | undefined;
  const start = (): SupervisedWorker => {
    const created = options.start({
      onMessage: options.onMessage,
      onError: (event) => {
        // A late error from an already-replaced worker must not reject requests
        // pending on the replacement or mark the models as failed.
        if (worker !== created) return;
        worker = undefined;
        created.terminate();
        options.onFailure(
          new Error(event.message || 'Local inference worker stopped. Retry to restart it.'),
        );
      },
    });
    worker = created;
    return created;
  };
  return {
    send(message) {
      (worker ?? start()).postMessage(message);
    },
    terminate() {
      const instance = worker;
      worker = undefined;
      instance?.terminate();
    },
  };
}
