"""Reproduce the bundled Marqo ONNX export; run in an isolated CPU model-export environment."""
import argparse
import hashlib
from pathlib import Path

import numpy as np
import onnxruntime
import timm
import torch
from huggingface_hub import hf_hub_download
from safetensors.torch import load_file

parser = argparse.ArgumentParser()
parser.add_argument('--output', default='public/models/marqo-nsfw.onnx')
args = parser.parse_args()
revision = '0c26ec22111b83f106d72a55f611ec35962bcb65'
weights = hf_hub_download('Marqo/nsfw-image-detection-384', 'model.safetensors', revision=revision)
model = timm.create_model('vit_tiny_patch16_384', pretrained=False, num_classes=2).eval()
model.load_state_dict(load_file(weights))
torch.set_num_threads(4)
output = Path(args.output)
output.parent.mkdir(parents=True, exist_ok=True)
example = torch.zeros(1, 3, 384, 384)
torch.onnx.export(model, example, output, input_names=['pixel_values'], output_names=['logits'],
                  opset_version=17, dynamo=False)
session = onnxruntime.InferenceSession(str(output), providers=['CPUExecutionProvider'])
# Use nonconstant inputs too; zero-only parity can hide a broken conversion.
rng = np.random.default_rng(20261009)
max_error = 0.0
for array in [example.numpy(), rng.uniform(-1, 1, (1, 3, 384, 384)).astype(np.float32)]:
    with torch.no_grad():
        reference = model(torch.from_numpy(array)).numpy()
    actual = session.run(None, {'pixel_values': array})[0]
    max_error = max(max_error, float(np.max(np.abs(reference - actual))))
assert max_error < 1e-4, f'Export logit parity failed: {max_error}'
print({'bytes': output.stat().st_size, 'sha256': hashlib.sha256(output.read_bytes()).hexdigest(),
       'maxLogitError': max_error, 'torch': torch.__version__, 'timm': timm.__version__})
