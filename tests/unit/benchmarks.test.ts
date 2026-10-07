import { describe, expect, it } from 'vitest';
import {
  exportBenchmarkState,
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
    id: 'ordinary',
    modality: 'text',
    title: 'Ordinary',
    text: 'A calm afternoon.',
    labels: { contentMatch: 'no', aiGenerated: 'no' },
    provenance: 'unknown',
    notes: '',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'explicit',
    modality: 'image',
    title: 'Content match',
    imageUrl: './images/example.webp',
    labels: { contentMatch: 'yes', aiGenerated: 'no' },
    provenance: 'unknown',
    notes: '',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'unknown',
    modality: 'text',
    title: 'Unknown',
    text: 'Needs review.',
    labels: { contentMatch: 'unknown', aiGenerated: 'unknown' },
    provenance: 'unknown',
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
    ordinary: {
      contentMatch: 0.1,
      aiGenerated: 0.2,
      nsfwjs: emptyNsfwjsScores(),
      review: emptyPredictionReview(),
    },
    explicit: {
      contentMatch: 0.9,
      aiGenerated: 0.1,
      nsfwjs: emptyNsfwjsScores(),
      review: emptyPredictionReview(),
    },
  },
};

describe('benchmark metrics', () => {
  it('scores only labeled content-match cases and reports coverage separately', () => {
    const metrics = metricsFor(cases, solution, 'contentMatch', 0.5);
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

  it('reports zero F1 when every positive prediction is wrong', () => {
    const metrics = metricsFor(
      cases,
      {
        ...solution,
        predictions: {
          ordinary: { ...solution.predictions.ordinary!, contentMatch: 0.9 },
          explicit: { ...solution.predictions.explicit!, contentMatch: 0.1 },
        },
      },
      'contentMatch',
      0.5,
    );
    expect(metrics).toMatchObject({
      truePositive: 0,
      falsePositive: 1,
      falseNegative: 1,
      precision: 0,
      recall: 0,
      f1: 0,
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
          ordinary: { contentMatch: 0.1, review: { contentMatch: 'right' } },
          explicit: { contentMatch: 0.9, review: { contentMatch: 'wrong' } },
          unknown: { review: { contentMatch: 'right' } },
        },
      }),
    );
    expect(reviewed.predictions.unknown?.review.contentMatch).toBe('unreviewed');
    expect(manualReviewFor(cases, reviewed)).toEqual({ right: 1, wrong: 1, pending: 0 });
  });
});

describe('benchmark data migration', () => {
  it('preserves a renamed matching task without hardcoding its former name', () => {
    const restored = normalizeBenchmarkState({
      cases: [{ ...cases[0], labels: { archivedQuestion: 'no', aiGenerated: 'yes' } }],
      thresholds: { archivedQuestion: 0.3, aiGenerated: 0.6, nsfwjs: 0.4 },
      solutions: [
        {
          id: 'saved-run',
          name: 'Saved run',
          predictions: {
            sample: {
              archivedQuestion: 0.2,
              aiGenerated: 0.8,
              review: { archivedQuestion: 'right', aiGenerated: 'wrong' },
            },
          },
        },
      ],
    });
    expect(restored.cases[0]!.labels).toEqual({ contentMatch: 'no', aiGenerated: 'yes' });
    expect(restored.thresholds.contentMatch).toBe(0.3);
    expect(restored.solutions[0]!.predictions.sample).toMatchObject({
      contentMatch: 0.2,
      aiGenerated: 0.8,
      review: { contentMatch: 'right', aiGenerated: 'wrong' },
    });
  });

  it('maps legacy positives, makes legacy negatives unknown, and omits incompatible scores', () => {
    const migrated = normalizeBenchmarkState({
      cases: [
        {
          id: 'legacy-positive',
          modality: 'text',
          title: 'Legacy positive',
          text: 'Old explicit label.',
          labels: { explicit: 'yes', aiGenerated: 'no' },
          notes: 'Keep this case.',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'legacy-negative',
          modality: 'text',
          title: 'Legacy negative',
          text: 'Old safe label.',
          labels: { explicit: 'no', aiGenerated: 'yes' },
          provenance: 'user-provided',
          notes: 'Keep this case too.',
          createdAt: '2026-01-02T00:00:00.000Z',
        },
        {
          id: 'current-unknown',
          modality: 'text',
          title: 'Current unknown',
          text: 'New policy label takes precedence.',
          labels: { contentMatch: 'unknown', explicit: 'yes', aiGenerated: 'unknown' },
          provenance: 'unknown',
          notes: '',
          createdAt: '2026-01-03T00:00:00.000Z',
        },
      ],
      solutions: [
        {
          id: 'saved-solution',
          name: 'Saved solution',
          description: 'Keep solution metadata.',
          kind: 'llm',
          predictions: {
            'legacy-positive': {
              explicit: 0.91,
              aiGenerated: 0.24,
              nsfwjs: { porn: 0.31, hentai: 0.42, sexy: 0.53, drawings: 0.64 },
              review: { explicit: 'right', aiGenerated: 'wrong', porn: 'right' },
            },
          },
        },
      ],
      thresholds: { explicit: 0.84, aiGenerated: 0.63, nsfwjs: 0.72 },
      selectedCaseId: 'legacy-negative',
    });
    const migratedSolution = migrated.solutions[0];
    if (!migratedSolution) throw new Error('Legacy solution was not migrated.');

    expect(migrated.cases.map((item) => item.id)).toEqual([
      'legacy-positive',
      'legacy-negative',
      'current-unknown',
    ]);
    expect(migrated.cases[0]).toMatchObject({
      labels: { contentMatch: 'yes', aiGenerated: 'no' },
      provenance: 'unknown',
      notes: 'Keep this case.',
    });
    expect(migrated.cases[1]).toMatchObject({
      labels: { contentMatch: 'unknown', aiGenerated: 'yes' },
      provenance: 'user-provided',
      notes: 'Keep this case too.',
    });
    expect(migrated.cases[2]?.labels.contentMatch).toBe('unknown');
    expect(migrated.selectedCaseId).toBe('legacy-negative');
    expect(migratedSolution).toMatchObject({
      id: 'saved-solution',
      name: 'Saved solution',
      description: 'Keep solution metadata.',
      predictions: {
        'legacy-positive': {
          contentMatch: null,
          aiGenerated: 0.24,
          nsfwjs: { porn: 0.31, hentai: 0.42, sexy: 0.53, drawings: 0.64 },
          review: { contentMatch: 'unreviewed', aiGenerated: 'wrong', porn: 'right' },
        },
      },
    });
    expect(migrated.thresholds).toEqual({
      contentMatch: 0.5,
      aiGenerated: 0.63,
      nsfwjs: 0.72,
    });
    expect(metricsFor(migrated.cases, migratedSolution, 'contentMatch', 0.5)).toMatchObject({
      labeled: 1,
      scored: 0,
      coverage: 0,
    });
  });

  it('exports current policy data without obsolete narrow labels', () => {
    const state = normalizeBenchmarkState({ cases, solutions: [solution] });
    const exported = JSON.parse(exportBenchmarkState(state));
    expect(exported.version).toBe(2);
    expect(exported.cases[0].labels).toEqual({ contentMatch: 'no', aiGenerated: 'no' });
    expect(exported.cases[0].labels).not.toHaveProperty('explicit');
    expect(exported.solutions[0].predictions.explicit.contentMatch).toBe(0.9);
  });
});

describe('benchmark data boundaries', () => {
  it('clamps imported scores and rejects incomplete solution files', () => {
    const imported = parseSolutionImport(
      JSON.stringify({
        name: 'Imported model',
        predictions: { safe: { contentMatch: 4, aiGenerated: -1 } },
      }),
    );
    expect(imported.predictions.safe).toEqual({
      contentMatch: 1,
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
      contentMatch: null,
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

  it('imports the new task score and does not relabel legacy explicit scores', () => {
    const imported = parseSolutionImport(
      JSON.stringify({
        name: 'Mixed-era model',
        predictions: {
          legacy: {
            explicit: 0.97,
            contentMatch: 0.38,
            aiGenerated: 0.21,
            review: { explicit: 'right', contentMatch: 'wrong' },
          },
          oldOnly: { explicit: 0.83, aiGenerated: 0.42, review: { explicit: 'right' } },
        },
      }),
    );

    expect(imported.predictions.legacy).toMatchObject({
      contentMatch: 0.38,
      aiGenerated: 0.21,
      review: { contentMatch: 'wrong' },
    });
    expect(imported.predictions.oldOnly).toMatchObject({
      contentMatch: null,
      aiGenerated: 0.42,
      review: { contentMatch: 'unreviewed' },
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
