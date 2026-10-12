import { env, pipeline } from '@huggingface/transformers';
import { calculateMetrics } from './text-metrics.js';

const THRESHOLD = 0.5;

const MODEL_CANDIDATES = [
  {
    name: 'E5 small LoRA AI text detector q8',
    id: 'onnx-community/e5-small-lora-ai-generated-detector-ONNX',
    revision: '02919a911bb647ceac84de99afb00ea2da8c2725',
    aiLabelId: 1,
    weightsBytes: 34_157_539,
    license: 'MIT on the upstream MayZhou model card; converted ONNX card omits license metadata',
  },
  {
    name: 'TMR RoBERTa-base AI text detector q8',
    id: 'onnx-community/tmr-ai-text-detector-ONNX',
    revision: 'b9aa251e5bcda7e429fcc936767d921435945b60',
    aiLabelId: 1,
    weightsBytes: 125_855_418,
    license: 'MIT',
  },
];

const status = document.querySelector('#status');

const summary = document.querySelector('#summary');

const runButton = document.querySelector('#run');

const downloadButton = document.querySelector('#download');

const corpus = await fetch('./text-cases.json').then(async (response) => {
  if (!response.ok) throw new Error(`Could not load corpus (${response.status})`);

  return response.json();
});

if (corpus.cases.length !== 120 || corpus.cases.some((item) => item.charCount > 280)) {
  throw new Error(
    'Expected the pinned 120-case tweet corpus, with every case at most 280 characters.',
  );
}

// A single WASM worker makes the measurements repeatable and does not require cross-origin isolation.
env.allowRemoteModels = true;

env.allowLocalModels = false;

env.useBrowserCache = true;

env.backends.onnx.wasm.numThreads = 1;

env.backends.onnx.wasm.proxy = false;

function classId(label) {
  const value = String(label).trim().toLowerCase();

  if (value === 'ai' || value.includes('generated')) return 1;

  if (value === 'human' || value.includes('real')) return 0;
  const match = value.match(/(?:label[_ -]?)?([01])$/);

  return match ? Number(match[1]) : null;
}

function aiProbability(output, aiLabelId) {
  const rows = Array.isArray(output) ? output.flat() : [output];
  const selected = rows.find((item) => classId(item.label) === aiLabelId);

  if (selected && Number.isFinite(selected.score)) return selected.score;
  const top = rows[0];
  const topId = top ? classId(top.label) : null;

  if (top && Number.isFinite(top.score) && topId !== null) {
    return topId === aiLabelId ? top.score : 1 - top.score;
  }

  throw new Error(`Cannot map classifier output to AI label: ${JSON.stringify(output)}`);
}

function importSolution(candidate, rows) {
  return {
    name: candidate.name,
    description: `${candidate.id}@${candidate.revision}, ONNX q8, AI probability from class 1; benchmarked in Chromium CPU/WASM.`,
    kind: 'other',
    predictions: Object.fromEntries(
      rows.map((row) => [
        row.caseId,
        { aiGenerated: Number.isFinite(row.aiProbability) ? row.aiProbability : null },
      ]),
    ),
  };
}

async function runCandidate(candidate) {
  status.textContent = `Downloading/loading ${candidate.name}…`;
  const loadStart = performance.now();

  const classifier = await pipeline('text-classification', candidate.id, {
    revision: candidate.revision,
    dtype: 'q8',
    progress_callback: (progress) => {
      if (progress.status === 'progress' && progress.total) {
        const percentage = Math.round((progress.loaded / progress.total) * 100);
        status.textContent = `Loading ${candidate.name}: ${percentage}%`;
      }
    },
  });

  const loadMs = performance.now() - loadStart;

  const warmupStart = performance.now();
  await classifier('Warm-up only. This sentence is excluded from the benchmark.', { top_k: 2 });
  const warmupMs = performance.now() - warmupStart;

  const predictions = [];

  for (let index = 0; index < corpus.cases.length; index += 1) {
    const item = corpus.cases[index];
    status.textContent = `${candidate.name}: ${index + 1}/${corpus.cases.length}`;
    const started = performance.now();

    try {
      const output = await classifier(item.text, { top_k: 2 });
      const inferenceMs = performance.now() - started;
      predictions.push({
        caseId: item.id,
        text: item.text,
        actual: item.labels.aiGenerated,
        provenance: item.provenance,
        charCount: item.charCount,
        aiProbability: aiProbability(output, candidate.aiLabelId),
        rawOutput: output,
        inferenceMs,
        error: null,
      });
    } catch (error) {
      predictions.push({
        caseId: item.id,
        text: item.text,
        actual: item.labels.aiGenerated,
        provenance: item.provenance,
        charCount: item.charCount,
        aiProbability: null,
        rawOutput: null,
        inferenceMs: performance.now() - started,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    model: candidate,
    loadMs,
    warmupMs,
    metrics: calculateMetrics(corpus.cases, predictions),
    predictions,
    solution: importSolution(candidate, predictions),
  };
}

async function runBenchmark() {
  runButton.disabled = true;
  downloadButton.disabled = true;
  summary.textContent = '';

  try {
    const models = [];

    for (const candidate of MODEL_CANDIDATES) models.push(await runCandidate(candidate));

    const result = {
      schemaVersion: 1,
      completedAt: new Date().toISOString(),
      runtime: {
        transformersJs: '4.3.0',
        backend: 'onnxruntime-web WASM, one thread, Chromium CPU',
        userAgent: navigator.userAgent,
        hardwareConcurrency: navigator.hardwareConcurrency ?? null,
        dtype: 'q8',
        threshold: THRESHOLD,
      },
      corpus: {
        file: 'benchmarks/text-cases.json',
        dataset: corpus.dataset,
        selection: corpus.selection,
        caseCount: corpus.cases.length,
      },
      models,
      solutions: models.map((entry) => entry.solution),
      jevBaseline: {
        status: 'awaiting-authenticated-matched-run',
        measured: false,
      },
    };

    window.__textModelBenchmark = result;
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    downloadButton.dataset.url = url;
    downloadButton.disabled = false;
    summary.textContent = models
      .map((entry) => `${entry.model.name}: ${JSON.stringify(entry.metrics.overall)}`)
      .join('\n');
    status.textContent = 'Benchmark complete. Results are in window.__textModelBenchmark.';

    return result;
  } catch (error) {
    status.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
    throw error;
  } finally {
    runButton.disabled = false;
  }
}

runButton.addEventListener('click', () => void runBenchmark());

downloadButton.addEventListener('click', () => {
  const link = document.createElement('a');
  link.href = downloadButton.dataset.url;
  link.download = 'text-model-results.json';
  link.click();
});

window.runTextModelBenchmark = runBenchmark;

window.textModelBenchmarkReady = true;

status.textContent = `Ready: ${corpus.cases.length} pinned test tweets, balanced 60/60.`;
