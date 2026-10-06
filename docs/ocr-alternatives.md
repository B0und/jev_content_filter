# Browser OCR options

Research date: 2026-10-06

## Recommendation

Keep Tesseract.js for this extension and move its language data out of the
package. The current workload is short text in social-media screenshots, where
the extension needs a permissive license, predictable MV3/WASM behavior, and
language packs that can be downloaded only when needed. Tesseract.js supports
more than 100 languages, runs in the browser through WebAssembly, reuses one
worker for multiple images, and caches traineddata in IndexedDB:

- [Tesseract.js README](https://github.com/naptha/tesseract.js/blob/master/README.md)
- [Tesseract.js FAQ: traineddata caching](https://github.com/naptha/tesseract.js/blob/master/docs/faq.md)

This branch packages one SIMD LSTM core and downloads the selected
`traineddata.gz` files from a pinned `naptha/tessdata` commit. The data is not
executable code. The test-only language packages remain dev dependencies so
browser tests can serve deterministic responses without adding them to the
extension output.

## Alternatives considered

### PaddleOCR.js

PaddleOCR now has an official browser SDK, `@paddleocr/paddleocr-js`. It runs
PP-OCR pipelines with ONNX Runtime Web, supports model selection by language,
and reports detection/recognition/total timing metrics. Its docs also describe a
worker mode and custom model archives:

- [PaddleOCR browser deployment](https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/inference_deployment/cross_platform/browser.md)
- [PaddleOCR.js SDK README](https://github.com/PaddlePaddle/PaddleOCR/blob/main/paddleocr-js/packages/core/README.md)

PaddleOCR.js is the most promising candidate to benchmark next. It brings a
detector and recognizer pipeline, OpenCV.js, and model archives. The extension
already has ONNX Runtime, so some runtime code may be reusable. We have not
measured its added package size, English screenshot accuracy, or latency here.
Those measurements are needed before calling it better than Tesseract for this
workload.

### Scribe.js

Scribe.js claims generally better accuracy than Tesseract.js and adds layout and
PDF features. Its own comparison says Tesseract.js is smaller and faster for
PNG/JPEG extraction, while Scribe's quality mode is often 40–90% slower than its
speed mode. Scribe.js is AGPL-3.0, so adopting it would require reviewing the
extension's distribution license:

- [Scribe.js comparison with Tesseract.js](https://github.com/scribeocr/scribe.js/blob/master/docs/scribe_vs_tesseract.md)

### Transformers.js image-to-text models

Transformers.js supports an `image-to-text` pipeline and browser-side model
caching. Modern OCR-capable vision-language models are substantially larger
than a short-text OCR engine, and the JavaScript support/model combination needs
to be validated for MV3 workers before adoption:

- [Transformers.js supported pipelines](https://github.com/huggingface/transformers.js/blob/main/packages/transformers/docs/source/pipelines.md)
- [Transformers.js model caching](https://github.com/huggingface/transformers.js/blob/main/packages/transformers/docs/source/pipelines.md#the-basics)

## Follow-up benchmark

If Tesseract misses too much text on real posts, compare the current path with
PaddleOCR.js on a fixed corpus of English screenshots (small text, stylized
fonts, dark backgrounds, rotated text, and memes). Record first-use download
time, warm recognition time, output quality, extension package size, and memory
use before switching engines.

## Measured Tesseract latency

On 2026-10-07, the installed Chromium extension recognized a synthetic
1100 × 420 English screenshot containing three lines of 36 px Arial text.
Six sequential requests took 294, 255, 255, 248, 246, and 248 ms, averaging
258 ms. All requests returned the expected text. The OCR worker and English
and Russian language packs were already loaded. Requests went directly to
the offscreen inference document, bypassing the extracted-text cache.

This measures preprocessing, recognition, and extension message round trips
on this machine. It excludes image download, first-use model initialization,
language download, queue waiting, and Jev classification. It is a sample for
one screenshot, not a general average across real X images.
