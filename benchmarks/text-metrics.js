const LENGTH_BINS = ['0-39', '40-79', '80-139', '140-280'];

function confusion(cases, byId, threshold) {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (const item of cases) {
    const score = byId.get(item.id)?.aiProbability;
    if (!Number.isFinite(score)) continue;
    const actual = item.labels.aiGenerated === 'yes';
    const predicted = score >= threshold;
    if (actual && predicted) tp += 1;
    else if (actual) fn += 1;
    else if (predicted) fp += 1;
    else tn += 1;
  }
  const divide = (a, b) => (b === 0 ? null : a / b);
  const precision = divide(tp, tp + fp);
  const recall = divide(tp, tp + fn);
  const f1Denominator = 2 * tp + fp + fn;
  return {
    n: tp + fp + tn + fn,
    tp,
    fp,
    tn,
    fn,
    accuracy: divide(tp + tn, tp + fp + tn + fn),
    precision,
    recall,
    specificity: divide(tn, tn + fp),
    f1: f1Denominator === 0 ? null : (2 * tp) / f1Denominator,
  };
}

function auc(cases, byId) {
  const positives = [];
  const negatives = [];
  for (const item of cases) {
    const score = byId.get(item.id)?.aiProbability;
    if (!Number.isFinite(score)) continue;
    (item.labels.aiGenerated === 'yes' ? positives : negatives).push(score);
  }
  if (positives.length === 0 || negatives.length === 0) return null;
  let wins = 0;
  let ties = 0;
  for (const positive of positives) {
    for (const negative of negatives) {
      if (positive > negative) wins += 1;
      else if (positive === negative) ties += 1;
    }
  }
  return (wins + ties / 2) / (positives.length * negatives.length);
}

function latencySummary(rows) {
  const values = rows
    .map((row) => row.inferenceMs)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (values.length === 0) return { n: 0, meanMs: null, medianMs: null, p95Ms: null };
  const middle = Math.floor(values.length / 2);
  return {
    n: values.length,
    meanMs: values.reduce((sum, value) => sum + value, 0) / values.length,
    medianMs: values.length % 2 === 0 ? (values[middle - 1] + values[middle]) / 2 : values[middle],
    p95Ms: values[Math.max(0, Math.ceil(values.length * 0.95) - 1)],
  };
}

export function calculateMetrics(items, rows, threshold = 0.5) {
  const byId = new Map(rows.map((row) => [row.caseId, row]));
  const scored = items.filter((item) => Number.isFinite(byId.get(item.id)?.aiProbability));
  const lengthBins = Object.fromEntries(
    LENGTH_BINS.map((bin) => {
      const cases = scored.filter((item) => item.lengthBin === bin);
      return [bin, { ...confusion(cases, byId, threshold), auc: auc(cases, byId) }];
    }),
  );
  const under80Characters = scored.filter((item) => item.charCount < 80);
  return {
    threshold,
    overall: { ...confusion(scored, byId, threshold), auc: auc(scored, byId) },
    lengthBins,
    under80Characters: {
      ...confusion(under80Characters, byId, threshold),
      auc: auc(under80Characters, byId),
    },
    latency: latencySummary(rows),
  };
}
