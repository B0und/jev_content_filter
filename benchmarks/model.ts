export type BenchmarkModality = 'image' | 'text';
export type TruthValue = 'yes' | 'no' | 'unknown';
export type BenchmarkTask = 'explicit' | 'aiGenerated';
export type NsfwjsTask = 'porn' | 'hentai' | 'sexy' | 'drawings';
export type ScoreKey = BenchmarkTask | NsfwjsTask;
export type SolutionKind = 'llm' | 'nsfwjs' | 'other';
export type ReviewVerdict = 'unreviewed' | 'right' | 'wrong';
export type PredictionReview = Record<ScoreKey, ReviewVerdict>;
export interface BenchmarkLabels {
  explicit: TruthValue;
  aiGenerated: TruthValue;
}

export interface BenchmarkCase {
  id: string;
  modality: BenchmarkModality;
  title: string;
  imageUrl?: string;
  text?: string;
  labels: BenchmarkLabels;
  notes: string;
  createdAt: string;
}

export interface NsfwjsScores {
  porn: number | null;
  hentai: number | null;
  sexy: number | null;
  drawings: number | null;
}

export interface Prediction {
  explicit: number | null;
  aiGenerated: number | null;
  nsfwjs: NsfwjsScores;
  review: PredictionReview;
}

export interface BenchmarkSolution {
  id: string;
  name: string;
  description: string;
  kind: SolutionKind;
  predictions: Record<string, Prediction>;
}

export interface BenchmarkThresholds {
  explicit: number;
  aiGenerated: number;
  nsfwjs: number;
}

export interface BenchmarkState {
  cases: BenchmarkCase[];
  solutions: BenchmarkSolution[];
  thresholds: BenchmarkThresholds;
  selectedCaseId: string | null;
}

export interface TaskMetrics {
  labeled: number;
  scored: number;
  truePositive: number;
  falsePositive: number;
  trueNegative: number;
  falseNegative: number;
  coverage: number;
  accuracy: number | null;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

export interface ManualReviewMetrics {
  right: number;
  wrong: number;
  pending: number;
}

export const TASK_LABELS: Record<BenchmarkTask, string> = {
  explicit: 'Explicit',
  aiGenerated: 'AI-generated',
};
export const NSFWJS_LABELS: Record<NsfwjsTask, string> = {
  porn: 'Porn',
  hentai: 'Hentai',
  sexy: 'Sexy',
  drawings: 'Drawings',
};
export const SOLUTION_KIND_LABELS: Record<SolutionKind, string> = {
  llm: 'LLM',
  nsfwjs: 'NSFWJS',
  other: 'Other',
};
const SCORE_KEYS: ScoreKey[] = ['explicit', 'aiGenerated', 'porn', 'hentai', 'sexy', 'drawings'];

export function initialBenchmarkState(): BenchmarkState {
  return {
    cases: [
      {
        id: 'false-positive-hentai-trails-sky-2nd',
        modality: 'image',
        title: 'Trails in the Sky — reported false positive',
        imageUrl: './images/false-positive-hentai-trails-sky-2nd.webp',
        labels: { explicit: 'no', aiGenerated: 'unknown' },
        notes: 'User-reported false positive for hentai detection.',
        createdAt: '2026-09-19T17:36:19.000Z',
      },
      {
        id: 'text-safe-garden',
        modality: 'text',
        title: 'Calm garden post',
        text: 'A calm afternoon in the garden.',
        labels: { explicit: 'no', aiGenerated: 'unknown' },
        notes: 'Neutral text control.',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'text-review-needed',
        modality: 'text',
        title: 'Text sample awaiting review',
        text: 'Add a real text example here, then mark the human labels.',
        labels: { explicit: 'unknown', aiGenerated: 'unknown' },
        notes: 'Use this as a template for the first text benchmark cases.',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    solutions: [],
    thresholds: { explicit: 0.5, aiGenerated: 0.5, nsfwjs: 0.5 },
    selectedCaseId: 'false-positive-hentai-trails-sky-2nd',
  };
}

export function createId(prefix: string): string {
  const randomUuid =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : null;
  return `${prefix}-${randomUuid ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

export function createSolution(
  name: string,
  description = '',
  kind: SolutionKind = 'other',
): BenchmarkSolution {
  return {
    id: createId('solution'),
    name: name.trim(),
    description: description.trim(),
    kind,
    predictions: {},
  };
}

export function emptyNsfwjsScores(): NsfwjsScores {
  return { porn: null, hentai: null, sexy: null, drawings: null };
}

export function emptyPredictionReview(): PredictionReview {
  return {
    explicit: 'unreviewed',
    aiGenerated: 'unreviewed',
    porn: 'unreviewed',
    hentai: 'unreviewed',
    sexy: 'unreviewed',
    drawings: 'unreviewed',
  };
}

export function emptyPrediction(): Prediction {
  return {
    explicit: null,
    aiGenerated: null,
    nsfwjs: emptyNsfwjsScores(),
    review: emptyPredictionReview(),
  };
}

function truthValue(value: unknown): TruthValue {
  return value === 'yes' || value === 'no' || value === 'unknown' ? value : 'unknown';
}

function score(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : null;
}

function normalizeNsfwjsScores(value: unknown): NsfwjsScores {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return emptyNsfwjsScores();
  const scores = value as Record<string, unknown>;
  return {
    porn: score(scores.porn),
    hentai: score(scores.hentai),
    sexy: score(scores.sexy),
    drawings: score(scores.drawings),
  };
}

function normalizeReview(value: unknown): PredictionReview {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return emptyPredictionReview();
  const review = value as Record<string, unknown>;
  const verdict = (entry: unknown): ReviewVerdict =>
    entry === 'right' || entry === 'wrong' ? entry : 'unreviewed';
  return {
    explicit: verdict(review.explicit),
    aiGenerated: verdict(review.aiGenerated),
    porn: verdict(review.porn),
    hentai: verdict(review.hentai),
    sexy: verdict(review.sexy),
    drawings: verdict(review.drawings),
  };
}

function normalizePrediction(value: unknown): Prediction {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return emptyPrediction();
  const prediction = value as Record<string, unknown>;
  const explicit = score(prediction.explicit);
  const aiGenerated = score(prediction.aiGenerated);
  const nsfwjs = normalizeNsfwjsScores(prediction.nsfwjs ?? prediction);
  const review = normalizeReview(prediction.review ?? prediction.reviews);
  if (explicit === null) review.explicit = 'unreviewed';
  if (aiGenerated === null) review.aiGenerated = 'unreviewed';
  if (nsfwjs.porn === null) review.porn = 'unreviewed';
  if (nsfwjs.hentai === null) review.hentai = 'unreviewed';
  if (nsfwjs.sexy === null) review.sexy = 'unreviewed';
  if (nsfwjs.drawings === null) review.drawings = 'unreviewed';
  return { explicit, aiGenerated, nsfwjs, review };
}

function normalizeCase(value: unknown): BenchmarkCase | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== 'string' || typeof item.title !== 'string') return null;
  const labels =
    item.labels !== null && typeof item.labels === 'object' && !Array.isArray(item.labels)
      ? (item.labels as Record<string, unknown>)
      : null;
  const modality = item.modality === 'text' ? 'text' : 'image';
  return {
    id: item.id,
    modality,
    title: item.title,
    imageUrl: typeof item.imageUrl === 'string' ? item.imageUrl : undefined,
    text: typeof item.text === 'string' ? item.text : undefined,
    labels: labels
      ? { explicit: truthValue(labels.explicit), aiGenerated: truthValue(labels.aiGenerated) }
      : { explicit: 'unknown', aiGenerated: 'unknown' },
    notes: typeof item.notes === 'string' ? item.notes : '',
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
  };
}

function solutionKind(value: unknown): SolutionKind {
  return value === 'llm' || value === 'nsfwjs' || value === 'other' ? value : 'other';
}

function normalizeSolution(value: unknown): BenchmarkSolution | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== 'string' || typeof item.name !== 'string') return null;
  const rawPredictions =
    item.predictions !== null &&
    typeof item.predictions === 'object' &&
    !Array.isArray(item.predictions)
      ? (item.predictions as Record<string, unknown>)
      : {};
  return {
    id: item.id,
    name: item.name,
    description: typeof item.description === 'string' ? item.description : '',
    kind: solutionKind(item.kind ?? item.type),
    predictions: Object.fromEntries(
      Object.entries(rawPredictions).map(([caseId, prediction]) => [
        caseId,
        normalizePrediction(prediction),
      ]),
    ),
  };
}

export function normalizeBenchmarkState(value: unknown): BenchmarkState {
  const fallback = initialBenchmarkState();
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fallback;
  const state = value as Record<string, unknown>;
  const cases = Array.isArray(state.cases)
    ? state.cases.map(normalizeCase).filter((item): item is BenchmarkCase => item !== null)
    : fallback.cases;
  const solutions = Array.isArray(state.solutions)
    ? state.solutions
        .map(normalizeSolution)
        .filter((item): item is BenchmarkSolution => item !== null)
    : fallback.solutions;
  const rawThresholds =
    state.thresholds !== null &&
    typeof state.thresholds === 'object' &&
    !Array.isArray(state.thresholds)
      ? (state.thresholds as Record<string, unknown>)
      : {};
  const selectedCaseId =
    typeof state.selectedCaseId === 'string' &&
    cases.some((item) => item.id === state.selectedCaseId)
      ? state.selectedCaseId
      : (cases[0]?.id ?? null);
  return {
    cases,
    solutions,
    thresholds: {
      explicit: score(rawThresholds.explicit) ?? fallback.thresholds.explicit,
      aiGenerated: score(rawThresholds.aiGenerated) ?? fallback.thresholds.aiGenerated,
      nsfwjs: score(rawThresholds.nsfwjs) ?? fallback.thresholds.nsfwjs,
    },
    selectedCaseId,
  };
}

export function predictionFor(solution: BenchmarkSolution, caseId: string): Prediction {
  return solution.predictions[caseId] ?? emptyPrediction();
}
export function predictionScore(prediction: Prediction, task: ScoreKey): number | null {
  return task === 'explicit' || task === 'aiGenerated' ? prediction[task] : prediction.nsfwjs[task];
}

export function manualReviewFor(
  cases: BenchmarkCase[],
  solution: BenchmarkSolution,
): ManualReviewMetrics {
  const metrics: ManualReviewMetrics = { right: 0, wrong: 0, pending: 0 };
  for (const item of cases) {
    const prediction = predictionFor(solution, item.id);
    for (const task of SCORE_KEYS) {
      if (predictionScore(prediction, task) === null) continue;
      const verdict = prediction.review[task];
      if (verdict === 'right') metrics.right++;
      else if (verdict === 'wrong') metrics.wrong++;
      else metrics.pending++;
    }
  }
  return metrics;
}

export function predictionLabel(
  value: number | null,
  threshold: number,
): 'positive' | 'negative' | 'missing' {
  if (value === null || !Number.isFinite(value)) return 'missing';
  return value >= threshold ? 'positive' : 'negative';
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

export function metricsFor(
  cases: BenchmarkCase[],
  solution: BenchmarkSolution,
  task: BenchmarkTask,
  threshold: number,
): TaskMetrics {
  let truePositive = 0;
  let falsePositive = 0;
  let trueNegative = 0;
  let falseNegative = 0;
  let labeled = 0;
  let scored = 0;
  for (const item of cases) {
    const truth = item.labels[task];
    const value = solution.predictions[item.id]?.[task] ?? null;
    if (truth === 'unknown') continue;
    labeled++;
    if (value === null) continue;
    scored++;
    const positive = value >= threshold;
    if (truth === 'yes' && positive) truePositive++;
    else if (truth === 'yes') falseNegative++;
    else if (positive) falsePositive++;
    else trueNegative++;
  }
  const accuracy = ratio(truePositive + trueNegative, scored);
  const precision = ratio(truePositive, truePositive + falsePositive);
  const recall = ratio(truePositive, truePositive + falseNegative);
  const f1 =
    precision === null || recall === null || precision + recall === 0
      ? null
      : (2 * precision * recall) / (precision + recall);
  return {
    labeled,
    scored,
    truePositive,
    falsePositive,
    trueNegative,
    falseNegative,
    coverage: labeled === 0 ? 0 : scored / labeled,
    accuracy,
    precision,
    recall,
    f1,
  };
}

export function parseSolutionImport(input: string): BenchmarkSolution {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error('Solution file is not valid JSON.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Solution JSON needs a non-empty "name".');
  }
  const payload = parsed as Record<string, unknown>;
  if (typeof payload.name !== 'string' || !payload.name.trim()) {
    throw new Error('Solution JSON needs a non-empty "name".');
  }
  if (
    payload.predictions === null ||
    typeof payload.predictions !== 'object' ||
    Array.isArray(payload.predictions)
  ) {
    throw new Error('Solution JSON needs a "predictions" object keyed by case ID.');
  }
  const predictions = payload.predictions as Record<string, unknown>;
  return {
    id: createId('solution'),
    name: payload.name.trim(),
    description:
      typeof payload.description === 'string' ? payload.description : 'Imported result set',
    kind: solutionKind(payload.kind ?? payload.type),
    predictions: Object.fromEntries(
      Object.entries(predictions).map(([caseId, prediction]) => [
        caseId,
        normalizePrediction(prediction),
      ]),
    ),
  };
}

export function exportBenchmarkState(state: BenchmarkState): string {
  return JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), ...state }, null, 2);
}

export function formatMetric(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}
