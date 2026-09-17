# Opening parser

Run tests from the repository root:

```text
./.local/docling-venv/Scripts/python.exe -m pytest services/parser/tests/test_conversion.py -v
```

The CLI is run with `PYTHONPATH=services/parser python -m opening_parser --input PATH --mime MIME --max-pages N`. It emits one JSON result on stdout. Supported MIME types are PDF and PPTX; OCR and image paths are deferred. Exit codes: 0 success, 2 usage, 3 unsupported MIME, 4 conversion failure/timeout, and 5 output bound violation.

Downloaded model provenance is recorded in `model-manifest.json`.
