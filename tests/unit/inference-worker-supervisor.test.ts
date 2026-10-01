// A crashed inference worker must not disable local filtering for the session:
// the supervisor has to drop the failed instance and start a replacement.
import { describe, expect, it } from 'vitest';
import {
  createWorkerSupervisor,
  type SupervisedWorker,
  type WorkerHandlers,
} from '../../src/entrypoints/inference/worker-supervisor';

interface FakeWorker extends SupervisedWorker {
  sent: unknown[];
  terminated: boolean;
}

function fakeWorkerFactory() {
  const created: FakeWorker[] = [];
  const handlers: WorkerHandlers[] = [];
  const start = (workerHandlers: WorkerHandlers): SupervisedWorker => {
    const worker: FakeWorker = {
      sent: [],
      terminated: false,
      postMessage: (message) => {
        worker.sent.push(message);
      },
      terminate: () => {
        worker.terminated = true;
      },
    };
    created.push(worker);
    handlers.push(workerHandlers);
    return worker;
  };
  return { created, handlers, start };
}

function crash(handlers: WorkerHandlers, message: string) {
  handlers.onError(new ErrorEvent('error', { message }));
}

describe('inference worker supervisor', () => {
  it('starts a replacement worker after a failure and reports it once', () => {
    const factory = fakeWorkerFactory();
    const failures: Error[] = [];
    const supervisor = createWorkerSupervisor({
      start: factory.start,
      onMessage: () => {},
      onFailure: (error) => failures.push(error),
    });

    supervisor.send({ id: 1 });
    expect(factory.created).toHaveLength(1);

    crash(factory.handlers[0]!, 'WebAssembly trapped');
    expect(factory.created[0]!.terminated).toBe(true);
    expect(failures.map((error) => error.message)).toEqual(['WebAssembly trapped']);

    supervisor.send({ id: 2 });
    expect(factory.created).toHaveLength(2);
    expect(factory.created[1]!.sent).toEqual([{ id: 2 }]);
  });

  it('ignores a late failure from a worker that was already replaced', () => {
    const factory = fakeWorkerFactory();
    const failures: Error[] = [];
    const supervisor = createWorkerSupervisor({
      start: factory.start,
      onMessage: () => {},
      onFailure: (error) => failures.push(error),
    });

    supervisor.send({ id: 1 });
    crash(factory.handlers[0]!, 'first failure');
    supervisor.send({ id: 2 });

    crash(factory.handlers[0]!, 'stale failure');
    expect(failures.map((error) => error.message)).toEqual(['first failure']);
    expect(factory.created[1]!.terminated).toBe(false);

    supervisor.send({ id: 3 });
    expect(factory.created).toHaveLength(2);
    expect(factory.created[1]!.sent).toEqual([{ id: 2 }, { id: 3 }]);
  });

  it('terminates the active worker on teardown and starts fresh afterwards', () => {
    const factory = fakeWorkerFactory();
    const supervisor = createWorkerSupervisor({
      start: factory.start,
      onMessage: () => {},
      onFailure: () => {},
    });

    supervisor.send({ id: 1 });
    supervisor.terminate();
    expect(factory.created[0]!.terminated).toBe(true);

    supervisor.send({ id: 2 });
    expect(factory.created).toHaveLength(2);
  });

  it('delivers messages from the active worker to the page handler', () => {
    const factory = fakeWorkerFactory();
    const seen: unknown[] = [];
    const supervisor = createWorkerSupervisor({
      start: factory.start,
      onMessage: (event) => seen.push(event.data),
      onFailure: () => {},
    });

    supervisor.send({ id: 1 });
    expect(seen).toEqual([]);
    factory.handlers[0]!.onMessage(new MessageEvent('message', { data: { type: 'status' } }));
    expect(seen).toEqual([{ type: 'status' }]);
  });
});
