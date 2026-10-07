import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = path.resolve(import.meta.dirname, '..');
const cache = path.join(root, 'benchmarks/.data/ocr');
await mkdir(cache, { recursive: true });
const assets = [];
const pinnedAssets = new Map(
  JSON.parse(await readFile(path.join(root, 'benchmarks/ocr-results.json'), 'utf8')).assets.map(
    (asset) => [asset.name, asset],
  ),
);
const expectedBytes = {
  'PP-OCRv5_mobile_det_onnx_infer.tar': 4843520,
  'PP-OCRv5_mobile_rec_onnx_infer.tar': 16701440,
  'PP-OCRv6_tiny_det_onnx_infer.tar': 1792000,
  'PP-OCRv6_tiny_rec_onnx_infer.tar': 4526080,
  'PP-OCRv6_small_det_onnx_infer.tar': 9891840,
  'PP-OCRv6_small_rec_onnx_infer.tar': 21319680,
};
async function download(url, name) {
  const target = path.join(cache, name);
  let bytes;
  try {
    bytes = await readFile(target);
    const expectedSize = pinnedAssets.get(name)?.bytes || expectedBytes[name];
    if (expectedSize && bytes.length !== expectedSize) throw new Error('Incomplete asset');
  } catch {
    console.log(`Downloading ${name}`);
    const size = expectedBytes[name];
    if (size) {
      const chunks = await Promise.all(
        Array.from({ length: 4 }, async (_, i) => {
          const start = Math.floor((size * i) / 4),
            end = Math.floor((size * (i + 1)) / 4) - 1;
          const chunkPath = `${target}.part${i}`;
          await promisify(execFile)('curl', [
            '--fail',
            '--location',
            '--retry',
            '2',
            '--max-time',
            '180',
            '--range',
            `${start}-${end}`,
            '--output',
            chunkPath,
            url,
          ]);
          const chunk = await readFile(chunkPath);
          if (chunk.length !== end - start + 1)
            throw new Error(`Invalid range response for ${name}`);
          return chunk;
        }),
      );
      bytes = Buffer.concat(chunks);
      await writeFile(target, bytes);
    } else {
      await promisify(execFile)('curl', [
        '--fail',
        '--location',
        '--retry',
        '2',
        '--max-time',
        '180',
        '--output',
        target,
        url,
      ]);
      bytes = await readFile(target);
    }
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (pinnedAssets.get(name)?.sha256 && pinnedAssets.get(name).sha256 !== digest)
    throw new Error(`Pinned asset SHA-256 mismatch: ${name}`);
  assets.push({
    name,
    url,
    bytes: bytes.length,
    sha256: digest,
  });
}
const downloads = [];
for (const prefix of ['PP-OCRv5_mobile', 'PP-OCRv6_tiny', 'PP-OCRv6_small']) {
  for (const task of ['det', 'rec']) {
    const name = `${prefix}_${task}_onnx_infer.tar`;
    downloads.push(
      download(
        `https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/${name}`,
        name,
      ),
    );
  }
}
downloads.push(
  download(
    'https://raw.githubusercontent.com/naptha/tessdata/806cd9adc8c6e8abc11c782db1818c990576bebc/4.0.0_fast/eng.traineddata.gz',
    'eng-lstm-fast.traineddata.gz',
  ),
);
await Promise.all(downloads);
const hfModels = [
  {
    id: 'Xenova/trocr-small-printed',
    revision: '56c1626ea0b4aab378f3228235be2e824d4256bd',
    files: [
      'config.json',
      'generation_config.json',
      'preprocessor_config.json',
      'tokenizer.json',
      'tokenizer_config.json',
      'onnx/encoder_model_quantized.onnx',
      'onnx/decoder_model_merged_quantized.onnx',
    ],
  },
  {
    id: 'onnx-community/Florence-2-base-ft',
    revision: 'e88a44eaf3791a35eae0c5a47b3dbcd36e67eb6f',
    files: [
      'config.json',
      'generation_config.json',
      'preprocessor_config.json',
      'tokenizer.json',
      'tokenizer_config.json',
      'onnx/vision_encoder_quantized.onnx',
      'onnx/embed_tokens_quantized.onnx',
      'onnx/encoder_model_quantized.onnx',
      'onnx/decoder_model_merged_quantized.onnx',
    ],
  },
];
const hfPaths = new Map();
await Promise.all(
  hfModels.flatMap((model) =>
    model.files.map(async (file) => {
      const remotePath = `${model.id}/resolve/${model.revision}/${file}`;
      const name = `${model.id.replaceAll('/', '--')}--${file.replaceAll('/', '--')}`;
      await download(`https://huggingface.co/${remotePath}`, name);
      hfPaths.set(`/__hf/${remotePath}`, name);
      // Transformers 4.3 probes component manifests at main even when loading a
      // pinned revision. Both URLs serve the same pinned bytes in this benchmark.
      hfPaths.set(`/__hf/${model.id}/resolve/main/${file}`, name);
    }),
  ),
);

const vite = await createServer({
  configFile: false,
  root: path.join(root, 'benchmarks'),
  server: { host: '127.0.0.1', port: 5198, hmr: false, fs: { allow: [root] } },
  plugins: [
    {
      name: 'ocr-assets',
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const pathname = new URL(req.url, 'http://localhost').pathname;
          let file;
          if (pathname.startsWith('/__hf/')) {
            const name = hfPaths.get(pathname);
            if (!name) {
              res.statusCode = 404;
              res.end('Not in pinned model snapshot');
              return;
            }
            file = path.join(cache, name);
          } else if (pathname.startsWith('/node_modules/')) file = path.join(root, pathname);
          else if (pathname.startsWith('/__models/'))
            file = path.join(cache, path.basename(pathname));
          else if (pathname.startsWith('/__tess_fast/'))
            file = path.join(cache, 'eng-lstm-fast.traineddata.gz');
          else if (pathname.startsWith('/__tess_best/'))
            file = path.join(
              root,
              'node_modules/@tesseract.js-data',
              path.basename(pathname).split('.')[0],
              '4.0.0_best_int',
              path.basename(pathname),
            );
          else if (pathname.startsWith('/__paddle_ort/'))
            file = path.join(
              root,
              'node_modules/@paddleocr/paddleocr-js/node_modules/onnxruntime-web/dist',
              path.basename(pathname),
            );
          else if (pathname.startsWith('/__transformers_ort/'))
            file = path.join(root, 'node_modules/onnxruntime-web/dist', path.basename(pathname));
          else return next();
          try {
            const info = await stat(file);
            let contentType = 'application/octet-stream';
            if (file.endsWith('.wasm')) contentType = 'application/wasm';
            if (file.endsWith('.js') || file.endsWith('.mjs')) contentType = 'text/javascript';
            res.setHeader('Content-Type', contentType);
            res.setHeader('Content-Length', info.size);
            createReadStream(file).pipe(res);
          } catch (error) {
            next(error);
          }
        });
      },
    },
  ],
});
await vite.listen();
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
let results = {
  executedAt: new Date().toISOString(),
  environment: {
    cpu: os.cpus()[0].model,
    os: os.release(),
    browser: browser.version(),
    threads: 1,
  },
  assets,
  cases: [],
  engines: [],
};
const resume = process.argv.includes('--resume');
const selected = process.argv.slice(2).filter((arg) => arg !== '--resume');
const resultFile = path.join(
  root,
  `benchmarks/ocr-results-${selected.length ? selected.join('-') : 'all'}.json`,
);
if (resume) results = JSON.parse(await readFile(resultFile, 'utf8'));
const engines = selected.length
  ? selected
  : [
      'tesseract-current',
      'tesseract-adaptive',
      'tesseract-best',
      'tesseract-fast',
      'paddle-v5',
      'paddle-v6-tiny',
      'paddle-v6-small',
      'scribe-speed',
      'scribe-quality',
      'trocr',
      'florence',
    ];
try {
  for (const id of engines) {
    const previous = results.engines.find((engine) => engine.id === id);
    if (previous?.samples.length === results.cases.length && results.cases.length) continue;
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(120000);
    page.on('pageerror', (error) => console.log(`${id} browser error: ${error.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.log(`${id}: ${msg.text().slice(0, 500)}`);
    });
    const record = previous || { id, initMs: null, samples: [] };
    if (!previous) results.engines.push(record);
    try {
      await page.goto('http://127.0.0.1:5198/ocr-runner.html');
      await page.waitForFunction(() => typeof window.createEngine === 'function');
      const corpus = await page.evaluate(() => window.makeCorpus());
      // Commit the pixels, not just canvas instructions: installed fonts differ
      // between machines. Generation is retained for inspecting the design.
      for (const item of corpus) {
        const extension = item.jpeg ? 'jpg' : 'png';
        const fixture = await readFile(
          path.join(root, 'benchmarks/ocr-fixtures', `${item.id}.${extension}`),
        );
        item.dataUrl = `data:image/${item.jpeg ? 'jpeg' : 'png'};base64,${fixture.toString('base64')}`;
        item.imageSha256 = createHash('sha256').update(fixture).digest('hex');
        item.imageBytes = fixture.length;
      }
      results.cases = corpus.map(({ dataUrl: _dataUrl, ...item }) => item);
      await mkdir(path.join(cache, 'fixtures'), { recursive: true });
      for (const item of corpus)
        await writeFile(
          path.join(cache, 'fixtures', `${item.id}.${item.jpeg ? 'jpg' : 'png'}`),
          Buffer.from(item.dataUrl.split(',')[1], 'base64'),
        );
      console.log(`Initializing ${id}`);
      const start = performance.now();
      await page.evaluate((id) => window.createEngine(id), id);
      if (previous) record.resumedAt = new Date().toISOString();
      else record.initMs = performance.now() - start;
      for (const item of corpus) {
        if (record.samples.some((sample) => sample.id === item.id)) continue;
        // TrOCR's documented input is one text line. Also run whole screenshots
        // explicitly so the detection gap is visible rather than hidden.
        const runs = [];
        for (let repeat = 0; repeat < 3; repeat++)
          runs.push(await page.evaluate((item) => window.runCase(item), item));
        record.samples.push({ id: item.id, runs });
        console.log(
          `${id} ${item.id}: ${Math.round(runs[1].ms)} ms ${JSON.stringify(runs[0].text)}`,
        );
        await writeFile(
          path.join(
            root,
            `benchmarks/ocr-results-${selected.length ? selected.join('-') : 'all'}.json`,
          ),
          `${JSON.stringify(results, null, 2)}\n`,
        );
      }
      delete record.error;
    } catch (error) {
      record.error = error.stack || String(error);
      console.log(`${id} FAILED: ${record.error}`);
    } finally {
      await context.close();
    }
    await writeFile(
      path.join(
        root,
        `benchmarks/ocr-results-${selected.length ? selected.join('-') : 'all'}.json`,
      ),
      `${JSON.stringify(results, null, 2)}\n`,
    );
  }
  const cspContext = await browser.newContext();
  const cspPage = await cspContext.newPage();
  await cspPage.route('**/ocr-runner.html', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: {
        ...response.headers(),
        'content-security-policy': "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
      },
    });
  });
  await cspPage.goto('http://127.0.0.1:5198/ocr-runner.html');
  await cspPage.waitForFunction(() => typeof window.createEngine === 'function');
  results.paddleMv3CspProbe = await cspPage.evaluate(async () => {
    try {
      await window.createEngine('paddle-v6-tiny');
      return { initialized: true };
    } catch (error) {
      return { initialized: false, error: String(error) };
    }
  });
  await cspContext.close();
  await writeFile(
    path.join(root, `benchmarks/ocr-results-${selected.length ? selected.join('-') : 'all'}.json`),
    `${JSON.stringify(results, null, 2)}\n`,
  );
} finally {
  await browser.close();
  await vite.close();
}
console.log('OCR comparison saved.');
