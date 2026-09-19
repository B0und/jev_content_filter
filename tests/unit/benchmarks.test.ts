import { describe, expect, it } from 'vitest';
import {
  emptyNsfwjsScores,
  emptyPredictionReview,
  initialBenchmarkState,
  manualReviewFor,
  metricsFor,
  normalizeBenchmarkState,
  parseSolutionImport,
  predictionLabel,
  type BenchmarkCase,
  type BenchmarkSolution,
} from '../../benchmarks/model';

const cases: BenchmarkCase[] = [
  {
    id: 'safe',
    modality: 'text',
    title: 'Safe',
    text: 'A calm afternoon.',
    labels: { explicit: 'no', aiGenerated: 'no' },
    notes: '',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'explicit',
    modality: 'image',
    title: 'Explicit',
    imageUrl: './images/example.webp',
    labels: { explicit: 'yes', aiGenerated: 'no' },
    notes: '',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'unknown',
    modality: 'text',
    title: 'Unknown',
    text: 'Needs review.',
    labels: { explicit: 'unknown', aiGenerated: 'unknown' },
    notes: '',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
];

const solution: BenchmarkSolution = {
  id: 'solution-a',
  name: 'Solution A',
  description: '',
  kind: 'llm',
  predictions: {
    safe: {
      explicit: 0.1,
      aiGenerated: 0.2,
      nsfwjs: emptyNsfwjsScores(),
      review: emptyPredictionReview(),
    },
    explicit: {
      explicit: 0.9,
      aiGenerated: 0.1,
      nsfwjs: emptyNsfwjsScores(),
      review: emptyPredictionReview(),
    },
  },
};

describe('benchmark metrics', () => {
  it('scores only labeled cases and reports coverage separately', () => {
    const metrics = metricsFor(cases, solution, 'explicit', 0.5);
    expect(metrics).toMatchObject({
      labeled: 2,
      scored: 2,
      truePositive: 1,
      trueNegative: 1,
      falsePositive: 0,
      falseNegative: 0,
      coverage: 1,
      accuracy: 1,
      precision: 1,
      recall: 1,
      f1: 1,
    });
  });

  it('keeps missing predictions visible as incomplete coverage', () => {
    const metrics = metricsFor(cases, solution, 'aiGenerated', 0.5);
    expect(metrics.labeled).toBe(2);
    expect(metrics.scored).toBe(2);
    expect(metrics.coverage).toBe(1);
    expect(metrics.trueNegative).toBe(2);
    expect(metrics.f1).toBeNull();
    expect(predictionLabel(null, 0.5)).toBe('missing');
    expect(predictionLabel(0.49, 0.5)).toBe('negative');
    expect(predictionLabel(0.5, 0.5)).toBe('positive');
  });

  it('summarizes right and wrong verdicts for entered scores', () => {
    const reviewed = parseSolutionImport(
      JSON.stringify({
        name: 'Reviewed model',
        predictions: {
          safe: { explicit: 0.1, review: { explicit: 'right' } },
          explicit: { explicit: 0.9, review: { explicit: 'wrong' } },
          unknown: { review: { explicit: 'right' } },
        },
      }),
    );
    expect(reviewed.predictions.unknown?.review.explicit).toBe('unreviewed');
    expect(manualReviewFor(cases, reviewed)).toEqual({ right: 1, wrong: 1, pending: 0 });
  });
});

describe('benchmark data boundaries', () => {
  it('clamps imported scores and rejects incomplete solution files', () => {
    const imported = parseSolutionImport(
      JSON.stringify({
        name: 'Imported model',
        predictions: { safe: { explicit: 4, aiGenerated: -1 } },
      }),
    );
    expect(imported.predictions.safe).toEqual({
      explicit: 1,
      aiGenerated: 0,
      nsfwjs: emptyNsfwjsScores(),
      review: emptyPredictionReview(),
    });
    expect(imported.kind).toBe('other');
    expect(() => parseSolutionImport('{}')).toThrow('non-empty "name"');
    expect(() => parseSolutionImport('{"name":"Missing predictions"}')).toThrow('predictions');
  });

  it('imports solution kinds and NSFWJS score families', () => {
    const imported = parseSolutionImport(
      JSON.stringify({
        name: 'NSFWJS',
        type: 'nsfwjs',
        predictions: {
          safe: {
            nsfwjs: { porn: 0.1, hentai: 0.2, sexy: 0.3, drawings: 0.4 },
          },
        },
      }),
    );
    expect(imported.kind).toBe('nsfwjs');
    expect(imported.predictions.safe).toEqual({
      explicit: null,
      aiGenerated: null,
      nsfwjs: { porn: 0.1, hentai: 0.2, sexy: 0.3, drawings: 0.4 },
      review: emptyPredictionReview(),
    });
    const direct = parseSolutionImport(
      JSON.stringify({
        name: 'NSFWJS direct',
        type: 'nsfwjs',
        predictions: { safe: { porn: 0.7, hentai: 0.8, sexy: 0.9, drawings: 1.1 } },
      }),
    );
    expect(direct.predictions.safe?.nsfwjs).toEqual({
      porn: 0.7,
      hentai: 0.8,
      sexy: 0.9,
      drawings: 1,
    });
  });

  it('falls back to a usable dataset when persisted state is malformed', () => {
    const fallback = initialBenchmarkState();
    const loaded = normalizeBenchmarkState({ cases: [null, { id: 'bad' }], solutions: 'nope' });
    expect(loaded.cases).toEqual([]);
    expect(loaded.solutions).toEqual(fallback.solutions);
    expect(loaded.selectedCaseId).toBeNull();
  });
});
