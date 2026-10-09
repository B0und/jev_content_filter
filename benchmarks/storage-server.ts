import { Cause, Context, Effect, Exit, Layer, ManagedRuntime, Stream } from 'effect';
import * as Schema from 'effect/Schema';
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
    const row = this.database.prepare('SELECT payload FROM benchmark_state WHERE id = 1').get();

    if (!row || !Schema.is(Schema.String)(row.payload)) return this.save(initialBenchmarkState());

    try {
      const payload: unknown = JSON.parse(row.payload);

      return normalizeBenchmarkState(payload);
    } catch {
      return this.save(initialBenchmarkState());
    }
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This storage entrypoint normalizes imported and historical snapshots.
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

class BenchmarkRequestError extends Schema.TaggedError<BenchmarkRequestError>()(
  'BenchmarkRequestError',
  {
    cause: Schema.Defect(),
  },
) {}

class BenchmarkDatabase extends Context.Service<BenchmarkDatabase, SQLiteBenchmarkStore>()(
  'jev/benchmarks/Database',
) {}

const readJson = Effect.fn('readBenchmarkJson')(function* (request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  yield* Stream.fromAsyncIterable(request, (cause) => new BenchmarkRequestError({ cause })).pipe(
    Stream.runForEach((chunk) =>
      Effect.gen(function* () {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.byteLength;

        if (size > 16 * 1024 * 1024)
          return yield* new BenchmarkRequestError({
            cause: new Error('Request body is too large.'),
          });
        chunks.push(buffer);
      }),
    ),
  );

  return yield* Effect.try({
    try: () => {
      const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));

      return normalizeBenchmarkState(payload);
    },
    catch: (cause) => new BenchmarkRequestError({ cause }),
  });
});

function sendJson(
  response: ServerResponse,
  status: number,
  value: BenchmarkState | { error: string },
): void {
  const payload = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(payload);
}

const handleRequest = Effect.fn('handleBenchmarkRequest')(
  function* (request: IncomingMessage, response: ServerResponse) {
    const store = yield* BenchmarkDatabase;

    if (request.method === 'GET') {
      const state = yield* Effect.try({
        try: () => store.load(),
        catch: (cause) => new BenchmarkRequestError({ cause }),
      });

      sendJson(response, 200, state);

      return;
    }

    if (request.method === 'POST') {
      const value = yield* readJson(request);

      const state = yield* Effect.try({
        try: () => store.save(value),
        catch: (cause) => new BenchmarkRequestError({ cause }),
      });

      sendJson(response, 200, state);

      return;
    }

    sendJson(response, 405, { error: 'Only GET and POST are supported.' });
  },
  (effect, _request, response) =>
    effect.pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          const message =
            error.cause instanceof Error ? error.cause.message : 'SQLite storage request failed.';

          sendJson(response, 400, { error: message });
        }),
      ),
    ),
);

export function createBenchmarkStoragePlugin(filePath = DEFAULT_DATABASE_PATH): Plugin {
  return {
    name: 'jev-benchmark-sqlite-storage',
    configureServer(server: ViteDevServer) {
      const runtime = ManagedRuntime.make(
        Layer.effect(
          BenchmarkDatabase,
          Effect.acquireRelease(
            Effect.try({
              try: () => new SQLiteBenchmarkStore(filePath),
              catch: (cause) => new BenchmarkRequestError({ cause }),
            }),
            (store) => Effect.sync(() => store.close()),
          ),
        ),
      );

      server.middlewares.use(STORAGE_ENDPOINT, (request, response, next) => {
        if (request.method !== 'GET' && request.method !== 'POST') {
          next();

          return;
        }

        runtime.runCallback(handleRequest(request, response), {
          onExit: (exit) => {
            if (!Exit.isFailure(exit)) return;
            console.error('Benchmark storage request failed:', Cause.pretty(exit.cause));

            if (!response.writableEnded && !response.destroyed)
              sendJson(response, 500, { error: 'Internal server error.' });
          },
        });
      });

      return () => {
        server.httpServer?.once('close', () => {
          void runtime.dispose();
        });
      };
    },
  };
}
