import { createWorker, OEM, PSM } from 'tesseract.js';
import { recognizeOcrImage } from '../src/inference/ocr-image';

// Fixed, generated screenshots. Ground truth is supplied before any engine runs.
export const cases = [
  {
    id: 'large-light',
    lines: [
      'English screenshot text inside a tweet',
      'This sentence should be read from the image.',
      'Small captions and screenshots need OCR.',
    ],
    size: 36,
    width: 1100,
  },
  {
    id: 'dark-caption',
    lines: ['Send me your nude photos tonight.', 'Adults only: explicit sexual content.'],
    size: 28,
    dark: true,
    width: 850,
  },
  {
    id: 'small-light',
    lines: ['Subscribe for explicit sex videos.', 'This text is embedded in an image.'],
    size: 14,
    width: 550,
  },
  {
    id: 'small-dark',
    lines: ['Please stop sharing porn in the group.', 'The caption is small but still readable.'],
    size: 14,
    dark: true,
    width: 550,
  },
  {
    id: 'jpeg-caption',
    lines: ['Naked photos and sexual fantasies.', 'A compressed screenshot from a social feed.'],
    size: 22,
    jpeg: true,
    width: 740,
  },
  {
    id: 'serif',
    lines: ['A book club meets every Friday.', 'Bring a notebook and your favorite novel.'],
    size: 24,
    font: 'Georgia',
    width: 800,
  },
  {
    id: 'rotated',
    lines: ['Explicit sex and nude pictures.', 'A tilted caption inside a screenshot.'],
    size: 26,
    angle: -5,
    width: 850,
  },
  {
    id: 'meme',
    lines: ['SEND NUDES', 'NO SERIOUSLY SEND THE CAT PHOTOS'],
    size: 30,
    font: 'Impact',
    outlined: true,
    width: 780,
  },
  {
    id: 'low-contrast',
    lines: ['Sexual content appears inside images.', 'Coffee and breakfast are ready.'],
    size: 20,
    contrast: true,
    width: 770,
  },
  {
    id: 'single-printed',
    lines: ['Send me your nude photos tonight.'],
    size: 28,
    width: 650,
    singleLine: true,
  },
  {
    id: 'single-small',
    lines: ['Subscribe for explicit sex videos.'],
    size: 14,
    width: 360,
    singleLine: true,
  },
  {
    id: 'single-serif',
    lines: ['A book club meets every Friday.'],
    size: 24,
    font: 'Georgia',
    width: 510,
    singleLine: true,
  },
  {
    id: 'single-dark',
    lines: ['Please stop sharing porn in the group.'],
    size: 20,
    dark: true,
    width: 570,
    singleLine: true,
  },
  { id: 'no-text', lines: [], size: 20, width: 800 },
];

function sourceImage(item) {
  const canvas = document.createElement('canvas');
  canvas.width = item.width;
  canvas.height = item.singleLine
    ? item.size * 2.5
    : Math.max(180, (item.lines.length + 1) * item.size * 1.8);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  if (item.outlined) ctx.fillStyle = '#8495aa';
  if (item.dark) ctx.fillStyle = '#15202b';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!item.lines.length) {
    ctx.fillStyle = '#567b9a';
    ctx.fillRect(0, canvas.height / 2, canvas.width, canvas.height / 2);
    ctx.fillStyle = '#dab771';
    ctx.beginPath();
    ctx.arc(560, 50, 27, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.translate(18, item.singleLine ? item.size * 1.6 : item.size * 1.8);
  if (item.angle) ctx.rotate((item.angle * Math.PI) / 180);
  ctx.font = `${item.size}px ${item.font || 'Arial'}`;
  ctx.fillStyle = '#111';
  if (item.contrast) ctx.fillStyle = '#aaa';
  if (item.dark || item.outlined) ctx.fillStyle = '#fff';
  for (const [i, line] of item.lines.entries()) {
    if (item.outlined) {
      ctx.strokeStyle = '#111';
      ctx.lineWidth = 3;
      ctx.strokeText(line, 0, i * item.size * 1.8);
    }
    ctx.fillText(line, 0, i * item.size * 1.8);
  }
  return canvas.toDataURL(item.jpeg ? 'image/jpeg' : 'image/png', 0.45);
}

async function inputImage(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(2, 2048 / Math.max(bitmap.width, bitmap.height));
  const canvas = new OffscreenCanvas(
    Math.round(bitmap.width * scale),
    Math.round(bitmap.height * scale),
  );
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.convertToBlob({ type: 'image/png' });
}

window.makeCorpus = () =>
  cases.map((item) => ({ ...item, expected: item.lines.join(' '), dataUrl: sourceImage(item) }));
window.createEngine = async (id) => {
  if (id.startsWith('tesseract')) {
    const worker = await createWorker(
      id === 'tesseract-current' || id.startsWith('tesseract-adaptive') ? ['eng', 'rus'] : ['eng'],
      OEM.LSTM_ONLY,
      {
        workerPath: '/node_modules/tesseract.js/dist/worker.min.js',
        corePath: '/node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js',
        langPath: id.endsWith('fast') ? '/__tess_fast' : '/__tess_best',
        workerBlobURL: false,
        cacheMethod: 'none',
        errorHandler: () => {},
      },
    );
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
    window.recognize = async (blob) => {
      if (id === 'tesseract-adaptive') return recognizeOcrImage(worker, blob);
      if (id === 'tesseract-adaptive-rotate')
        return recognizeOcrImage(
          { recognize: (image) => worker.recognize(image, { rotateAuto: true }) },
          blob,
        );
      return (await worker.recognize(blob)).data.text;
    };
  } else if (id.startsWith('paddle')) {
    const { PaddleOCR } = await import('@paddleocr/paddleocr-js');
    const prefixes = {
      'paddle-v5': 'PP-OCRv5_mobile',
      'paddle-v6-tiny': 'PP-OCRv6_tiny',
      'paddle-v6-small': 'PP-OCRv6_small',
    };
    const prefix = prefixes[id];
    const engine = await PaddleOCR.create({
      textDetectionModelName: `${prefix}_det`,
      textRecognitionModelName: `${prefix}_rec`,
      textDetectionModelAsset: { url: `/__models/${prefix}_det_onnx_infer.tar` },
      textRecognitionModelAsset: { url: `/__models/${prefix}_rec_onnx_infer.tar` },
      ortOptions: { backend: 'wasm', numThreads: 1, wasmPaths: '/__paddle_ort/' },
    });
    window.recognize = async (blob) =>
      (await engine.predict(blob))[0].items.map((item) => item.text).join('\n');
  } else if (id.startsWith('scribe')) {
    const scribeUrl = '/node_modules/scribe.js-ocr/scribe.js';
    const { default: scribe } = await import(/* @vite-ignore */ scribeUrl);
    scribe.opt.workerN = 1;
    scribe.opt.langPath = `${location.origin}/node_modules/@tesseract.js-data/eng/4.0.0`;
    window.recognize = async (blob) => {
      const doc = await scribe.openDocument([
        new File([blob], 'screenshot.png', { type: 'image/png' }),
      ]);
      try {
        await doc.recognize({
          langs: ['eng'],
          modeAdv: id.endsWith('speed') ? 'lstm' : 'combined',
        });
        return await doc.exportData('txt');
      } finally {
        await doc.close();
      }
    };
  } else if (id === 'florence') {
    const { Florence2ForConditionalGeneration, AutoProcessor, RawImage, env } =
      await import('@huggingface/transformers');
    env.remoteHost = `${location.origin}/__hf/`;
    env.allowLocalModels = false;
    env.useWasmCache = false;
    env.backends.onnx.wasm.wasmPaths = '/__transformers_ort/';
    env.backends.onnx.wasm.numThreads = 1;
    const modelId = 'onnx-community/Florence-2-base-ft';
    const revision = 'e88a44eaf3791a35eae0c5a47b3dbcd36e67eb6f';
    const model = await Florence2ForConditionalGeneration.from_pretrained(modelId, {
      revision,
      device: 'wasm',
      dtype: 'q8',
    });
    const processor = await AutoProcessor.from_pretrained(modelId, { revision });
    window.recognize = async (blob) => {
      const image = await RawImage.fromBlob(blob);
      const inputs = await processor(image, processor.construct_prompts('<OCR>'));
      const tokens = await model.generate({ ...inputs, max_new_tokens: 256 });
      const text = processor.batch_decode(tokens, { skip_special_tokens: false })[0];
      return processor.post_process_generation(text, '<OCR>', image.size)['<OCR>'];
    };
  } else {
    const { pipeline, env } = await import('@huggingface/transformers');
    env.remoteHost = `${location.origin}/__hf/`;
    env.allowLocalModels = false;
    env.useWasmCache = false;
    env.backends.onnx.wasm.wasmPaths = '/__transformers_ort/';
    env.backends.onnx.wasm.numThreads = 1;
    const engine = await pipeline('image-to-text', 'Xenova/trocr-small-printed', {
      revision: '56c1626ea0b4aab378f3228235be2e824d4256bd',
      dtype: 'q8',
      device: 'wasm',
    });
    window.recognize = async (blob) => {
      const url = URL.createObjectURL(blob);
      try {
        return (await engine(url, { max_new_tokens: 128 }))[0].generated_text;
      } finally {
        URL.revokeObjectURL(url);
      }
    };
  }
};
window.runCase = async (item) => {
  const start = performance.now();
  const blob = await inputImage(item.dataUrl);
  const text = await window.recognize(blob);
  return { text: text.trim(), ms: performance.now() - start };
};
