#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const dir = path.dirname(fileURLToPath(import.meta.url));

const root = path.resolve(dir, '..');

const probe = path.join(dir, '.data', 'sensitive-image-probe');

const vite = await createServer({
  root: dir,
  appType: 'mpa',
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
  plugins: [
    {
      name: 'probe-assets',
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const u = new URL(req.url ?? '/', 'http://localhost');
          let file;
          let type;

          if (u.pathname.startsWith('/probe/')) {
            file = path.join(probe, path.basename(u.pathname));
            type = u.pathname.endsWith('.png') ? 'image/png' : 'image/jpeg';
          } else if (u.pathname === '/model/anime-dbrating.onnx') {
            file = path.join(probe, 'anime-dbrating.onnx');
            type = 'application/octet-stream';
          } else if (u.pathname.startsWith('/ort/')) {
            file = path.join(root, 'node_modules/onnxruntime-web/dist', path.basename(u.pathname));
            type = u.pathname.endsWith('.wasm') ? 'application/wasm' : 'text/javascript';
          } else return next();

          try {
            const s = await stat(file);
            res.statusCode = 200;
            res.setHeader('Content-Type', type);
            res.setHeader('Content-Length', s.size);
            createReadStream(file).pipe(res);
          } catch {
            res.statusCode = 404;
            res.end();
          }
        });
      },
    },
  ],
});

await vite.listen();

const address = vite.httpServer.address();

const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/sensitive-image-probe.html`);
  await page.waitForFunction(
    () => document.querySelector('#result')?.dataset.state !== 'running',
    null,
    { timeout: 0 },
  );
  console.log(await page.locator('#result').textContent());
} finally {
  await browser.close();
  await vite.close();
}
