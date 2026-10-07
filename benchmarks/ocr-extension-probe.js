import { PaddleOCR } from '@paddleocr/paddleocr-js';

window.initializeOcr = () =>
  PaddleOCR.create({
    textDetectionModelName: 'PP-OCRv6_tiny_det',
    textRecognitionModelName: 'PP-OCRv6_tiny_rec',
    worker: false,
    ortOptions: { backend: 'wasm', numThreads: 1, wasmPaths: '/ort/' },
  });
