import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const file = process.argv[2] || path.join(import.meta.dirname, 'ocr-results-all.json');
const results = JSON.parse(await readFile(file, 'utf8'));
/** Ignore punctuation, case, and repeated whitespace when comparing OCR transcripts. */
const normalize = (text) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
/** Calculate Levenshtein edits for either character strings or word arrays. */
function distance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++)
      next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + (a[i] === b[j] ? 0 : 1)));
    row = next;
  }
  return row[b.length];
}
const terms = new Set(['nude', 'nudes', 'naked', 'sex', 'sexual', 'explicit', 'porn']);
/** Aggregate transcript errors, exact sensitive-term recovery, and warm-run timings. */
function metrics(engine, subset) {
  let characters = 0,
    characterErrors = 0,
    words = 0,
    wordErrors = 0,
    termCount = 0,
    termsFound = 0,
    exact = 0;
  const timings = [];
  for (const sample of engine.samples) {
    const item = subset.find((item) => item.id === sample.id);
    if (!item || !item.expected) continue;
    const reference = normalize(item.expected),
      prediction = normalize(sample.runs[0].text);
    characterErrors += distance(reference, prediction);
    characters += reference.length;
    const refWords = reference.split(' '),
      predWords = prediction.split(' ');
    wordErrors += distance(refWords, predWords);
    words += refWords.length;
    if (reference === prediction) exact++;
    for (const term of refWords.filter((word) => terms.has(word))) {
      termCount++;
      if (predWords.includes(term)) termsFound++;
    }
    timings.push(...sample.runs.slice(1).map((run) => run.ms));
  }
  timings.sort((a, b) => a - b);
  return {
    images: timings.length / 2,
    exact,
    cer: characterErrors / characters,
    wer: wordErrors / words,
    termsFound,
    termCount,
    termRecall: termsFound / termCount,
    warmMeanMs: timings.reduce((a, b) => a + b, 0) / timings.length,
    warmMedianMs: timings[Math.floor(timings.length / 2)],
    warmP95Ms: timings[Math.ceil(timings.length * 0.95) - 1],
  };
}
for (const engine of results.engines) {
  engine.metrics = {
    screenshots: metrics(
      engine,
      results.cases.filter((item) => !item.singleLine),
    ),
    singleLines: metrics(
      engine,
      results.cases.filter((item) => item.singleLine),
    ),
    noTextOutput: engine.samples.find((item) => item.id === 'no-text')?.runs[0].text,
    firstUseMs: engine.initMs + (engine.samples[0]?.runs[0].ms || 0),
  };
}
await writeFile(file, `${JSON.stringify(results, null, 2)}\n`);
console.log(
  JSON.stringify(
    results.engines.map(({ id, error, metrics }) => ({ id, error, metrics })),
    null,
    2,
  ),
);
