import { PaddleOCR } from '@paddleocr/paddleocr-js';

/** Attempt Paddle initialization under the installed MV3 extension's real CSP. */
window.initializeOcr = () =>
  PaddleOCR.create({
    textDetectionModelName: 'PP-OCRv6_tiny_det',
    textRecognitionModelName: 'PP-OCRv6_tiny_rec',
    worker: false,
    ortOptions: { backend: 'wasm', numThreads: 1, wasmPaths: '/ort/' },
  });
