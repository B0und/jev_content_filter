import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { initialBenchmarkState } from '../../benchmarks/model';
import { SQLiteBenchmarkStore } from '../../benchmarks/storage-server';

describe('SQLite benchmark storage', () => {
  it('persists normalized scores and manual verdicts across connections', () => {
    const directory = mkdtempSync(join(tmpdir(), 'jev-benchmark-'));
    const databasePath = join(directory, 'benchmark.sqlite');
    const state = initialBenchmarkState();
    const caseId = state.cases[0]?.id;
    if (!caseId) throw new Error('Initial benchmark case is missing.');

    const firstStore = new SQLiteBenchmarkStore(databasePath);
    try {
      firstStore.save({
        ...state,
        solutions: [
          {
            id: 'solution-sqlite',
            name: 'SQLite candidate',
            description: '',
            kind: 'llm',
            predictions: {
              [caseId]: {
                explicit: 0.23,
                review: { explicit: 'wrong' },
              },
            },
          },
        ],
      });
    } finally {
      firstStore.close();
    }

    const secondStore = new SQLiteBenchmarkStore(databasePath);
    try {
      const restored = secondStore.load();
      expect(restored.solutions[0]?.predictions[caseId]).toMatchObject({
        explicit: 0.23,
        review: { explicit: 'wrong' },
      });
    } finally {
      secondStore.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
