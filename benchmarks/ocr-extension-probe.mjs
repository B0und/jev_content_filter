import { build } from 'vite';
import { chromium } from 'playwright';
import puppeteer from 'puppeteer-core';
import { mkdir, writeFile, readdir, stat, copyFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const wasmOnly = process.argv.includes('--wasm');
const output = path.join(root, `benchmarks/.data/ocr/mv3-probe${wasmOnly ? '-wasm' : ''}`);
await build({
  configFile: false,
  root: import.meta.dirname,
  resolve: wasmOnly
    ? {
        alias: {
          'onnxruntime-web': path.join(
            root,
            'node_modules/@paddleocr/paddleocr-js/node_modules/onnxruntime-web/dist/ort.wasm.min.mjs',
          ),
        },
      }
    : undefined,
  build: {
    outDir: output,
    emptyOutDir: true,
    rolldownOptions: { input: path.join(import.meta.dirname, 'ocr-extension-probe.html') },
  },
});
await mkdir(path.join(output, 'ort'), { recursive: true });
for (const name of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
  await copyFile(
    path.join(root, 'node_modules/@paddleocr/paddleocr-js/node_modules/onnxruntime-web/dist', name),
    path.join(output, 'ort', name),
  );
}
await writeFile(
  path.join(output, 'manifest.json'),
  JSON.stringify({
    manifest_version: 3,
    name: 'OCR CSP probe',
    version: '1.0.0',
    background: { service_worker: 'background.js' },
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
    },
  }),
);
await writeFile(path.join(output, 'background.js'), 'self.addEventListener("message", () => {});');
const files = [];
async function inventory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await inventory(file);
    else files.push({ path: path.relative(output, file), bytes: (await stat(file)).size });
  }
}
await inventory(output);
const profile = path.join(root, `benchmarks/.data/ocr/probe-profile-${Date.now()}`);
const context = await puppeteer.launch({
  executablePath: chromium.executablePath(),
  userDataDir: profile,
  headless: true,
  pipe: true,
  enableExtensions: true,
  args: ['--no-sandbox'],
});
try {
  const id = await context.installExtension(output);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  await page.goto(`chrome-extension://${id}/ocr-extension-probe.html`);
  await page
    .waitForFunction(() => typeof window.initializeOcr === 'function', { timeout: 10000 })
    .catch(() => undefined);
  const available = await page.evaluate(() => typeof window.initializeOcr === 'function');
  const result = available
    ? await page.evaluate(async () => {
        try {
          await Promise.race([
            window.initializeOcr(),
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error('Initialization did not complete in 10 seconds.')),
                10000,
              ),
            ),
          ]);
          return { initialized: true };
        } catch (error) {
          return { initialized: false, error: String(error) };
        }
      })
    : { initialized: false, error: errors.join('\n') || 'The packaged module did not load.' };
  const report = {
    executedAt: new Date().toISOString(),
    browser: await context.version(),
    result,
    errors,
    files,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
  };
  await writeFile(
    path.join(root, `benchmarks/ocr-extension-results${wasmOnly ? '-wasm' : ''}.json`),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await context.close();
}
