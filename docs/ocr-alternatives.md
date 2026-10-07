# Browser OCR benchmark and decision

Measured October 7, 2026. Exact UTC timestamps, outputs, timings, asset sizes,
and hashes are in [the results](../benchmarks/ocr-results.json).

## Decision

Use Tesseract.js 7 with the existing lazy English/Russian packs and a contrast
retry for uncertain text. It meets the extension's size and MV3 constraints.
The installed extension averaged **122 ms** across nine screenshot cases,
including preprocessing and message round trips. No runtime or model files were
added; the complete extension still builds to **38.81 MB uncompressed**.

PaddleOCR PP-OCRv6 tiny wins text accuracy on this corpus. Its stock SDK fails
in an actual MV3 extension, however, and its runtime packaging is substantially
larger. Keeping Tesseract is a constraint-based choice, not a claim that it reads
images better than Paddle.

The selected retry separates bright lettering from its background when the first
pass reports confidence below 80 and returns nonempty text. It retains the complete
first transcript and appends a differing, more confident contrast reading.
This preserves dim words that thresholding can erase. A failed optional retry
returns the original reading and releases its worker for the next request.
Confidence is an engine heuristic, not a probability.
This recovers `SEND NUDES` from the outlined caption the original pipeline missed.
It still misreads `sex` as mixed Cyrillic/Latin `5ех` in the tilted case.
Automatic rotation was also tried and made that case worse, so it is excluded.

## Measured results

Chromium 153.0.8010.12, Linux 6.18.54-2-lts, AMD Ryzen 7 7700. One OCR worker / one
ONNX thread. Three sequential runs per image; this table averages repetitions two
and three across nine multiline screenshots. CER is normalized character error
rate; lower is better. Terms measure exact recovery of 13 occurrences of `nude`,
`nudes`, `naked`, `sex`, `sexual`, `explicit`, or `porn`. This is not classifier
accuracy: factual discussion can contain these terms without being sexual bait.

| Engine/configuration                           |       CER | Terms recovered |  Warm mean |   Warm p95 | First use¹ |
| ---------------------------------------------- | --------: | --------------: | ---------: | ---------: | ---------: |
| Tesseract original, English + Russian best-int |     3.65% |           11/13 |     106 ms |     185 ms |     457 ms |
| **Tesseract selected, contrast retry**         | **8.97%** |       **12/13** | **123 ms** | **325 ms** | **460 ms** |
| Tesseract English best-int                     |     3.19% |           12/13 |      95 ms |     151 ms |     351 ms |
| Tesseract English fast                         |     2.43% |           12/13 |      71 ms |     122 ms |     290 ms |
| PaddleOCR v5 mobile                            |        0% |           13/13 |     467 ms |     765 ms |   2,213 ms |
| PaddleOCR v6 tiny                              |        0% |           13/13 |     264 ms |     449 ms |   1,410 ms |
| PaddleOCR v6 small                             |     0.15% |           12/13 |     813 ms |   1,389 ms |   2,524 ms |
| Scribe speed, LSTM                             |     5.93% |            9/13 |      62 ms |      99 ms |     768 ms |
| Scribe quality, combined                       |     5.93% |            9/13 |     104 ms |     173 ms |     864 ms |
| TrOCR small printed q8, whole screenshots²     |   129.03% |            0/13 |     799 ms |   1,421 ms |   1,924 ms |
| Florence-2 base ft q8, `<OCR>`                 |     3.50% |           12/13 |   6,878 ms |   7,026 ms |   9,299 ms |

The selected output retains both readings on the outlined image. Extra first-pass
garble increases its CER; the retry improves term recovery, not transcript
cleanliness. Other images in this corpus retain a single reading.

¹ Initialization plus the first large screenshot, with model/language bytes
already on disk and served locally into a fresh browser context. These are cold
worker/model initialization times, **not internet download times**. Scribe also
loads local fonts and supporting files on first use.

² [TrOCR expects a single text line](https://huggingface.co/microsoft/trocr-small-printed).
Its whole-image row is a compatibility diagnostic, not a fair accuracy ranking.
On four separate line crops it averaged 624 ms, read 2/4 lines exactly, had 25%
CER, and recovered 3/4 terms. All Tesseract, Paddle, and Scribe configurations read
those four lines exactly. Florence read 1/4 exactly.

On the no-text image, Tesseract and Scribe returned empty text. Paddle v5 returned
`•`; Paddle v6, TrOCR, and Florence returned `0` or `1`. This is a small negative
control, not a measured false-positive rate.

## Downloads and extension compatibility

Sizes are decimal MB. Downloads are separate from executable package files.
Benchmark dependencies are dev-only and absent from the extension.

| Candidate          |                                  On-demand model data | Runtime considerations                                                     |
| ------------------ | ----------------------------------------------------: | -------------------------------------------------------------------------- |
| Tesseract best-int |           2.95 MB English; 2.68 MB Russian separately | Existing 3.90 MB SIMD LSTM core + 0.11 MB worker; IndexedDB language cache |
| Tesseract fast     |                                       1.98 MB English | Same core; misses outlined lettering without preprocessing                 |
| Paddle v5 mobile   |               21.54 MB detector + recognizer archives | OpenCV, ONNX, and SDK worker; MV3 CSP failure                              |
| Paddle v6 tiny     |                6.32 MB detector + recognizer archives | Same runtime/CSP issue                                                     |
| Paddle v6 small    |               31.21 MB detector + recognizer archives | Same runtime/CSP issue                                                     |
| TrOCR q8           |          63.61 MB ONNX weights, plus tokenizer/config | Needs line detection/crops; already-installed Transformers/ONNX runtime    |
| Florence q8        |         274.97 MB ONNX weights, plus tokenizer/config | Already-installed runtime, but seconds per image                           |
| Scribe 0.16.1      | 10.92 MB local combined English traineddata used here | Document/fonts/worker machinery; AGPL-3.0; no accuracy gain here           |

The [Paddle MV3 probe](../benchmarks/ocr-extension-results.json) bundles the actual
SDK, installs it in Chromium, and records the CSP error. OpenCV 4.10.0-release.1
calls `new Function` during initialization. `wasm-unsafe-eval` does not permit it;
see the [Chrome CSP reference](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy).

The default standalone probe was 64.80 MB uncompressed. A
[WASM-only external-runtime build](../benchmarks/ocr-extension-results-wasm.json)
reduced that to 36.13 MB but still failed CSP. That build contains a 10.48 MB main
bundle, an unused 11.34 MB SDK worker, and a 14.24 MB ONNX runtime. These are
measured standalone sizes, not unavoidable minimum sizes or the exact increment
to this extension. Runtime sharing and removing unused worker assets could reduce
them further. A sandbox or compatible OpenCV build would still be needed.

The [Paddle SDK](https://github.com/PaddlePaddle/PaddleOCR/blob/main/paddleocr-js/packages/core/README.md)
defines the measured v5/v6 configurations. Its v5 English configuration uses
multilingual mobile models; its loader does not itself add persistent caching.
[Scribe's API](https://github.com/scribeocr/scribe.js/blob/master/docs/API.md)
defines the LSTM/combined modes. [Florence's browser model card](https://huggingface.co/onnx-community/Florence-2-base-ft)
provides its full-image OCR API. Tesseract's
[FAQ](https://github.com/naptha/tesseract.js/blob/master/docs/faq.md)
describes the language-data cache retained by the selected implementation.

## Reproduction and limits

```sh
npm ci
node benchmarks/ocr-benchmark.mjs
node benchmarks/ocr-metrics.mjs benchmarks/ocr-results-all.json
node benchmarks/ocr-extension-probe.mjs
node benchmarks/ocr-extension-probe.mjs --wasm
node scripts/extension-agent.mjs start
node benchmarks/ocr-installed.mjs
```

Downloads are cached in ignored `benchmarks/.data/ocr`; model revisions are pinned.
The committed [PNG/JPEG corpus](../benchmarks/ocr-fixtures) fixes the pixels across
machines. Generation instructions and ground truth remain in
[the runner](../benchmarks/ocr-runner.js). Every engine receives the same white
background and PNG preprocessing, scaled by `min(2, 2048 / maxEdge)`.

The 14 images comprise nine multiline screenshots, four line crops, and one
negative control. They cover 14–36 px text, light/dark backgrounds, low contrast,
JPEG compression, serif text, a five-degree tilt, and outlined lettering.
They are synthetic diagnostics, not a representative or held-out X dataset.
The contrast retry was developed on this corpus and needs validation on real
posts. These results do not establish provider accuracy, memory peaks, laptop
performance, or multilingual ranking.

Florence was interrupted by a development reload after seven cases. The remaining
seven completed after reinitialization; each retains two warm samples. HMR is
disabled in the final runner.

[Installed-extension timings](../benchmarks/ocr-installed-results.json) averaged
122.4 ms across 18 warm requests for nine screenshots. They bypass the text cache,
include preprocessing and extension message round trips, and exclude image
fetching and provider classification. Browser tests verify that an innocent
caption is filtered when its image contains the outlined wording, and that the
original Russian/English extraction still works.
