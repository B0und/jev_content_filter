#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const benchmarkDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.resolve(benchmarkDirectory, '..');
const cacheDirectory = path.join(benchmarkDirectory, '.data', 'image-model-comparison');
const fixtureCacheDirectory = path.join(cacheDirectory, 'fixtures');
const modelCacheDirectory = path.join(cacheDirectory, 'models');
const freshChromiumProfile = process.argv.includes('--fresh-profile');
const chromeProfileDirectory = path.join(
  cacheDirectory,
  freshChromiumProfile ? `chrome-profile-cold-${Date.now()}` : 'chrome-profile',
);
const manifestPath = path.join(benchmarkDirectory, 'image-model-fixtures.json');
const outputPath = path.join(benchmarkDirectory, 'image-model-results.json');
const fixtureOutputDirectory = path.join(benchmarkDirectory, 'image-model-imports');
const comparisonOutputPath = path.join(benchmarkDirectory, 'image-comparison.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const DATASET_ID = 'wallstoneai/civitai-top-nsfw-images-with-metadata';
const DATASET_REVISION = '4580a03472a54768a8d47a87822cab14e6a75996';
const MODEL_URL =
  'https://huggingface.co/taufiqdp/mobilenetv4_conv_small.e2400_r224_in1k_nsfw_classifier/resolve/504317ad62086f357c9c5f70cf983726ff47efdb/mobilenetv4_conv_small.e2400_r224_in1k_nsfw_classifier.onnx';
const MODEL_PATH = path.join(modelCacheDirectory, 'mobilenetv4-conv-small.onnx');
const MODEL_SHA256 = '46995c000cb285d0c0a0e5b58cc618012ed2e649d326d4fddae910951848fc40';
const MODEL_BYTES = 9_974_311;
const TRANSFORMERS_MODEL_BYTES = 56_757_898;
const TRANSFORMERS_MODEL_REVISION = '1ceb3c7fe1e9f3f2507e6df577437f23a9149fd5';
const THRESHOLD = 0.5;

const help = process.argv.includes('--help') || process.argv.includes('-h');
const prepareOnly = process.argv.includes('--prepare-only');
if (help) {
  console.log(
    'Usage: node benchmarks/image-model-benchmark.mjs [--prepare-only] [--fresh-profile]\n\nDownloads the fixed corpus/model artifacts into ignored benchmarks/.data, then runs packaged NSFWJS, the deferred pinned NSFWJS adapter, and two Hugging Face candidates in headless Chromium. --prepare-only downloads/validates assets and prints byte counts and SHA-256 hashes. --fresh-profile bypasses prior browser model cache for a cold-start measurement.',
  );
  process.exit(0);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function download(url, destination, expectedSha256 = null) {
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    const existing = await readFile(destination);
    const digest = sha256(existing);
    if (expectedSha256 && digest !== expectedSha256) {
      throw new Error(`Cached file failed SHA-256 check: ${destination}`);
    }
    return { bytes: existing.byteLength, sha256: digest, cached: true };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Cached file failed')) throw error;
  }

  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}: ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = sha256(bytes);
  if (expectedSha256 && digest !== expectedSha256) {
    throw new Error(
      `SHA-256 mismatch for ${String(url)}: expected ${String(expectedSha256)}, got ${String(digest)}`,
    );
  }
  const temporaryPath = `${destination}.tmp-${process.pid}`;
  await writeFile(temporaryPath, bytes);
  await rename(temporaryPath, destination);
  return { bytes: bytes.byteLength, sha256: digest, cached: false };
}

async function selectDatasetCases() {
  const url = `https://huggingface.co/datasets/${DATASET_ID}/resolve/${DATASET_REVISION}/prompts.json`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Dataset metadata returned HTTP ${response.status}`);
  const metadata = await response.json();
  const candidates = Object.entries(metadata)
    .filter(
      ([, value]) => value?.[manifest.selectionRule.labelKey] === manifest.selectionRule.labelValue,
    )
    .map(([filename]) => ({
      filename,
      hash: sha256(Buffer.from(`${manifest.split.seed}:${filename}`)),
    }))
    .sort((left, right) => left.hash.localeCompare(right.hash));
  const selected = candidates
    .slice(0, manifest.selectionRule.count)
    .map(({ filename }) => filename);
  if (JSON.stringify(selected) !== JSON.stringify(manifest.selectionRule.expectedFilenames)) {
    throw new Error(
      `Pinned split changed. Expected ${manifest.selectionRule.expectedFilenames.join(', ')}, got ${selected.join(', ')}`,
    );
  }
  for (const filename of selected) {
    if (metadata[filename]?.nsfwLevel !== 'X')
      throw new Error(`Expected nsfwLevel=X for ${filename}`);
  }
  return { url, revision: DATASET_REVISION, selectedFilenames: selected };
}

async function prepareAssets() {
  await Promise.all([
    mkdir(fixtureCacheDirectory, { recursive: true }),
    mkdir(modelCacheDirectory, { recursive: true }),
    mkdir(chromeProfileDirectory, { recursive: true }),
  ]);
  const selection = await selectDatasetCases();
  const assets = [];
  for (const item of manifest.cases) {
    if (item.assetFile.startsWith('existing/')) {
      const sourcePath = path.join(
        benchmarkDirectory,
        'images',
        item.assetFile.slice('existing/'.length),
      );
      const bytes = await readFile(sourcePath);
      assets.push({
        caseId: item.id,
        path: item.assetFile,
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
        source: item.source,
        cached: true,
      });
      continue;
    }
    const destination = path.join(fixtureCacheDirectory, item.assetFile);
    const result = await download(item.source, destination, item.sha256 ?? null);
    assets.push({ caseId: item.id, path: item.assetFile, ...result, source: item.source });
  }
  const model = await download(MODEL_URL, MODEL_PATH, MODEL_SHA256);
  const modelStat = await stat(MODEL_PATH);
  if (modelStat.size !== MODEL_BYTES)
    throw new Error(
      `MobileNetV4 artifact size mismatch: expected ${MODEL_BYTES}, got ${modelStat.size}`,
    );
  return { selection, assets, model: { path: 'models/mobilenetv4-conv-small.onnx', ...model } };
}

const assetContentTypes = {
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function localAssetPath(assetFile) {
  if (assetFile.startsWith('existing/')) {
    return path.join(benchmarkDirectory, 'images', assetFile.slice('existing/'.length));
  }
  return path.join(fixtureCacheDirectory, assetFile);
}

function viteAssetPlugin() {
  return {
    name: 'serve-local-image-benchmark-assets',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const requestUrl = new URL(request.url ?? '/', 'http://localhost');
        const pathname = requestUrl.pathname;
        if (pathname.startsWith('/__benchmark_onnxruntime/')) {
          const filename = path.basename(pathname);
          if (!/^ort-wasm-simd-threaded(?:\.asyncify)?\.(?:mjs|wasm)$/.test(filename)) {
            response.statusCode = 404;
            response.end('Unknown ONNX Runtime Web asset');
            return;
          }
          const wasmPath = path.join(
            repositoryDirectory,
            'node_modules/onnxruntime-web/dist',
            filename,
          );
          try {
            const fileStat = await stat(wasmPath);
            response.statusCode = 200;
            response.setHeader(
              'Content-Type',
              filename.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
            );
            response.setHeader('Content-Length', fileStat.size);
            response.setHeader('Cache-Control', 'no-store');
            createReadStream(wasmPath).pipe(response);
          } catch (error) {
            next(error);
          }
          return;
        }
        if (pathname === '/__benchmark_model/mobilenetv4.onnx') {
          try {
            const fileStat = await stat(MODEL_PATH);
            response.statusCode = 200;
            response.setHeader('Content-Type', 'application/octet-stream');
            response.setHeader('Content-Length', fileStat.size);
            response.setHeader('Cache-Control', 'no-store');
            createReadStream(MODEL_PATH).pipe(response);
          } catch (error) {
            next(error);
          }
          return;
        }
        if (!pathname.startsWith('/__benchmark_asset/')) return next();
        const caseId = decodeURIComponent(pathname.slice('/__benchmark_asset/'.length));
        const item = manifest.cases.find((candidate) => candidate.id === caseId);
        if (!item) {
          response.statusCode = 404;
          response.end('Unknown benchmark case');
          return;
        }
        try {
          const filePath = localAssetPath(item.assetFile);
          const fileStat = await stat(filePath);
          const extension = path.extname(filePath).toLowerCase();
          response.statusCode = 200;
          response.setHeader(
            'Content-Type',
            assetContentTypes[extension] ?? 'application/octet-stream',
          );
          response.setHeader('Content-Length', fileStat.size);
          response.setHeader('Cache-Control', 'no-store');
          createReadStream(filePath).pipe(response);
        } catch (error) {
          next(error);
        }
      });
    },
  };
}

function metricsFor(cases, predictions) {
  const predictionById = Object.fromEntries(
    predictions.map((prediction) => [prediction.caseId, prediction]),
  );
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  let missing = 0;
  for (const item of cases) {
    const prediction = predictionById[item.id];
    if (!prediction || prediction.score === null) {
      missing += 1;
      continue;
    }
    const expected = item.labels.contentMatch === 'yes';
    const predicted = prediction.score >= THRESHOLD;
    if (expected && predicted) tp += 1;
    else if (!expected && predicted) fp += 1;
    else if (!expected && !predicted) tn += 1;
    else fn += 1;
  }
  const positiveCount = tp + fn;
  const negativeCount = tn + fp;
  const ratio = (numerator, denominator) => (denominator === 0 ? null : numerator / denominator);
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  const specificity = ratio(tn, tn + fp);
  const f1 =
    precision === null || recall === null || precision + recall === 0
      ? null
      : (2 * precision * recall) / (precision + recall);
  const scores = cases
    .map((item) => ({
      expected: item.labels.contentMatch === 'yes',
      score: predictionById[item.id]?.score,
    }))
    .filter((item) => typeof item.score === 'number');
  const positives = scores.filter((item) => item.expected);
  const negatives = scores.filter((item) => !item.expected);
  let auc = null;
  if (positives.length > 0 && negatives.length > 0) {
    let wins = 0;
    for (const positive of positives) {
      for (const negative of negatives) {
        if (positive.score > negative.score) wins += 1;
        else if (positive.score === negative.score) wins += 0.5;
      }
    }
    auc = wins / (positives.length * negatives.length);
  }
  const latencies = predictions
    .map((prediction) => prediction.latencyMs)
    .filter((value) => typeof value === 'number')
    .sort((a, b) => a - b);
  return {
    threshold: THRESHOLD,
    labeled: cases.length,
    scored: scores.length,
    missing,
    confusion: { truePositive: tp, falsePositive: fp, trueNegative: tn, falseNegative: fn },
    accuracy: ratio(tp + tn, scores.length),
    precision,
    recall,
    specificity,
    f1,
    balancedAccuracy: specificity === null || recall === null ? null : (specificity + recall) / 2,
    rocAuc: auc,
    latencyMs: {
      median: latencies.length ? latencies[Math.floor(latencies.length / 2)] : null,
      p95: latencies.length
        ? latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)]
        : null,
      min: latencies.length ? latencies[0] : null,
      max: latencies.length ? latencies[latencies.length - 1] : null,
    },
    classCounts: { positive: positiveCount, negative: negativeCount },
  };
}

function importSolution(model, cases) {
  const predictions = Object.fromEntries(
    model.predictions.map((item) => {
      const raw = item.rawScores ?? {};
      const nsfwjs =
        model.id === 'nsfwjs-mobilenet-v2' ||
        model.id === 'nsfwjs-mobilenet-v2-static' ||
        model.id === 'taufiqdp-mobilenetv4-conv-small'
          ? {
              porn: raw.porn ?? null,
              hentai: raw.hentai ?? null,
              sexy: raw.sexy ?? null,
              drawings: raw.drawings ?? null,
            }
          : { porn: null, hentai: null, sexy: null, drawings: null };
      return [
        item.caseId,
        {
          contentMatch: item.score,
          aiGenerated: null,
          nsfwjs,
          review: {
            contentMatch: 'unreviewed',
            aiGenerated: 'unreviewed',
            porn: 'unreviewed',
            hentai: 'unreviewed',
            sexy: 'unreviewed',
            drawings: 'unreviewed',
          },
        },
      ];
    }),
  );
  return {
    id: `image-${model.id}`,
    name: model.name,
    description: `Image benchmark run ${manifest.corpusId}; revision ${model.revision}; ${model.quantization}; predictions for ${cases.length} fixed cases. Full timings and per-case errors are in image-model-results.json.`,
    kind:
      model.id === 'nsfwjs-mobilenet-v2' || model.id === 'nsfwjs-mobilenet-v2-static'
        ? 'nsfwjs'
        : 'other',
    predictions,
  };
}

async function runBrowser() {
  const vite = await createServer({
    configFile: false,
    root: benchmarkDirectory,
    appType: 'mpa',
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
    plugins: [viteAssetPlugin()],
  });
  let context;
  try {
    await vite.listen();
    const address = vite.httpServer.address();
    if (!address || typeof address === 'string')
      throw new Error('Vite did not expose its listening port');
    const executablePath = await access('/usr/bin/chromium')
      .then(() => '/usr/bin/chromium')
      .catch(() => undefined);
    context = await chromium.launchPersistentContext(chromeProfileDirectory, {
      executablePath,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
      viewport: { width: 1024, height: 768 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(0);
    page.on('console', (message) => {
      if (message.type() === 'error') console.error(`[chromium] ${message.text()}`);
    });
    page.on('pageerror', (error) => console.error(`[chromium page error] ${error.message}`));
    await page.goto(`http://127.0.0.1:${address.port}/image-model-benchmark.html`, {
      waitUntil: 'domcontentloaded',
      timeout: 0,
    });
    await page.waitForFunction(
      () => {
        const result = document.querySelector('#result');
        return result?.dataset.state === 'done' || result?.dataset.state === 'failed';
      },
      null,
      { timeout: 0 },
    );
    const state = await page.locator('#result').getAttribute('data-state');
    const raw = await page.locator('#result').textContent();
    if (!raw) throw new Error('Browser did not return benchmark output');
    const browserOutput = JSON.parse(raw);
    if (state === 'failed') throw new Error(browserOutput.error ?? 'Browser benchmark failed');
    return browserOutput;
  } finally {
    await context?.close();
    await vite.close();
  }
}

const assetPreparation = await prepareAssets();
if (prepareOnly) {
  console.log(JSON.stringify(assetPreparation, null, 2));
  process.exit(0);
}

const browserOutput = await runBrowser();
const resultModels = browserOutput.models.map((model) => ({
  ...model,
  metrics: metricsFor(manifest.cases, model.predictions),
}));
const nsfwjsPackage = JSON.parse(
  await readFile(path.join(repositoryDirectory, 'node_modules/nsfwjs/package.json'), 'utf8'),
);
const transformersPackage = JSON.parse(
  await readFile(
    path.join(repositoryDirectory, 'node_modules/@huggingface/transformers/package.json'),
    'utf8',
  ),
);
const onnxPackage = JSON.parse(
  await readFile(
    path.join(repositoryDirectory, 'node_modules/onnxruntime-web/package.json'),
    'utf8',
  ),
);
const cases = manifest.cases.map((item) => {
  const asset = assetPreparation.assets.find((candidate) => candidate.caseId === item.id);
  return {
    ...item,
    imageReference: item.assetFile.startsWith('existing/')
      ? item.source
      : `benchmarks/.data/image-model-comparison/fixtures/${item.assetFile}`,
    assetBytes: asset?.bytes ?? null,
    assetSha256: asset?.sha256 ?? null,
  };
});
const staticNsfwjsModel = resultModels.find((model) => model.id === 'nsfwjs-mobilenet-v2-static');
const finalResult = {
  schemaVersion: 1,
  executedAt: new Date().toISOString(),
  corpusId: manifest.corpusId,
  split: manifest.split,
  threshold: THRESHOLD,
  labelPolicy: manifest.labelPolicy,
  environment: {
    ...browserOutput.environment,
    os: `${os.type()} ${os.release()} (${process.arch})`,
    cpu: os.cpus()[0]?.model ?? 'unknown',
    nsfwjsVersion: nsfwjsPackage.version,
    transformersJsVersion: transformersPackage.version,
    onnxRuntimeWebVersion: onnxPackage.version,
    browserModelCache: freshChromiumProfile
      ? 'fresh Chromium profile for this run under ignored benchmarks/.data; no prior browser model cache'
      : 'persistent Chromium profile under ignored benchmarks/.data/image-model-comparison/chrome-profile',
  },
  datasetSelection: assetPreparation.selection,
  assets: assetPreparation.assets,
  modelArtifacts: {
    nsfwjsMobileNetV2: {
      bytes: 3_600_073,
      source: `nsfwjs@${nsfwjsPackage.version} package files in node_modules/nsfwjs/dist/models/mobilenet_v2/`,
    },
    nsfwjsMobileNetV2Static: {
      id: 'nsfwjs/mobilenet_v2',
      revision: staticNsfwjsModel?.revision ?? null,
      files: [
        {
          file: 'model.json',
          url: `https://raw.githubusercontent.com/infinitered/nsfwjs/${staticNsfwjsModel?.revision}/models/mobilenet_v2/model.json`,
          bytes: 128_945,
        },
        {
          file: 'group1-shard1of1',
          url: `https://raw.githubusercontent.com/infinitered/nsfwjs/${staticNsfwjsModel?.revision}/models/mobilenet_v2/group1-shard1of1`,
          bytes: 2_619_461,
        },
      ],
      bytes: staticNsfwjsModel?.artifactBytes ?? null,
      source: `https://github.com/infinitered/nsfwjs/tree/${staticNsfwjsModel?.revision}/models/mobilenet_v2`,
    },
    taufiqdpMobileNetV4: {
      id: 'taufiqdp/mobilenetv4_conv_small.e2400_r224_in1k_nsfw_classifier',
      revision: '504317ad62086f357c9c5f70cf983726ff47efdb',
      file: 'mobilenetv4_conv_small.e2400_r224_in1k_nsfw_classifier.onnx',
      bytes: MODEL_BYTES,
      sha256: MODEL_SHA256,
    },
    falconsaiOnnxQ4: {
      id: 'onnx-community/nsfw_image_detection-ONNX',
      revision: TRANSFORMERS_MODEL_REVISION,
      file: 'onnx/model_q4.onnx',
      bytes: TRANSFORMERS_MODEL_BYTES,
      quantization: 'q4',
    },
  },
  cases,
  models: resultModels,
};
await writeFile(outputPath, `${JSON.stringify(finalResult, null, 2)}\n`);
const comparisonCases = cases.map((item) => ({
  id: item.id,
  modality: 'image',
  title: item.title,
  imageUrl: item.assetFile.startsWith('existing/')
    ? `/images/${path.basename(item.assetFile)}`
    : item.source,
  labels: {
    contentMatch: item.labels.contentMatch,
    aiGenerated: 'unknown',
  },
  provenance: item.provenance === 'user-reported' ? 'user-reported' : 'unknown',
  notes: [
    `Category: ${item.category}`,
    `Source: ${item.sourcePage ?? item.source}`,
    item.creator ? `Creator: ${item.creator}` : null,
    `License: ${item.license}`,
    item.sourceLabel ? `Dataset label: ${item.sourceLabel}` : null,
    `Asset SHA-256: ${item.assetSha256}`,
    item.category === 'dataset-x' ? manifest.sources.civitai.caveat : null,
    item.provenance === 'user-reported' ? manifest.sources.existingFalsePositive.caveat : null,
  ]
    .filter(Boolean)
    .join('\n'),
  createdAt: manifest.createdAt,
}));
const comparisonExport = {
  schemaVersion: 1,
  corpusId: manifest.corpusId,
  createdAt: manifest.createdAt,
  split: manifest.split,
  labelPolicy: manifest.labelPolicy,
  thresholds: { contentMatch: THRESHOLD, aiGenerated: THRESHOLD, nsfwjs: THRESHOLD },
  selectedCaseId: null,
  cases: comparisonCases,
  solutions: resultModels.map((model) => importSolution(model, cases)),
  modelRuns: resultModels.map((model) => ({
    id: model.id,
    name: model.name,
    revision: model.revision,
    quantization: model.quantization,
    runtime: model.runtime,
    artifactBytes: model.artifactBytes,
    loadingMs: model.loadingMs,
    warmupMs: model.warmupMs,
    preprocessing: model.preprocessing,
    metrics: model.metrics,
    error: model.error ?? null,
  })),
  resultsFile: path.basename(outputPath),
};
await writeFile(comparisonOutputPath, `${JSON.stringify(comparisonExport, null, 2)}\n`);
await mkdir(fixtureOutputDirectory, { recursive: true });
for (const model of resultModels) {
  let filename;
  if (model.id === 'nsfwjs-mobilenet-v2') {
    filename = 'image-model-import-nsfwjs.json';
  } else if (model.id === 'nsfwjs-mobilenet-v2-static') {
    filename = 'image-model-import-nsfwjs-static.json';
  } else if (model.id === 'taufiqdp-mobilenetv4-conv-small') {
    filename = 'image-model-import-mobilenetv4.json';
  } else {
    filename = 'image-model-import-transformersjs.json';
  }
  const solution = importSolution(model, cases);
  await writeFile(
    path.join(fixtureOutputDirectory, filename),
    `${JSON.stringify(solution, null, 2)}\n`,
  );
}
const summary = resultModels.map((model) => ({
  model: model.name,
  artifactBytes: model.artifactBytes,
  loadingMs: model.loadingMs,
  metrics: model.metrics,
  error: model.error ?? null,
}));
console.log(
  JSON.stringify(
    {
      result: path.relative(repositoryDirectory, outputPath),
      comparison: path.relative(repositoryDirectory, comparisonOutputPath),
      imports: path.relative(repositoryDirectory, fixtureOutputDirectory),
      summary,
    },
    null,
    2,
  ),
);
if (resultModels.some((model) => model.error || model.metrics.scored !== manifest.cases.length))
  process.exitCode = 1;
