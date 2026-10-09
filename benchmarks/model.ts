import { flow, Option, Predicate } from 'effect';
import * as Schema from 'effect/Schema';

export type BenchmarkModality = 'image' | 'text';

export type TruthValue = 'yes' | 'no' | 'unknown';

export type BenchmarkTask = 'contentMatch' | 'aiGenerated';

export type BenchmarkProvenance = 'synthetic-ai' | 'user-reported' | 'user-provided' | 'unknown';

export type NsfwjsTask = 'porn' | 'hentai' | 'sexy' | 'drawings';

export type ScoreKey = BenchmarkTask | NsfwjsTask;

export type SolutionKind = 'llm' | 'nsfwjs' | 'other';

export type ReviewVerdict = 'unreviewed' | 'right' | 'wrong';

export type PredictionReview = Record<ScoreKey, ReviewVerdict>;

export interface BenchmarkLabels {
  contentMatch: TruthValue;
  aiGenerated: TruthValue;
}

export interface BenchmarkCase {
  id: string;
  modality: BenchmarkModality;
  title: string;
  imageUrl?: string;
  text?: string;
  labels: BenchmarkLabels;
  provenance: BenchmarkProvenance;
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
  contentMatch: number | null;
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
  contentMatch: number;
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
  contentMatch: 'Content match',
  aiGenerated: 'AI-generated',
};

export const CONTENT_MATCH_POLICY =
  'Positive: explicit acts, lewd innuendo, heavily implied intimate activity, and engagement bait designed to arouse. ' +
  'Negative: factual health, news, and relationship discussion without explicit solicitation or arousal-focused framing.';

export const PROVENANCE_LABELS: Record<BenchmarkProvenance, string> = {
  'synthetic-ai': 'Synthetic · AI-authored',
  'user-reported': 'User-reported',
  'user-provided': 'User-provided · source unverified',
  unknown: 'Provenance unknown',
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

const SCORE_KEYS: ScoreKey[] = [
  'contentMatch',
  'aiGenerated',
  'porn',
  'hentai',
  'sexy',
  'drawings',
];

export function initialBenchmarkState(): BenchmarkState {
  return {
    cases: [
      {
        id: 'false-positive-hentai-trails-sky-2nd',
        modality: 'image',
        title: 'Trails in the Sky — reported false positive',
        imageUrl: './images/false-positive-hentai-trails-sky-2nd.webp',
        labels: { contentMatch: 'unknown', aiGenerated: 'unknown' },
        provenance: 'user-reported',
        notes:
          'User-reported NSFWJS false positive. Content match remains unknown until reviewed under the broader policy.',
        createdAt: '2026-09-19T17:36:19.000Z',
      },
      {
        id: 'ordinary-anime-drawing-control',
        modality: 'image',
        title: 'Anime action illustration — ordinary control',
        imageUrl: './images/HSfziiNasAAPoDe',
        labels: { contentMatch: 'no', aiGenerated: 'unknown' },
        provenance: 'unknown',
        notes:
          'Bundled anime-style action illustration with no explicit solicitation or arousal framing. Image authorship is unknown.',
        createdAt: '2026-09-29T00:00:00.000Z',
      },
      {
        id: 'text-explicit-solicitation',
        modality: 'text',
        title: 'Direct explicit solicitation',
        text: 'I want to have sex with you tonight. DM me if you want the details.',
        labels: { contentMatch: 'yes', aiGenerated: 'yes' },
        provenance: 'synthetic-ai',
        notes:
          'Synthetic AI-authored benchmark text. Positive because it directly solicits sex; AI origin is recorded provenance, not a style judgment.',
        createdAt: '2026-09-29T00:00:00.000Z',
      },
      {
        id: 'text-innuendo',
        modality: 'text',
        title: 'Suggestive innuendo',
        text: 'I asked if she wanted to stay over; she smiled and said, “Only if you can keep up after midnight.”',
        labels: { contentMatch: 'yes', aiGenerated: 'yes' },
        provenance: 'synthetic-ai',
        notes:
          'Synthetic AI-authored benchmark text. Positive for lewd innuendo rather than an explicit description.',
        createdAt: '2026-09-29T00:00:00.000Z',
      },
      {
        id: 'text-arousal-engagement-bait',
        modality: 'text',
        title: 'Arousal-focused engagement bait',
        text: 'This outfit leaves just enough to the imagination—tap for the reveal and tell me what you would do if I were beside you.',
        labels: { contentMatch: 'yes', aiGenerated: 'yes' },
        provenance: 'synthetic-ai',
        notes:
          'Synthetic AI-authored benchmark text. Positive because it uses suggestive bait to solicit attention and replies.',
        createdAt: '2026-09-29T00:00:00.000Z',
      },
      {
        id: 'text-reproductive-health-guide',
        modality: 'text',
        title: 'Factual reproductive-health guidance',
        text: 'The clinic’s guide covers HPV vaccination, STI screening, and when to ask a clinician for advice.',
        labels: { contentMatch: 'no', aiGenerated: 'yes' },
        provenance: 'synthetic-ai',
        notes:
          'Synthetic AI-authored benchmark text. Negative: factual reproductive-health information without solicitation or arousal framing.',
        createdAt: '2026-09-29T00:00:00.000Z',
      },
      {
        id: 'text-reproductive-health-news',
        modality: 'text',
        title: 'Explicit-health service news',
        text: 'The city health department opened two reproductive-health clinics; its bulletin lists testing hours and vaccination availability.',
        labels: { contentMatch: 'no', aiGenerated: 'yes' },
        provenance: 'synthetic-ai',
        notes:
          'Synthetic AI-authored benchmark text. Negative: factual public-health news is not explicit solicitation.',
        createdAt: '2026-09-29T00:00:00.000Z',
      },
      {
        id: 'text-relationship-consent',
        modality: 'text',
        title: 'Relationship and consent advice',
        text: 'A couples counselor recommends checking in about consent, comfort, and boundaries before either partner takes a new step.',
        labels: { contentMatch: 'no', aiGenerated: 'yes' },
        provenance: 'synthetic-ai',
        notes:
          'Synthetic AI-authored benchmark text. Negative: non-erotic relationship advice should not be blocked as explicit content.',
        createdAt: '2026-09-29T00:00:00.000Z',
      },
      {
        id: 'text-borderline-after-hours',
        modality: 'text',
        title: 'Borderline after-hours teaser',
        text: 'They said the last chapter is “better after dark” and told me not to ask what happens next.',
        labels: { contentMatch: 'unknown', aiGenerated: 'yes' },
        provenance: 'synthetic-ai',
        notes:
          'Synthetic AI-authored borderline case. Intentionally unknown until human review: it may be playful innuendo or an ordinary story teaser.',
        createdAt: '2026-09-29T00:00:00.000Z',
      },
      {
        id: 'text-borderline-health-teaser',
        modality: 'text',
        title: 'Borderline clinic campaign teaser',
        text: 'Our new clinic series has hot takes on personal questions—watch tonight and share the post.',
        labels: { contentMatch: 'unknown', aiGenerated: 'yes' },
        provenance: 'synthetic-ai',
        notes:
          'Synthetic AI-authored borderline case. Intentionally unknown until human review: “hot takes” may be ordinary health promotion or arousal-focused bait.',
        createdAt: '2026-09-29T00:00:00.000Z',
      },
    ],
    solutions: [],
    thresholds: { contentMatch: 0.5, aiGenerated: 0.5, nsfwjs: 0.5 },
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
    contentMatch: 'unreviewed',
    aiGenerated: 'unreviewed',
    porn: 'unreviewed',
    hentai: 'unreviewed',
    sexy: 'unreviewed',
    drawings: 'unreviewed',
  };
}

export function emptyPrediction(): Prediction {
  return {
    contentMatch: null,
    aiGenerated: null,
    nsfwjs: emptyNsfwjsScores(),
    review: emptyPredictionReview(),
  };
}

const truthValue = flow(
  Schema.decodeUnknownOption(Schema.Literals(['yes', 'no', 'unknown'])),
  Option.getOrElse(() => 'unknown' as const),
);

const score = flow(
  Schema.decodeUnknownOption(Schema.Finite),
  Option.map((value) => Math.min(1, Math.max(0, value))),
  Option.getOrElse(() => null),
);

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This boundary validates untrusted data before exposing domain values.
function normalizeNsfwjsScores(value: unknown): NsfwjsScores {
  if (!Predicate.isObject(value)) return emptyNsfwjsScores();
  const scores = value;

  return {
    porn: score(scores.porn),
    hentai: score(scores.hentai),
    sexy: score(scores.sexy),
    drawings: score(scores.drawings),
  };
}

function matchingTaskValue<T>(record: Record<string, T>, previousTaskKey?: string): T | undefined {
  if (Object.hasOwn(record, 'contentMatch')) return record.contentMatch;

  if (previousTaskKey && Object.hasOwn(record, previousTaskKey)) return record[previousTaskKey];

  const candidates = Object.keys(record).filter(
    (key) => ![...SCORE_KEYS, 'nsfwjs', 'explicit', 'review', 'reviews'].includes(key),
  );

  return candidates.length === 1 ? record[candidates[0]!] : undefined;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This boundary validates untrusted data before exposing domain values.
function normalizeReview(value: unknown, previousTaskKey?: string): PredictionReview {
  if (!Predicate.isObject(value)) return emptyPredictionReview();
  const review = value;

  const verdict = flow(
    Schema.decodeUnknownOption(Schema.Literals(['right', 'wrong'])),
    Option.getOrElse(() => 'unreviewed' as const),
  );

  return {
    contentMatch: verdict(matchingTaskValue(review, previousTaskKey)),
    aiGenerated: verdict(review.aiGenerated),
    porn: verdict(review.porn),
    hentai: verdict(review.hentai),
    sexy: verdict(review.sexy),
    drawings: verdict(review.drawings),
  };
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This boundary validates untrusted data before exposing domain values.
function normalizePrediction(value: unknown, previousTaskKey?: string): Prediction {
  if (!Predicate.isObject(value)) return emptyPrediction();
  const prediction = value;
  const contentMatch = score(matchingTaskValue(prediction, previousTaskKey));
  const aiGenerated = score(prediction.aiGenerated);
  const nsfwjs = normalizeNsfwjsScores(prediction.nsfwjs ?? prediction);
  const review = normalizeReview(prediction.review ?? prediction.reviews, previousTaskKey);

  if (contentMatch === null) review.contentMatch = 'unreviewed';

  if (aiGenerated === null) review.aiGenerated = 'unreviewed';

  if (nsfwjs.porn === null) review.porn = 'unreviewed';

  if (nsfwjs.hentai === null) review.hentai = 'unreviewed';

  if (nsfwjs.sexy === null) review.sexy = 'unreviewed';

  if (nsfwjs.drawings === null) review.drawings = 'unreviewed';

  return { contentMatch, aiGenerated, nsfwjs, review };
}

const benchmarkProvenance = flow(
  Schema.decodeUnknownOption(
    Schema.Literals(['synthetic-ai', 'user-reported', 'user-provided', 'unknown']),
  ),
  Option.getOrElse(() => 'unknown' as const),
);

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This boundary validates untrusted data before exposing domain values.
function normalizeCase(value: unknown, previousTaskKey?: string): BenchmarkCase | null {
  if (!Predicate.isObject(value)) return null;
  const item = value;

  if (!Schema.is(Schema.String)(item.id) || !Schema.is(Schema.String)(item.title)) return null;
  const labels = Predicate.isObject(item.labels) ? item.labels : null;
  let contentMatch: TruthValue = 'unknown';

  if (labels) {
    const savedLabel = matchingTaskValue(labels, previousTaskKey);

    if (savedLabel !== undefined) contentMatch = truthValue(savedLabel);
    else if (labels.explicit === 'yes') contentMatch = 'yes';
  }

  const modality = item.modality === 'text' ? 'text' : 'image';

  const normalized: BenchmarkCase = {
    id: item.id,
    modality,
    title: item.title,
    labels: { contentMatch, aiGenerated: labels ? truthValue(labels.aiGenerated) : 'unknown' },
    provenance: benchmarkProvenance(item.provenance),
    notes: Schema.is(Schema.String)(item.notes) ? item.notes : '',
    createdAt: Schema.is(Schema.String)(item.createdAt) ? item.createdAt : new Date().toISOString(),
  };

  if (Schema.is(Schema.String)(item.imageUrl)) normalized.imageUrl = item.imageUrl;

  if (Schema.is(Schema.String)(item.text)) normalized.text = item.text;

  return normalized;
}

const solutionKind = flow(
  Schema.decodeUnknownOption(Schema.Literals(['llm', 'nsfwjs', 'other'])),
  Option.getOrElse(() => 'other' as const),
);

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This boundary validates untrusted data before exposing domain values.
function normalizeSolution(value: unknown, previousTaskKey?: string): BenchmarkSolution | null {
  if (!Predicate.isObject(value)) return null;
  const item = value;

  if (!Schema.is(Schema.String)(item.id) || !Schema.is(Schema.String)(item.name)) return null;
  const rawPredictions = Predicate.isObject(item.predictions) ? item.predictions : {};

  return {
    id: item.id,
    name: item.name,
    description: Schema.is(Schema.String)(item.description) ? item.description : '',
    kind: solutionKind(item.kind ?? item.type),
    predictions: Object.fromEntries(
      Object.entries(rawPredictions).map(([caseId, prediction]) => [
        caseId,
        normalizePrediction(prediction, previousTaskKey),
      ]),
    ),
  };
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This boundary validates untrusted data before exposing domain values.
export function normalizeBenchmarkState(value: unknown): BenchmarkState {
  const fallback = initialBenchmarkState();

  if (!Predicate.isObject(value)) return fallback;
  const state = value;
  const rawThresholds = Predicate.isObject(state.thresholds) ? state.thresholds : {};

  const previousTaskKeys = Object.keys(rawThresholds).filter(
    (key) => !['contentMatch', 'aiGenerated', 'nsfwjs', 'explicit'].includes(key),
  );

  // Older snapshots used a different name for the sole content-matching task.
  const previousTaskKey = previousTaskKeys.length === 1 ? previousTaskKeys[0] : undefined;

  const cases = Array.isArray(state.cases)
    ? state.cases
        .map((item) => normalizeCase(item, previousTaskKey))
        .filter((item): item is BenchmarkCase => item !== null)
    : fallback.cases;

  const solutions = Array.isArray(state.solutions)
    ? state.solutions
        .map((item) => normalizeSolution(item, previousTaskKey))
        .filter((item): item is BenchmarkSolution => item !== null)
    : fallback.solutions;

  const selectedCaseId =
    Schema.is(Schema.String)(state.selectedCaseId) &&
    cases.some((item) => item.id === state.selectedCaseId)
      ? state.selectedCaseId
      : (cases[0]?.id ?? null);

  return {
    cases,
    solutions,
    thresholds: {
      contentMatch:
        score(matchingTaskValue(rawThresholds, previousTaskKey)) ??
        fallback.thresholds.contentMatch,
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
  return task === 'contentMatch' || task === 'aiGenerated'
    ? prediction[task]
    : prediction.nsfwjs[task];
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
  const f1 = ratio(2 * truePositive, 2 * truePositive + falsePositive + falseNegative);

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

  if (!Predicate.isObject(parsed)) {
    throw new Error('Solution JSON needs a non-empty "name".');
  }

  const payload = parsed;

  if (!Schema.is(Schema.String)(payload.name) || !payload.name.trim()) {
    throw new Error('Solution JSON needs a non-empty "name".');
  }

  if (!Predicate.isObject(payload.predictions)) {
    throw new Error('Solution JSON needs a "predictions" object keyed by case ID.');
  }

  const predictions = payload.predictions;

  return {
    id: createId('solution'),
    name: payload.name.trim(),
    description: Schema.is(Schema.String)(payload.description)
      ? payload.description
      : 'Imported result set',
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
  return JSON.stringify({ version: 2, exportedAt: new Date().toISOString(), ...state }, null, 2);
}

export function formatMetric(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}
