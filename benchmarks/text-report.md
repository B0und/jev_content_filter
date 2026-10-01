# AI-generated-text detector comparison

**Evaluation date:** 2026-10-01  
**Decision:** use the pinned E5-small LoRA detector as the local candidate. It is the smallest model tested and ranked best by ROC-AUC on this tweet corpus, but its measured false-positive rate is too high to treat its score as evidence of authorship. Retain the product's existing 0.65 cutoff as a conservative starting point only; it still flags 10 of 60 human-labeled examples and misses 29 of 60 generated examples. Do not use this result to auto-remove content or claim that a person used AI.

## Measured comparison

The same 120 cases were scored by both local models in Chromium CPU/WASM and by the authenticated production Jev question run. The table uses `aiGenerated >= 0.50`; AUC uses the continuous AI score and is threshold-independent. All local inference requests succeeded (0 errors per model); the Jev run matched all 120 case IDs (0 missing/error rows).

| Detector                       | q8 weight bytes | Accuracy | Precision | Recall | Specificity |    F1 |   ROC-AUC | Median / p95 inference |
| ------------------------------ | --------------: | -------: | --------: | -----: | ----------: | ----: | --------: | ---------------------: |
| E5-small LoRA (selected)       |      34,157,539 |    0.708 |     0.687 |  0.767 |       0.650 | 0.724 | **0.759** |   **15.95 / 27.50 ms** |
| TMR RoBERTa-base               |     125,855,418 |    0.575 |     0.544 |  0.933 |       0.217 | 0.687 |     0.689 |       53.15 / 89.20 ms |
| Jev, current production prompt |               — |    0.525 |     1.000 |  0.050 |       1.000 | 0.095 |     0.703 |     374.23 / 736.27 ms |

At the product's existing **0.65** cutoff, E5 scores accuracy 0.675, precision 0.756, recall 0.517, specificity 0.833, F1 0.614, and AUC 0.759 (TP/FP/TN/FN = 31/10/50/29). TMR scores 0.600 accuracy, 0.563 precision, 0.900 recall, 0.300 specificity, 0.692 F1, and 0.689 AUC (54/42/18/6). Jev predicts all 120 cases as human at this cutoff (0/0/60/60; AUC remains 0.703). The exact score and per-case outputs are in [`text-results.json`](text-results.json); threshold sweeps at 0.50, 0.65, 0.85, and 0.90 are stored there too.

E5 threshold sensitivity on this sample:

| Cutoff | TP / FP / TN / FN | Precision | Recall | Specificity |    F1 |
| -----: | ----------------: | --------: | -----: | ----------: | ----: |
|   0.50 | 46 / 21 / 39 / 14 |     0.687 |  0.767 |       0.650 | 0.724 |
|   0.65 | 31 / 10 / 50 / 29 |     0.756 |  0.517 |       0.833 | 0.614 |
|   0.85 |   6 / 2 / 58 / 54 |     0.750 |  0.100 |       0.967 | 0.176 |
|   0.90 |   2 / 0 / 60 / 58 |     1.000 |  0.033 |       1.000 | 0.065 |

The 0.85/0.90 rows demonstrate the tradeoff, not a tuned recommendation: nearly all generated examples are missed. These cutoffs were not selected using a separate validation set. Scores are classifier softmax outputs, not calibrated probabilities of authorship.

For texts under 80 characters (45 cases: 16 generated, 29 human), E5 had 12 TP, 7 FP, 22 TN, and 4 FN (accuracy 0.756, F1 0.686, AUC 0.793). TMR had 13 TP, 21 FP, 8 TN, and 3 FN (accuracy 0.467, F1 0.520, AUC 0.591). Jev had 0 TP, 0 FP, 29 TN, and 16 FN at 0.50 (accuracy 0.644, F1 0, AUC 0.613). The short-text cohort is small; do not generalize these numbers to other short messages.

**Interpretation:** E5 is the strongest local candidate on this evaluation and has about one quarter of TMR's q8 weight bytes; its median per-text latency was about 3.3× lower. Its false positives are still substantial: at 0.50 it flags 21/60 human-labeled tweets, and at 0.65 it flags 10/60. TMR finds more generated examples but calls 47/60 human tweets AI at 0.50. Jev's high precision at 0.50 is based on only three positive predictions; its low recall does not mean its scores have no ranking signal (AUC 0.703). This is one 120-example, domain-specific comparison without confidence intervals, not evidence of general superiority over Jev.

## Models and browser deployment

| Candidate                   | Pinned Transformers.js model revision                                                                                                                                                                                                  | Architecture, labels, and input                                                                                              | License and q8 artifact                                                                                                                                                                                                                                |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Selected: E5-small LoRA** | [`onnx-community/e5-small-lora-ai-generated-detector-ONNX`](https://huggingface.co/onnx-community/e5-small-lora-ai-generated-detector-ONNX/tree/02919a911bb647ceac84de99afb00ea2da8c2725) @ `02919a911bb647ceac84de99afb00ea2da8c2725` | BERT/E5-small sequence classifier (12 layers, hidden size 384, 512 position limit); class 0 = human, class 1 = AI-generated. | Upstream [`MayZhou` card](https://huggingface.co/MayZhou/e5-small-lora-ai-generated-detector) declares MIT; converted ONNX card has no license metadata, so verify derivative redistribution terms. `onnx/model_quantized.onnx`: **34,157,539 bytes**. |
| TMR RoBERTa-base            | [`onnx-community/tmr-ai-text-detector-ONNX`](https://huggingface.co/onnx-community/tmr-ai-text-detector-ONNX/tree/b9aa251e5bcda7e429fcc936767d921435945b60) @ `b9aa251e5bcda7e429fcc936767d921435945b60`                               | RoBERTa-base sequence classifier (125M parameters); `id2label`: 0 human, 1 AI; config position limit 514.                    | ONNX and upstream cards declare MIT. `onnx/model_quantized.onnx`: **125,855,418 bytes**.                                                                                                                                                               |

Both are specialized text classifiers, preferable here to a generative vision-language model. The measured path used `@huggingface/transformers` **4.3.0**, q8 ONNX weights, and ONNX Runtime Web CPU/WASM at one thread in Headless Chromium 153 on Linux x64. The reported weight bytes cover only the quantized ONNX file, not tokenizer/config/runtime assets. Cold model setup/download took 10.4 s for E5 and 21.2 s for TMR in this run; this is one network/browser run, not a controlled startup-time comparison. Per-text median/p95 timings exclude model loading.

For production, fetch the selected model on demand via Transformers.js with its exact `revision` and `dtype: 'q8'`, then use the extension's browser cache; do not bundle the 34 MB weight file. The classification itself runs locally in WASM after assets are available. The E5 tokenizer config's `model_max_length` is an enormous sentinel rather than its actual 512-position capacity, so callers must pass an explicit token limit. The adapter uses `min(512, tokenizer.model_max_length, model.config.max_position_embeddings)` and tokenizes with truncation enabled; this avoids silently relying on the sentinel. The positive mapping (class 1) comes from the upstream card. See [`src/inference/ai-text.ts`](../src/inference/ai-text.ts) and the [Transformers.js documentation](https://huggingface.co/docs/transformers.js/en/index).

The E5 upstream card reports RAID accuracy 89.0%, F1 0.887, and AUC 0.976 after fine-tuning, and says it trained on 10,000 Twitter samples plus 10,000 GPT-4o-mini rewrites as well as RAID text. TMR's card reports RAID leaderboard AUROC 99.28% across settings and a 2.61% FPR on its own 100k held-out evaluation. These are author/card-reported scores on different RAID evaluations, **not** results reproduced here or directly comparable with this TweetEval-derived test. The shared Twitter domain and E5's Twitter/GPT-4o-mini training create a possible domain-overlap risk; row-level overlap was not independently checked. TMR's reported in-domain scores did not transfer to this short social-text sample.

## Corpus and method

The corpus is the pinned `gpt4o` configuration, `test` split of [`redasers/Unmasking-the-Imposters`](https://huggingface.co/datasets/redasers/Unmasking-the-Imposters/tree/48d1eee50c389d12f49bb0af285a37dba4d23a6a): 886 rows, 443 original human TweetEval tweets and 443 GPT-4o-generated texts, each no longer than 280 characters. The dataset card declares **CC BY 4.0**. The underlying TweetEval source data may have additional terms and the card warns of potentially sensitive social-media content; consult the [dataset paper](https://aclanthology.org/2025.coling-main.607/) and dataset card before redistributing or using outside this benchmark.

The benchmark fixture contains a deterministic, balanced subset of 120 (60 per label), selected without replacement by FNV-1a hash of `label:row_idx`, stratified by character-length bin. Source text is unchanged. Its exact quotas, row indices, provenance, and text are recorded in [`text-cases.json`](text-cases.json). Dataset labels establish the benchmark classes; they do not verify the authorship of an individual post beyond the dataset's collection/generation procedure. The earlier eight synthetic AI-only cases in the shared benchmark were excluded from the primary comparison because they have no human controls.

Both local models were evaluated on all 120 cases in a single browser session, with warm-up separated from timed per-case inference. Jev's Vercel AI Gateway run used the current production question on those same case IDs; the provider reported no pinned weight revision. This is an authentic matched baseline, not a public benchmark. A public 2026 evaluation of Jev covers 37 general decision datasets, but not AI-authorship detection; it notes that binary probabilities can rank examples well while sitting poorly relative to a fixed 0.50 threshold ([Deußer et al., arXiv:2609.37647](https://arxiv.org/abs/2609.37647)). TypeSafe's [Jev announcement](https://typesafe.ai/blog/introducing-system-one-models-and-jev) describes general decision use cases, not an authorship-detection score. The observed low Jev recall at 0.50 should therefore not be read as a definitive model comparison or as a threshold calibrated for this prompt.

## Reproducibility artifacts

- [`text-cases.json`](text-cases.json): complete pinned sample and provenance.
- [`text-runner.html`](text-runner.html) / [`text-runner.js`](text-runner.js): browser inference page for the two pinned ONNX models.
- [`text-playwright.mjs`](text-playwright.mjs): headless Chromium runner; merges the matched Jev output when present.
- [`text-metrics.js`](text-metrics.js): confusion metrics, F1, AUC, length-bin and latency calculations.
- [`text-results.json`](text-results.json): full per-case scores, errors, timing summaries, metrics, and threshold sweeps.
- [`text-comparison.json`](text-comparison.json): compact importable cases and candidate solutions for the benchmark UI.
- [`text-jev-results.json`](text-jev-results.json): raw matched Jev score/latency snapshot.

### Primary sources

- [E5 converted model card and pinned repository](https://huggingface.co/onnx-community/e5-small-lora-ai-generated-detector-ONNX), [upstream card](https://huggingface.co/MayZhou/e5-small-lora-ai-generated-detector), and [pinned tokenizer configuration](https://huggingface.co/onnx-community/e5-small-lora-ai-generated-detector-ONNX/blob/02919a911bb647ceac84de99afb00ea2da8c2725/tokenizer_config.json).
- [TMR converted model card and pinned repository](https://huggingface.co/onnx-community/tmr-ai-text-detector-ONNX), [upstream card](https://huggingface.co/Oxidane/tmr-ai-text-detector).
- [Dataset card/revision](https://huggingface.co/datasets/redasers/Unmasking-the-Imposters/tree/48d1eee50c389d12f49bb0af285a37dba4d23a6a) and [COLING 2025 paper](https://aclanthology.org/2025.coling-main.607/).
- [Transformers.js documentation](https://huggingface.co/docs/transformers.js/en/index); [`@huggingface/transformers` 4.3.0](https://www.npmjs.com/package/@huggingface/transformers).
- [Jev broad evaluation](https://arxiv.org/abs/2609.37647) and [TypeSafe's Jev overview](https://typesafe.ai/blog/introducing-system-one-models-and-jev).
