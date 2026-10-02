import * as ort from 'onnxruntime-web/wasm';

const result = document.querySelector('#result');
const files = ['reported-video-poster.jpg', 'reported-quote.png', 'second-post.jpg'];
const labels = ['general', 'sensitive', 'questionable', 'explicit'];

function image(file) {
  const img = new Image();
  img.src = `/probe/${file}`;
  return new Promise((resolve, reject) => {
    img.onload = () => resolve(img);
    img.onerror = reject;
  });
}

function inputFor(img, size) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(img, 0, 0, size, size);
  const pixels = ctx.getImageData(0, 0, size, size).data;
  const data = new Float32Array(3 * size * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const p = (y * size + x) * 4;
      const q = y * size + x;
      data[q] = (pixels[p] / 255) * 2 - 1;
      data[size * size + q] = (pixels[p + 1] / 255) * 2 - 1;
      data[2 * size * size + q] = (pixels[p + 2] / 255) * 2 - 1;
    }
  return new ort.Tensor('float32', data, [1, 3, size, size]);
}

async function main() {
  ort.env.wasm.wasmPaths = '/ort/';
  const session = await ort.InferenceSession.create('/model/anime-dbrating.onnx', {
    executionProviders: ['wasm'],
  });
  const input = session.inputNames[0];
  const output = session.outputNames[0];
  const shape = session.inputMetadata?.[input]?.dimensions ?? null;
  const size = Number(shape?.at(-1)) || 384;
  const outputs = [];
  for (const file of files) {
    const started = performance.now();
    const bitmap = await image(file);
    const result = await session.run({ [input]: inputFor(bitmap, size) });
    const values = Array.from(result[output].data);
    outputs.push({
      file,
      input: [1, 3, size, size],
      scores: Object.fromEntries(labels.map((label, i) => [label, values[i]])),
      latencyMs: performance.now() - started,
    });
  }
  document.querySelector('#result').dataset.state = 'done';
  document.querySelector('#result').textContent = JSON.stringify(
    {
      model: 'deepghs/anime_dbrating/mobilenetv3_large_100_v0_ls0.2',
      revision: '7af21db648acdeb74f5c334abda9dd7403407b3c',
      outputs,
    },
    null,
    2,
  );
}
main().catch((error) => {
  result.dataset.state = 'failed';
  result.textContent = JSON.stringify({ error: String(error), stack: error?.stack }, null, 2);
});
