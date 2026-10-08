# Reducing false Hentai blocks

Research date: 2026-10-08. The reported post was classified as Hentai 97% across four images. The user says its images contain no hentai. This note audits the classifier and primary-source alternatives; it does not claim to have independently inspected or measured those four images.

## The current verification misses the case it should check

In `src/inference/image.ts`, NSFWJS provides five mutually competing classes. The companion Anime DBRating model runs only when `Drawing >= 0.5`. A Hentai score of 0.97 therefore bypasses that model entirely. Even when the companion runs, the implementation changes only `sexy`; it never verifies `hentai`. This is a concrete routing gap, independent of which model proves best on the reported images.

NSFWJS defines Drawing as safe drawings/anime and Hentai as pornographic drawings. Those separate classes cannot make a Drawing-only gate cover likely Hentai. Its published aggregate accuracy is not a guarantee about a high-confidence individual prediction. [NSFWJS source and class definitions](https://github.com/infinitered/nsfwjs)

The current DBRating input follows the author's reference approach: white-composited RGB, direct bilinear resize to 384×384, NCHW float32, and normalization from [0,255] to [-1,1]. Its output already contains scores, so a second softmax would be wrong. The pinned metadata confirms label order `general`, `sensitive`, `questionable`, `explicit`. Canvas interpolation can still differ numerically from Pillow, so compare actual input/output parity on representative images. [Reference classifier](https://github.com/deepghs/imgutils/blob/main/imgutils/generic/classify.py), [pinned label metadata](https://huggingface.co/deepghs/anime_dbrating/blob/7af21db648acdeb74f5c334abda9dd7403407b3c/mobilenetv3_large_100_v0_ls0.2/meta.json)

## First repair

Use the already bundled rating model to verify plausible drawn content, including a high NSFWJS Hentai score. Keep `sensitive` and `questionable` separate from explicit Hentai semantics. A conservative policy can cap a candidate Hentai score by the independent explicit score, then apply the user's threshold. This is a proposed agreement rule, not a calibrated probability or proof of improved recall. Validate both safe and explicit examples before adopting it. Failed verification must not silently present the unverified 97% as a verified result.

Version the whole image pipeline when changing routing or aggregation, invalidate old cached scores, and retain raw per-image outputs in diagnostics. Four-image aggregation can hide which image caused a false positive. Test one safe false-positive image mixed with three safe controls, as well as one explicit image among three safe images.

The DBRating author describes the four ratings as rough estimates with ambiguous boundaries, and recommends anatomical object detection when accurate R-18 decisions are required. Its larger CaFormer variant is offered as a stronger classifier, but is not independently proven superior on X posts. [Author's rating documentation and implementation](https://github.com/deepghs/imgutils/blob/main/imgutils/validate/dbrating.py)

### Sensitive versus questionable

Danbooru's current source groups `general` and `sensitive` under its SFW alias, and `questionable` and `explicit` under NSFW. Its `is_nsfw?` method uses the latter two ratings. This gives a primary-source basis for an illustrated NSFW score of `questionable + explicit`, while reserving `explicit` for Hentai. The exact public rating wiki returned HTTP 403 during this research, so this note does not claim a verified prose definition or list of visual examples for each boundary. [Danbooru's rating aliases and classification](https://github.com/danbooru/danbooru/blob/master/app/models/post.rb)

Dropping `sensitive` intentionally narrows the filter. It can keep mildly suggestive art visible even if a user previously wanted such art filtered. The existing label "Suggestive images" should describe that boundary honestly; `questionable + explicit` is an illustrated NSFW boundary, not all possible suggestiveness. This tradeoff needs safe and mildly suggestive controls as well as explicit cases.

### Drawn-content agreement

For verification routing, `Drawing + Hentai` is better evidence of drawn content than either class alone. A low gate such as 0.2 lets the rating model check uncertain candidates as well as confident Hentai. That gate is an engineering proposal to measure, not a value justified by the model card.

An agreement score `min(Drawing + Hentai, explicit)` can correct explicit anime that NSFWJS mistakenly labels Drawing. For example, Drawing 0.95, Hentai 0.02 and DBRating explicit 0.85 yields 0.85, whereas capping raw Hentai yields only 0.02. The same agreement can suppress safe artwork falsely labeled Hentai when DBRating's explicit score is low. Its limitation is equally concrete: if drawn evidence is 0.4 but explicit is 0.95, the result remains 0.4 and may miss explicit content at the user's threshold.

The minimum is an agreement policy score. It is not an estimated joint probability: the two classifiers are not calibrated measurements of the same event, and taking their minimum does not establish their statistical dependence. Record both raw outputs, document the decision rule, and compare this policy against using DBRating alone on routed candidates. Test routing below, at and above the gate and test explicit art classified as Drawing.

## Candidates worth measuring

Sizes and revisions below were rechecked using the first-party Hub APIs on the research date. Published model-card metrics use different datasets and are not directly comparable.

| Candidate                          | Verified artifact and labels                                                                                       | Assessment                                                                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing DBRating MobileNetV3      | Native ONNX 16,832,684 bytes; four ratings; revision `7af21db648acdeb74f5c334abda9dd7403407b3c`                    | Repair routing first. No added download is needed.                                                                                                                    |
| DBRating CaFormer S36              | Native ONNX 149,591,096 bytes; same ratings and revision                                                           | Larger local comparator. Measure false positives and WASM latency before replacing the bundled model.                                                                 |
| DeepGHS anime censor detector nano | Native ONNX 12,104,146 bytes; anatomical region labels; revision `0cf62fd6b28213b40ae0c0055f92e7ae6a96bdc2`        | Small independent evidence source for explicit anatomy. Absence of detected anatomy does not prove safety: censoring, stylization and occlusion can defeat detection. |
| Marqo tiny ViT 384                 | Safetensors 22,404,720 bytes; NSFW/SFW; revision `0c26ec22111b83f106d72a55f611ec35962bcb65`                        | Best small broader verifier to investigate. Needs ONNX export and parity/runtime checks. Cannot directly preserve Hentai/Porn/Sexy distinctions.                      |
| WD SwinV2 tagger v3                | Native ONNX 467,460,978 bytes; ratings plus explanatory tags; revision `627aef95638667ddcaa3ac8ae625e88ea5b02f51`  | Useful offline comparator; expensive default download and memory cost.                                                                                                |
| SigLIP2 explicit-content patch32   | Safetensors 378,249,612 bytes; anime/hentai/safe/porn/sensual; revision `908bddcb1e1d4e3fe5438d2f1caf4f9ca260d33c` | Direct category replacement candidate. No upstream ONNX artifact was found; export and quantization must be measured. Size alone does not establish quality.          |

Artifact sources: [DBRating API](https://huggingface.co/api/models/deepghs/anime_dbrating?blobs=true), [censor detector API](https://huggingface.co/api/models/deepghs/anime_censor_detection?blobs=true), [Marqo API](https://huggingface.co/api/models/Marqo/nsfw-image-detection-384?blobs=true), [WD API](https://huggingface.co/api/models/SmilingWolf/wd-swinv2-tagger-v3?blobs=true), [SigLIP2 API](https://huggingface.co/api/models/prithivMLmods/siglip2-x256p32-explicit-content?blobs=true).

Marqo's author reports training and testing on 220,000 proprietary images spanning photos, drawings, memes, generated images and Rule 34. Its 98.56% reported accuracy belongs to that dataset. The reference uses `timm`'s resolved evaluation transform, with bicubic interpolation, 384px input and mean/std 0.5. Preserve its center-crop/resize behavior instead of copying the DBRating direct stretch; apply softmax to its logits. [Model card and reference inference](https://huggingface.co/Marqo/nsfw-image-detection-384/raw/0c26ec22111b83f106d72a55f611ec35962bcb65/README.md), [pinned transform config](https://huggingface.co/Marqo/nsfw-image-detection-384/blob/0c26ec22111b83f106d72a55f611ec35962bcb65/config.json)

The anatomy detector uses YOLOv8 and returns bounding boxes for three explicit anatomical classes. It needs its own preprocessing, coordinate restoration and non-maximum suppression; a classifier tensor cannot be reused blindly. [Author's detector implementation](https://github.com/deepghs/imgutils/blob/main/imgutils/detect/censor.py)

WD uses its author's white square padding, BGR channels, NHWC and unnormalized 0–255 inputs. SigLIP2 uses its own image processor and a five-class softmax. Neither should inherit DBRating preprocessing. [WD inference source](https://huggingface.co/spaces/SmilingWolf/wd-tagger/blob/main/app.py), [SigLIP2 model card](https://huggingface.co/prithivMLmods/siglip2-x256p32-explicit-content)

## Vision LLMs

A vision LLM can explain visible evidence and distinguish ordinary game art from explicit acts, but model cards do not establish reliable hentai detection. SmolVLM-256M is a compact local image/text model; its author reports under 1 GB GPU RAM for one-image inference. That is still much larger than the classifiers, and there is no demonstrated moderation accuracy here. Treat it as an experimental comparator rather than a default feed-wide replacement. [SmolVLM author's model card](https://huggingface.co/HuggingFaceTB/SmolVLM-256M-Instruct)

Remote vision verification would send images to a provider, add latency, and potentially spend money. It should be an explicit user-selected mode with a clear budget, rather than silently using the text-provider key. Request structured observed evidence, not an invented percentage, and evaluate that evidence against labeled controls. No paid provider was selected or invoked for this research.

Browser feasibility requires actual runtime measurement. ONNX Runtime Web provides WASM and WebGPU execution paths; GPU support and operator coverage differ. Transformers.js supports WebGPU and quantization choices, but a Python model card alone does not prove an extension-compatible conversion. [ONNX Runtime Web](https://onnxruntime.ai/docs/get-started/with-javascript/web.html), [Transformers.js WebGPU guide](https://huggingface.co/docs/transformers.js/guides/webgpu)

## Tests that can reject a bad replacement

Build a held-out labeled set containing safe game screenshots, clothed anime portraits, group pictures, UI/text overlays, ordinary photos, suggestive illustrations and explicit examples. Include the reported images only with the user's permitted public-media workflow; keep signed-in feed snapshots and credentials out of committed fixtures. Separate image-model correctness from DOM masking tests.

Record per-class precision/recall, safe-image false positives, missed explicit images, per-post outcomes for multi-image posts, browser load time, steady-state latency and memory. Compare the existing pipeline, repaired verification and candidates on identical decoded images. Do not choose a model because it gives the desired answer on one example. Keep a separate calibration set and final test set.

A 97% network output is not automatically a 97% chance the judgment is correct. Calibration research finds modern neural networks often overconfident and shows temperature scaling can help on suitable held-out data. Until feed-specific calibration exists, label percentages as model scores, and document that an agreement-capped score is a policy score. [Guo et al., On Calibration of Modern Neural Networks](https://arxiv.org/abs/1706.04599)
