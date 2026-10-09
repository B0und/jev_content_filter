# Independent Porn verification

Research and evaluation: 2026-10-09.

## Failure and decision

The user reported an ordinary red-background article cover at https://x.com/oxfrancesco_/status/2108507916743414120. The actual production inference worker returned NSFWJS Porn **0.6830307**, above the default 0.6 cutoff. The supplied cover is public; no signed-in feed images, cookies or keys were saved into fixtures.

The new pipeline requires agreement between that Porn classifier and an independent Marqo NSFW detector: `porn = min(NSFWJS Porn, Marqo NSFW)`. Marqo's broad binary NSFW label also covers drawings, so it cannot honestly replace the separate Porn/Hentai/Suggestive category meanings by itself. Existing Anime DBRating verification for Hentai remains separate. Verification failure omits Porn, reports a warning and retries; partial results are not cached. The cache revision includes the new model revision and exported artifact hash. This is an agreement score, not a calibrated probability.

## Candidate comparison

[Marqo's model card](https://huggingface.co/Marqo/nsfw-image-detection-384/blob/0c26ec22111b83f106d72a55f611ec35962bcb65/README.md) declares Apache-2.0, a small ViT-tiny model and a proprietary 220,000-image dataset spanning photos, drawings and generated material. Its reported aggregate accuracy is not independent evidence on X posts. [Pinned configuration](https://huggingface.co/Marqo/nsfw-image-detection-384/blob/0c26ec22111b83f106d72a55f611ec35962bcb65/config.json) gives NSFW/SFW label order, 384px RGB input, bicubic short-edge resize/center crop, and mean/std 0.5. Softmax is applied once to logits.

The already evaluated [Falconsai ONNX conversion](https://huggingface.co/onnx-community/nsfw_image_detection-ONNX/tree/1ceb3c7fe1e9f3f2507e6df577437f23a9149fd5) was much larger and slower in this repository's original benchmark. [SigLIP2 explicit-content](https://huggingface.co/prithivMLmods/siglip2-x256p32-explicit-content) has separate categories, but its roughly 378 MB weights and required browser export make it a more expensive comparator. Anatomical detectors can supply localized evidence, but missing exposed anatomy does not prove safety. Earlier alternatives and their limitations are recorded in [image-detector-research.md](image-detector-research.md).

## Export and browser behavior

The upstream Marqo repository has safetensors weights, rather than an ONNX artifact. `scripts/export-marqo.py` exports the pinned weights with fixed shape `[1,3,384,384]` and opset 17. The evaluated environment used CPU Torch 2.14.1, timm 1.0.30, ONNX 1.23.2 and ONNX Runtime 1.31.0. Create an isolated environment, install these CPU packages with huggingface_hub and safetensors, then run that script. Its parity check includes random input and rejects logit error above 1e-4. Artifact size and SHA-256 are pinned in `src/inference/model-catalog.ts`.

The reported image's reference NSFW score was **0.0772132**. Identical-tensor Python/ONNX maximum logit difference was **4.77e-7**. Actual extension WASM inference produced Porn **0.0787269** after agreement, without changing the user cutoff. Browser high-quality canvas interpolation differs slightly from Pillow bicubic; these are measured outputs, not a claim of pixel-identical preprocessing. Virtual resize/crop coordinates bound canvas allocation even for extreme aspect ratios. No image is uploaded to a remote provider, and inference sends no new X API calls.

## Evaluation limits

The fixed existing corpus uses dataset-provided X-level labels for 12 positive cases, six licensed ordinary photos, six licensed illustrations, and one older user-reported false positive. X-level labels are broader than an independently audited Porn ground truth; underlying image-rights caveats remain in `benchmarks/image-model-fixtures.json`. No model or threshold was tuned on these cases.

The initial Marqo run retained all 12 positive controls and rejected all 12 available negative controls at 0.5. One cartoon-cat download returned HTTP429 and is excluded, rather than counted as a success. The newly supplied red cover is an additional negative regression measured above. This small source-biased corpus does not establish population precision/recall. Production Chromium tests also exercise solid/gradient/textured red backgrounds, and unit tests verify agreement, failed-verifier omission and retry while preserving other categories. Expand independently labeled ordinary backgrounds, screenshots and borderline adult material before making broader accuracy claims.
