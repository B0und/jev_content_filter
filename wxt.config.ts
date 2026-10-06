import { resolve } from 'node:path';
import babel from '@rolldown/plugin-babel';
import { defineConfig } from 'wxt';
import { defaultClientConditions } from 'vite';

export default defineConfig({
  srcDir: 'src',
  imports: false,
  modules: ['@wxt-dev/module-react'],
  hooks: {
    'build:publicAssets': (wxt, files) => {
      for (const name of ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs']) {
        files.push({
          absoluteSrc: resolve(wxt.config.root, 'node_modules/onnxruntime-web/dist', name),
          relativeDest: `ort/${name}`,
        });
      }
      files.push({
        absoluteSrc: resolve(wxt.config.root, 'node_modules/tesseract.js/dist/worker.min.js'),
        relativeDest: 'ocr/worker.min.js',
      });
      const core = 'tesseract-core-simd-lstm.wasm.js';
      files.push({
        absoluteSrc: resolve(wxt.config.root, 'node_modules/tesseract.js-core', core),
        relativeDest: `ocr/${core}`,
      });
      for (const dependency of ['tesseract.js', 'tesseract.js-core']) {
        files.push({
          absoluteSrc: resolve(
            wxt.config.root,
            `node_modules/${dependency}/${dependency === 'tesseract.js' ? 'LICENSE.md' : 'LICENSE'}`,
          ),
          relativeDest: `ocr/${dependency}.LICENSE`,
        });
      }
    },
  },
  vite: () => ({
    resolve: {
      alias: { 'onnxruntime-web/webgpu': 'onnxruntime-web/wasm' },
      conditions: [...defaultClientConditions, 'onnxruntime-web-use-extern-wasm'],
    },
    worker: { format: 'es' },
  }),
  react: {
    vitePluginsBefore: [
      babel({
        include: /\/src\/.*\.[jt]sx$/,
        plugins: [['babel-plugin-react-compiler', { target: '19' }]],
      }),
    ],
  },
  manifest: {
    name: 'Jev Feed Filter',
    icons: {
      16: '/icons/normal-16.png',
      32: '/icons/normal-32.png',
      48: '/icons/normal-48.png',
      128: '/icons/normal-128.png',
    },
    permissions: ['storage', 'webNavigation', 'offscreen'],
    minimum_chrome_version: '116',
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
    },
    host_permissions: [
      'https://x.com/*',
      'https://twitter.com/*',
      'https://pbs.twimg.com/*',
      'https://video.twimg.com/*',
      'https://ai-gateway.vercel.sh/*',
      'https://api.typesafe.ai/*',
      'https://openrouter.ai/*',
      'https://huggingface.co/*',
      'https://*.huggingface.co/*',
      'https://*.hf.co/*',
      'https://raw.githubusercontent.com/infinitered/nsfwjs/*',
      'https://raw.githubusercontent.com/naptha/tessdata/*',
    ],
  },
});
