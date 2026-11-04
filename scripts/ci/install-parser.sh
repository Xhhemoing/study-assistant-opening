#!/usr/bin/env bash
# The cache key includes this script; every restore still checks real imports.
set -euo pipefail
: "${PARSER_PYTHON:?PARSER_PYTHON must point to the cached venv}"
if [[ "${PARSER_CACHE_HIT:-false}" != true ]]; then
  # Do not clear an arbitrary path supplied by the environment.
  [[ "$PARSER_PYTHON" == "$PWD/.local/docling-venv/bin/python" ]]
  python -m venv --clear .local/docling-venv
  "$PARSER_PYTHON" -m pip install -r services/parser/requirements-lock.txt
fi
"$PARSER_PYTHON" -m pip check
"$PARSER_PYTHON" - <<'PY'
import docling
import torch
import torchvision
from torchvision.ops import nms
assert torch.version.cuda is None, "Parser CI must use CPU-only torch"
assert '+cpu' in torch.__version__ and '+cpu' in torchvision.__version__
assert nms(torch.tensor([[0., 0., 1., 1.]]), torch.tensor([1.]), 0.5).tolist() == [0]
print(f"Parser imports OK: torch={torch.__version__}, torchvision={torchvision.__version__}")
PY
