import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { calculateMetrics } from './text-metrics.js';

const directory = dirname(fileURLToPath(import.meta.url));
const casesPath = resolve(directory, 'text-cases.json');
const resultsPath = resolve(directory, 'text-results.json');
const corpus = JSON.parse(await readFile(casesPath, 'utf8'));
const jevPath = resolve(directory, 'text-jev-results.json');
const vite = await createServer({
  configFile: false,
  root: directory,
  appType: 'mpa',
  server: { host: '127.0.0.1', port: 0, strictPort: false },
});
let browser;

try {
  await vite.listen();
  const address = vite.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not expose a TCP port.');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(3_600_000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });
  await page.goto(`http://127.0.0.1:${address.port}/text-runner.html`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(() => window.textModelBenchmarkReady === true, { timeout: 60_000 });
  const result = await page.evaluate(() => window.runTextModelBenchmark());
  if (pageErrors.length > 0)
    throw new Error(`Chromium reported page errors: ${pageErrors.join('\n')}`);

  try {
    const jev = JSON.parse(await readFile(jevPath, 'utf8'));
    const jevById = new Map(jev.predictions.map((prediction) => [prediction.id, prediction]));
    const predictions = corpus.cases.map((item) => {
      const source = jevById.get(item.id);
      return {
        caseId: item.id,
        text: item.text,
        actual: item.labels.aiGenerated,
        provenance: item.provenance,
        charCount: item.charCount,
        aiProbability: Number.isFinite(source?.score) ? source.score : null,
        rawOutput: null,
        inferenceMs: Number.isFinite(source?.latencyMs) ? source.latencyMs : null,
        error: source ? null : 'No matched Jev result for case ID.',
      };
    });
    result.jevBaseline = {
      model: jev.model,
      provider: jev.provider,
      evaluatedAt: jev.evaluatedAt,
      revision: jev.revision,
      measured: true,
      metrics: calculateMetrics(corpus.cases, predictions),
      predictions,
      errors: predictions.filter((prediction) => prediction.error !== null).length,
    };
    result.solutions.push({
      name: 'Jev (Vercel AI Gateway, matched run)',
      description: `Provider-managed Jev model evaluated ${jev.evaluatedAt} using production text questions on the same corpus.`,
      kind: 'llm',
      predictions: Object.fromEntries(
        predictions.map((prediction) => [
          prediction.caseId,
          { aiGenerated: prediction.aiProbability },
        ]),
      ),
    });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    result.jevBaseline = {
      status: 'unmeasured',
      measured: false,
      reason: 'No text-jev-results.json was present.',
    };
  }

  const thresholds = [0.5, 0.65, 0.85, 0.9];
  const makeThresholdSweep = (predictions) =>
    thresholds.map((threshold) => ({
      threshold,
      ...calculateMetrics(corpus.cases, predictions, threshold).overall,
    }));
  for (const model of result.models) {
    model.thresholdSweep = makeThresholdSweep(model.predictions);
  }
  if (result.jevBaseline?.predictions) {
    result.jevBaseline.thresholdSweep = makeThresholdSweep(result.jevBaseline.predictions);
  }

  result.runtime = {
    ...result.runtime,
    execution: 'Headless Chromium; ONNX Runtime Web WASM CPU; single WASM thread.',
  };
  result.output = 'benchmarks/text-results.json';
  await writeFile(resultsPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(
    JSON.stringify(
      {
        output: resultsPath,
        caseCount: corpus.cases.length,
        jev: result.jevBaseline?.metrics?.overall ?? result.jevBaseline,
        localModels: result.models.map(({ model, loadMs, warmupMs, metrics, predictions }) => ({
          id: model.id,
          revision: model.revision,
          loadMs,
          warmupMs,
          metrics,
          errors: predictions.filter((prediction) => prediction.error !== null).length,
        })),
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await vite.close();
}
