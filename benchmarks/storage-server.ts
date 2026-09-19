import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin, ViteDevServer } from 'vite';
import { initialBenchmarkState, normalizeBenchmarkState, type BenchmarkState } from './model';

export const STORAGE_ENDPOINT = '/api/benchmark/state';
export const DEFAULT_DATABASE_PATH = resolve(
  process.cwd(),
  'benchmarks',
  '.data',
  'benchmark.sqlite',
);

export class SQLiteBenchmarkStore {
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(filePath = DEFAULT_DATABASE_PATH) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.database = new DatabaseSync(filePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS benchmark_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  load(): BenchmarkState {
    const row = this.database.prepare('SELECT payload FROM benchmark_state WHERE id = 1').get() as
      | { payload?: unknown }
      | undefined;
    if (!row || typeof row.payload !== 'string') return this.save(initialBenchmarkState());
    try {
      return normalizeBenchmarkState(JSON.parse(row.payload) as unknown);
    } catch {
      return this.save(initialBenchmarkState());
    }
  }

  save(value: unknown): BenchmarkState {
    const state = normalizeBenchmarkState(value);
    this.database
      .prepare(
        `INSERT INTO benchmark_state (id, payload, updated_at)
         VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify(state), new Date().toISOString());
    return state;
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 16 * 1024 * 1024) throw new Error('Request body is too large.');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const payload = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(payload);
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  store: SQLiteBenchmarkStore,
): Promise<void> {
  try {
    if (request.method === 'GET') {
      sendJson(response, 200, store.load());
      return;
    }
    if (request.method === 'POST') {
      sendJson(response, 200, store.save(await readJson(request)));
      return;
    }
    sendJson(response, 405, { error: 'Only GET and POST are supported.' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'SQLite storage request failed.';
    sendJson(response, 400, { error: message });
  }
}

export function createBenchmarkStoragePlugin(filePath = DEFAULT_DATABASE_PATH): Plugin {
  return {
    name: 'jev-benchmark-sqlite-storage',
    configureServer(server: ViteDevServer) {
      const store = new SQLiteBenchmarkStore(filePath);
      server.middlewares.use(STORAGE_ENDPOINT, (request, response, next) => {
        if (request.method !== 'GET' && request.method !== 'POST') {
          next();
          return;
        }
        void handleRequest(request, response, store);
      });
      return () => {
        server.httpServer?.once('close', () => store.close());
      };
    },
  };
}
