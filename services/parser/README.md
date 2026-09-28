# Opening parser

Use Python 3.13. The checked dependency set is in `requirements-lock.txt`; it pins Docling 2.126.0, pytest 9.1.1 and their platform-specific dependencies. `pyproject.toml` records the direct dependencies. Do not replace the lock with an unpinned Docling install.

From the repository root, in PowerShell 7:

```powershell
$ErrorActionPreference = 'Stop'
python -m venv .local/docling-venv
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$pythonPath = if ($IsWindows) { '.local/docling-venv/Scripts/python.exe' } else { '.local/docling-venv/bin/python' }
$env:PARSER_PYTHON = Join-Path (Get-Location).Path $pythonPath
$env:PARSER_CWD = Join-Path (Get-Location).Path 'services/parser'
$env:HF_HOME = Join-Path (Get-Location).Path '.local/hf-home'
& $env:PARSER_PYTHON -m pip install -r services/parser/requirements-lock.txt
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $env:PARSER_PYTHON -m pip check
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Push-Location $env:PARSER_CWD
try {
    & $env:PARSER_PYTHON -m opening_parser.prepare_models
    if ($LASTEXITCODE -ne 0) { throw 'Parser model setup failed' }
    & $env:PARSER_PYTHON -m opening_parser --check
    if ($LASTEXITCODE -ne 0) { throw 'Parser import check failed' }
} finally { Pop-Location }
& $env:PARSER_PYTHON -m pytest services/parser/tests -q
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

The setup command deliberately enables network access and downloads only the model repositories at the revisions recorded in `model-manifest.json`. Run it during environment preparation, then retain the same `HF_HOME` for the worker. Document conversion forces `HF_HUB_OFFLINE=1`; it never calls the setup module. Missing cache files cause conversion to fail instead of downloading models per document. The layout model uses its recorded revision directly, so a fresh cache does not depend on a mutable `main` reference.

Development defaults resolve from the repository root, including when `npm run worker:dev` launches in `apps/worker`: `.local/docling-venv/Scripts/python.exe` on Windows, `.local/docling-venv/bin/python` on Linux/macOS, and `services/parser` as the module directory. Relative overrides resolve from the same root. CI and production deployments must set `PARSER_PYTHON` and `PARSER_CWD` to absolute deployment paths; production rejects missing settings. `HF_HOME` is optional and defaults to `<repository>/.local/hf-home`. Copy the parser package and its model manifest into `PARSER_CWD` when deploying separately.

Before connecting Redis, PostgreSQL or S3, worker startup checks the executable and working directory, then runs `python -m opening_parser --check` with a 30-second limit. Failures name the relevant settings or the dependency installation command. `--check` validates imports and converter configuration; the actual PDF/PPTX tests additionally exercise the offline models. CI runs both before the existing Node integration suite, including the real two-page PDF → persisted chunks/state → temporary-file cleanup test. No parser test is skipped because Python or its cache is missing.

For direct conversion, run from `PARSER_CWD`:

```powershell
$ErrorActionPreference = 'Stop'
& $env:PARSER_PYTHON -m opening_parser --input /absolute/path/document.pdf --mime application/pdf --max-pages 50
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

The CLI emits one JSON result on stdout. PDF and PPTX text extraction are supported; OCR, image extraction and image semantics remain deferred. Exit codes: 0 success, 2 usage, 3 unsupported MIME, 4 conversion failure/timeout, and 5 page/output bound violation. Node cancellation and capture limits remain in place.

The lock has platform markers, including upstream Linux CUDA dependencies; this is not a custom CPU-only distribution. Windows checks and a Linux workflow definition do not prove a Linux run passed. The repository's actual GitHub `quality` job is the Linux acceptance evidence.
