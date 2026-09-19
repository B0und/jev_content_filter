import { normalizeBenchmarkState, type BenchmarkState } from './model';

const STORAGE_ENDPOINT = '/api/benchmark/state';
let saveQueue = Promise.resolve();

async function requestState(
  method: 'GET' | 'POST',
  state?: BenchmarkState,
): Promise<BenchmarkState> {
  const request: RequestInit = { method, credentials: 'same-origin' };
  if (method === 'POST' && state) {
    request.headers = { 'Content-Type': 'application/json' };
    request.body = JSON.stringify(state);
  }
  const response = await fetch(STORAGE_ENDPOINT, request);
  if (!response.ok) throw new Error(`SQLite storage request failed (${response.status}).`);
  return normalizeBenchmarkState((await response.json()) as unknown);
}

export async function loadBenchmarkState(): Promise<BenchmarkState> {
  return requestState('GET');
}

export function saveBenchmarkState(state: BenchmarkState): Promise<void> {
  saveQueue = saveQueue
    .catch(() => undefined)
    .then(async () => {
      await requestState('POST', state);
    });
  return saveQueue;
}
