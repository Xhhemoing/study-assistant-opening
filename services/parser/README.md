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

Before connecting Redis, PostgreSQL or S3, worker startup checks the executable and working directory, then runs `python -m opening_parser --check` with a configurable 120-second default limit (`PARSER_PREFLIGHT_TIMEOUT_MS`). Failures name the relevant settings or the dependency installation command. `--check` validates imports and converter configuration; the actual PDF/PPTX tests additionally exercise the offline models. CI runs both before the existing Node integration suite, including the real two-page PDF → persisted chunks/state → temporary-file cleanup test. No parser test is skipped because Python or its cache is missing.

For direct conversion, run from `PARSER_CWD`:

```powershell
$ErrorActionPreference = 'Stop'
& $env:PARSER_PYTHON -m opening_parser --input /absolute/path/document.pdf --mime application/pdf --max-pages 50
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

The default CLI emits one JSON result on stdout. PDF and PPTX text and table extraction are supported. Image extraction and image semantics remain deferred. Exit codes: 0 success, 2 usage, 3 unsupported MIME, 4 conversion failure/timeout, and 5 page/output bound violation. Node cancellation and capture limits remain in place.

### A2-R02: single-process PDF ranges (JSONL)

From `services/parser`, an explicit multi-range invocation is:

```sh
python -m opening_parser --input /absolute/path/document.pdf --mime application/pdf --max-pages 2000 --timeout-seconds 240 --ranges '1-10,11-20,31-40'
```

`--ranges` accepts positive inclusive physical page ranges in strictly ascending, non-overlapping order; gaps are allowed. Empty/malformed, overlapping, descending or out-of-document ranges fail with exit 5 before converter initialization. The full PDF count must also fit `--max-pages`. Non-PDF input and combinations with `--inspect-pdf`, `--page-start`, `--page-end` or `--check` are usage errors (exit 2). Existing `convert(path, timeout, page_range=None)`, inspection, single-range and PPTX paths retain their prior API/output.

The process creates **one** `DocumentConverter`, then calls its `.convert(path, page_range=(start, end))` serially. Each completed segment writes and immediately flushes exactly one compact UTF-8 JSON line:

```json
{"range":[11,12],"pages":[{"page":11,"text":"physical page eleven","imagePath":null},{"page":12,"text":"","imagePath":null}]}
{"range":[15,16],"error":"conversion_failed"}
```

Errors are limited to `timeout`, `invalid_output` and `conversion_failed`. A successful line requires the exact requested physical page set from the existing pre-merge extractor; rebased, missing/duplicate/foreign assemblies and partial conversion results never become successful blank pages. Text uses the existing 200,000-character per-page cap and truncation marker. Python/native stdout and logging during multi-range work are kept off the protocol stream (diagnostics go to stderr).

The **combined stdout limit is 8 MiB**, counting every JSON envelope, UTF-8 byte and newline, including error lines. Space for pending failure records is reserved before emitting success. A segment whose successful payload cannot fit becomes `invalid_output`; subsequent ranges can continue within the budget, and the final exit is 5. If even the minimal error budget cannot fit, the invocation exits 5 with no stdout and no converter initialization. Other invalid segment output and non-timeout conversion failures emit their line and continue; the final exit is 4. All successful segments exit 0.

A conversion-thread timeout emits and flushes the current `timeout` record and **ends the standalone CLI with exit 4 without processing remaining ranges**. The CLI uses a hard exit after flushing because converter executors/native threads can otherwise keep Python alive during shutdown. Embedded `main()` calls retain the return-value API and must discard the invocation or explicitly opt into CLI termination. The Node consumer persists the timeout under the existing fence, rejects the callback and kills the process group so descendants cannot consume the remaining batch budget. Previously saved successes remain reusable; unattempted ranges have no line. Initialization failure emits `conversion_failed` for each requested range without retrying initialization.

Stdlib-only acceptance commands for the parent/main thread (no Docling/model inference):

```sh
PYTHONPATH=services/parser python3 -m unittest discover -s services/parser/tests -p 'test_ranges*.py' -v
PYTHONPATH=services/parser python3 -m unittest discover -s services/parser/tests -p test_segments_health_unit.py -v
```

These fake-converter tests include a real child-process pipe/flush and native-stdout isolation check, not real document conversion or a model performance claim.

## Optional Offline OCR

OCR is off by default. To enable PDF OCR, explicitly set `PARSER_OCR_MODEL_DIR` to an absolute directory containing these RapidOCR 3.9.2 Torch PP-OCRv4 files:

- `ch_PP-OCRv4_det_mobile.pth`
- `ch_ptocr_mobile_v2.0_cls_mobile.pth`
- `ch_PP-OCRv4_rec_mobile.pth`
- `ppocr_keys_v1.txt`

Prepare models online before worker startup, using RapidOCR's supported `EngineType.TORCH`, `OCRVersion.PPOCRV4`, and `ModelType.MOBILE` configuration for Det/Cls/Rec. `Global.model_root_dir` must be a Python `Path`, not a string. RapidOCR may place the recognition dictionary in its installed `models` directory; copy it into the configured OCR directory too. No uploaded document is involved in model setup. Runtime uses explicit local model and dictionary paths; missing files fail the parser check instead of triggering a document-time download. The existing locked Torch and RapidOCR dependencies are sufficient; ONNXRuntime is not required for this backend.

Restart the worker with the environment variable to apply the setting. This does not reparse existing materials. Do not overwrite a cited version's chunks to enable OCR retroactively; existing citation targets must remain stable. OCR output, especially formulas, needs comparison with the original and is not proof of semantic correctness. A real single-page image-based PDF conversion succeeded locally; a 72-page CPU OCR probe exceeded 1,000 seconds. The bounded PDF segments below address recovery/CPU cancellation, not recognition accuracy or the usability of that historical 72-page example.

## OPT-02a: Worker OCR health and resumable PDF segments

Worker `all`/`parser` measures OCR in **its own** Python environment. `learning` neither invokes Python nor overwrites parser health. The probe `python -m opening_parser.ocr` returns a path-free JSON observation:

- `not_configured`: no explicit OCR directory; text PDFs remain supported.
- `missing_files`: directory is not absolute/available, or one of the four named files is missing, empty, or unreadable.
- `preflight_failed`: import/model initialization/inference failed, malformed probe output, or the 60-second outer deadline expired.
- `ready`: directory and all four files are readable, and detection, classification **and** recognition each completed on a tiny generated 64×192 image. A blank detector result cannot silently skip classification/recognition. This is liveness, **not** OCR accuracy.

All model/dictionary paths are explicit. Hugging Face offline mode remains forced; RapidOCR's own download fallback is also disabled, including removal-after-stat races. No user document or paid model is used. Configured but unhealthy OCR refuses new parser consumers. Startup/import errors still fail closed. DB reports contain status/booleans/allowed missing filenames/inference duration, never model paths or stderr. Reports expire after 10 minutes; refresh with a **new probe**, not a timestamp-only heartbeat, every 5 minutes. A healthy report from one consumer does not mask an unhealthy live consumer. No fresh report (including an unreadable/missing table) is Web `unknown`, not `ready` or `not_configured`; OCR remains a soft hint and never blocks text tutoring.

PDF jobs first run a cheap `--inspect-pdf` count (30-second limit), then request all missing ranges in one `--ranges` process, **5 pages by default**. The converter initializes its PDF pipeline once before any range timer starts; creation/warmup failures follow the initialization-failure protocol. Each range keeps a **240-second conversion timeout**; Node allows another **240 seconds for startup** on the total batch deadline. Conversion duration and initialization duration are written to stderr, never protocol stdout. `PARSER_PDF_SEGMENT_PAGES` accepts integers 1–100 (default 5), and `PARSER_PDF_SEGMENT_TIMEOUT_SECONDS` accepts integers 30–3600 (default 240); worker startup validates them and passes them to `createParseSourceHandler`. `PARSER_TORCH_THREADS` accepts 1–4 (default 1), passes through the restricted Python subprocess environment and calls `torch.set_num_threads` during converter creation. Higher thread counts are opt-in and should be measured under the intended load. PPTX keeps the prior one-conversion path. PDF physical page numbers and blank pages remain intact; incomplete/rebased/partial-success results are failures. Limits remain 2,000 pages, per-page text cap, and 8 MiB combined output.

Offline synthetic text measurements with Docling 2.126.0 and OCR disabled separated converter creation (44–50s), PDF pipeline warmup (~40s; an explicit initialization took 39.5s), and steady conversion (15–20s/page). Two Torch threads reduced one measured page from 20.3s to 15.9s (~21%); this is not a throughput guarantee. Old separate processes for 1-page + 5-page ranges totaled 346.8s (114.6 + 232.2), versus 268.0s with A2 reuse. Each avoided process saved about 80–90s. A 70-page extrapolation suggests ~29% reduction, **not a measured full-document result and not the ≥50% target**. Ten-page ranges risk exhausting 240s even on synthetic text, especially when first-range warmup was included. Five-page ranges give 48s/page budget and exclude warmup; real slide/OCR performance still needs separate acceptance.

Cache identities include both physical range endpoints. Changing segment length does not reuse incompatible old ranges (identical ranges may still be reused). The existing 0094 constraint `page_end - page_start < 100` permits the new five-page default and the full 1–100 setting. No cache migration is needed.

PDF text uses **`ConversionResult.pages[].assembled` before cross-page merging**, not `document.texts[].orig[charspan]`. Docling 2.126.0's reading-order merge removes a trailing hard/soft hyphen but keeps offsets calculated before removal (`inter-` / `national` is a concrete failing case); the merged document alone cannot recover the two page strings. The CLI retains `ConversionResult`, and the extractor runs only Docling's rule-based reading-order/serialization stage independently on each retained page (no extra layout/OCR inference). Tables, captions, page furniture and formula `orig` when formula text is empty remain page-local. Missing, duplicate, foreign-page or incomplete assemblies fail explicitly, never masquerade as blank success or duplicate full-document text on each page. PPTX's SimplePipeline still uses its page-local document without requiring PDF assemblies; document-only multi-page text/table provenance is rejected rather than guessed. This preserves physical provenance, not a guarantee of recognition or formula accuracy.

`opening_pdf_parse_segments` persists ready/failed segments keyed by source/version/parser profile/physical range. The profile is a pinned implementation version plus OCR mode (no hash or private path); bump it when model/extraction semantics change. Successful segments are immutable within that key, are reused across a **new manually admitted retry job**, and are not replaced by late failures. Failed/missing segments alone execute again. The run continues past independent failed segments to retain subsequent successes, then fails without publishing a partial source. Only a fully successful result calls the existing `replaceChunks` path (including knowledge/index behavior). Source deletion cascades cache data. Excluded sources cannot be read/reparsed via cache. Existing `outcome_unknown` admission/reconciliation is unchanged; cached data is not permission to replay unknown paid jobs.

The physical-page extraction profile is now **`docling-2.126.0/pdf-segments-v2/<OCR mode>`**. It deliberately does not reuse v1's potentially mis-sliced ready segments. Version-0 uploads are legitimate: `beginUpload → completeWithParseJob` retains `source.version = 0`; both cache read/save and the database constraint accept nonnegative versions. Do not increment source versions to bypass a cache check. The regression starts from this real service/repository path, stubs only object storage, and then reads/saves/reuses the cache at version 0.

Each cache read/write checks owner, workspace, job kind/source, source version, execution token/running state, privacy epoch and exclusion. Writes reuse `lockOpeningJobExecution` **inside** the transaction, in the existing workspace → job → source lock order. DB cancellation and cache/chunk publication therefore serialize: cancellation that commits first prevents even a failed-segment record; a publication that got the lock first committed before cancellation, not after it. A serial 1-second execution check aborts the running subprocess promptly; polling alone is not the write fence. POSIX children run in an owned process group and use SIGKILL for the whole group (Windows uses `taskkill /T /F`); promises settle only after `close`, then unique per-attempt temporary directories are removed. Old/new attempts cannot unlink each other's input.

### Migration and rollback

Apply additive **0094_opening_parser_health_segments.sql** after the separately owned 0093, then **0095_opening_pdf_segment_zero_version.sql** before running the corrected parser workers. Keep the already-applied 0094 file and checksum unchanged: 0095 replaces only its source-version check (`>= 1` → `>= 0`) and retains all rows. No backfill, source/chunk rewrite or automatic reparse. New parser workers require the segment repository binding; omitted binding on a claimed PDF job fails closed rather than silently running without recovery. Web may deploy before the DDL and will show OCR unknown.

Rollback order: stop/drain **new parser/all workers first** (do not run old/new parser consumers together); cancel undesired queued/running parse jobs via the existing API, and reconcile any `outcome_unknown` separately. Retire health observations on a clean shutdown, or let their 10-minute leases expire after a crash. Roll back application code only after all new child processes are gone. **Keep 0094 tables, both 0094/0095 migration records, the nonnegative version constraint and successful cached pages**; pre-segment code ignores the additive DDL and normal source deletion still cascades. Do not restore the `>= 1` check or roll parser workers back to the known-broken v1 cache/extraction path. Do not delete version-0 sources/cache/chunks, reset jobs to queued or drop shared job-kind checks as part of rollback. Removing these tables requires a separate audited archival/deletion migration after no consumer uses them; no destructive down migration is supplied.

### Shared-file integration (main-thread owner)

`packages/database/src/index.ts` must export these two new modules (this slice does not edit the shared barrel):

```ts
export * from "./repositories/opening-parser-health";
export * from "./repositories/opening-pdf-segments";
```

In `apps/worker/src/index.ts`, import `randomUUID`, `createOpeningParserHealthRepository`, `createOpeningPdfSegmentsRepository`. Allocate one worker ID per process, create SQL lazily before role preparation without opening a connection yet, and call:

```ts
const workerId = randomUUID();
const sql = createSqlClient(env.databaseUrl);
const parserHealth = createOpeningParserHealthRepository(sql);
// On startup failure, close sql and rethrow; do not retire the failed diagnostic.
const prepared = await prepareWorkerRole(env.workerRole, undefined, {
  record: report => parserHealth.record(workerId, report),
});
const { parserRunner: runner, queueKinds, refreshParserHealth } = prepared;
// Existing createParseSourceHandler call:
const parse = runner ? createParseSourceHandler({ sources, chunks, storage, runner,
  tempDir: env.parserTempDir, segments: createOpeningPdfSegmentsRepository(sql) }) : parserDisabled;
```

Remove the later duplicate `const sql`. Add a `createSerialTask(refreshParserHealth, reportError)` only when non-null, register it in existing `tasks`, schedule `.run()` every 300,000 ms in existing `timers`. During clean shutdown: clear timers → drain tasks/workers → `parserHealth.retire(workerId)` → `sql.end`. Keep startup failures outside consumer creation and close the lazily created SQL client on startup error. No new orchestration framework is needed. `prepareWorkerRole` returns `parserOcrHealth` and `refreshParserHealth`; the latter remeasures and persists, and `learning` returns null.

### Focused verification

Cheap stdlib-only behavior tests (fake engines, no installed models) and a Node 24+ small actual-code/process smoke:

```sh
PYTHONPATH=services/parser python3 -m unittest discover -s services/parser/tests -p test_segments_health_unit.py -v
bash scripts/run-heavy.sh node services/parser/tests/worker-segments-smoke.mjs
```

After shared exports/dependencies are available, serialize these with the existing heavy lock (do not overlap builds/typechecks):

```sh
bash scripts/run-heavy.sh npx vitest run --project unit --maxWorkers 1 --no-file-parallelism apps/worker/src/parsers/pdf-segments.test.ts apps/worker/src/parsers/ocr-health.test.ts apps/worker/src/parsers/docling-process.test.ts apps/worker/src/parsers/docling-cancel.test.ts apps/worker/src/jobs/parse-source.test.ts apps/worker/src/runtime/worker-role.test.ts apps/web/src/app/api/opening/ai-readiness/route.test.ts apps/web/src/features/opening/assistant/ai-readiness-model.test.ts
bash scripts/run-heavy.sh npx vitest run --project integration --maxWorkers 1 --no-file-parallelism tests/integration/opening-parser-health-segments.repository.test.ts
# separately, in the prepared Python 3.13 environment:
bash scripts/run-heavy.sh "$PARSER_PYTHON" -m pytest services/parser/tests -q
```

Pinned Docling API regression **without any converter/model inference** (real `ConversionResult`, `Page`, `ReadingOrderModel` hard/soft-hyphen merges and table/formula serialization):

```sh
PYTHONPATH=services/parser bash scripts/run-heavy.sh "$PARSER_PYTHON" -m unittest discover -s services/parser/tests -p test_physical_pages_docling.py -v
```

Keep this distinct from `test_segments_health_unit.py` (stdlib-only boundary doubles) and the real PDF/PPTX conversion suite (requires prepared local models). A passing fake-assembly test does not establish compatibility with the installed Docling classes or actual PDF conversion.

SQL tests require the existing isolated `OPENING_TEST_DB=1` / guarded test DB setup, never production. The concurrency case requires independent PostgreSQL connections (single-backend emulators do not establish that race). Unit tests do not establish real Docling model inference, CPU latency or OCR accuracy. Browser validation remains with the user: authenticated `/api/opening/ai-readiness` should agree with the Worker report despite absent/different Web OCR env; text tutoring must remain usable for all four OCR statuses and unknown.
The lock has platform markers, including upstream Linux CUDA dependencies; this is not a custom CPU-only distribution. Windows checks and a Linux workflow definition do not prove a Linux run passed. The repository's actual GitHub `quality` job is the Linux acceptance evidence.
