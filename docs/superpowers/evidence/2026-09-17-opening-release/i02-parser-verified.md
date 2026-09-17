# I02 structured conversion verified — 2026-09-17

Repo: `E:/Project/study-assistant-opening`; branch `feat/opening-release`. LOCAL-ONLY.
Part A implemented by `xhh/gpt-5.6-luna-fast` run `mu5953xm-0d2c8b3a` (request timed out after files landed; lead verified + committed); part B core by `mu5d560p-947d9f6a`, tests by `mu5g9w0d-f8a9c209` + one lead assertion fix (fixture-content strings). Infrastructure by lead: Docling 2.126.0 venv.

## Delivered

- **Environment (INTEGRATOR, gitignored `.local/`):** venv `docling-venv` (Python 3.13.14 + docling 2.126.0 + torch 2.14.0 CPU + pytest 9.1.1); HF model cache seeded once by a real conversion (docling-layout-heron snapshot `8f39ad3c…`, docling-models v2.3.0 snapshot `fc0f2d45…`). Offline conversion verified: `HF_HUB_OFFLINE=1` + repo-local `HF_HOME` → 13.8s 2-page PDF, no network. Recorded skew: plan said Python 3.12; verified working 3.13 (manifest notes it).
- **Part A — `services/parser`** (commit `87b4ea6`): `python -m opening_parser` CLI — argv only, `HF_HUB_OFFLINE=1` set inside the module before docling import (runtime downloads impossible), `do_ocr=False`, page texts derived from conversion provenance (never invented/renumbered), bounds are rejections not silent truncation (max-pages → exit 5, >8MiB output → exit 5, per-page 200k-char cap with explicit marker), wall-clock thread timeout → exit 4, unsupported mime → 3, usage → 2. Model manifest records only actually-downloaded revisions. Synthetic 2-page fixture committed with generation + sha256 `d8e4184c…`. Hand-built PPTX conversion honestly `xfail` (flaky, recorded).
- **Part B — Node bridge + persistence** (commit `95593c2`): `parsers/types.ts` (ParserInput/ParsedPage/ParserRunner per interfaces), `docling-process.ts` (strict decode — page 0/renumbering/duplicates rejected; exit-code→typed-error mapping; argv-only node runner with stdout caps; abort propagates), migration `0020_opening_source_chunks.sql` (UNIQUE (source_id, source_version, page)), `opening-source-chunks.ts` repository — `replaceChunks` transaction re-checks source version `FOR UPDATE` and flips `parse_state='ready'` atomically, `parse-source.ts` job handler (unsupported mimes → honest `parse_state='unsupported'` with job success; conversion failure keeps job/source distinction; temp download bounded by declared bytes, cleaned in `finally`), real parse handler wired into the finite handlers map (tutor/retest/remind stay stubs).

## Gates (exact output)

```text
$ ./.local/docling-venv/Scripts/python.exe -m pytest services/parser/tests/test_conversion.py -v
5 passed, 1 xfailed in 74.92s   (real docling conversion in tests)
$ node node_modules/vitest/vitest.mjs run --project unit
Test Files 142 passed (142)   Tests 684 passed (684)
$ OPENING_TEST_DB=1 OPENING_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/aistudy_opening_test \
  node node_modules/vitest/vitest.mjs run --project integration \
    tests/integration/opening-{foundation,budget,sources-storage,worker,parse-job}.test.ts
Test Files  5 passed (5)   Tests  26 passed (26)
$ npm run typecheck -w @aistudy/database -w @aistudy/worker ; npx tsc -p apps/worker/tsconfig.json --noEmit → clean
$ npx eslint apps/worker/src packages/database/src/repositories/opening-source-chunks.ts tests/integration/opening-parse-job.test.ts → clean
```

Real-stack plan gate OBSERVED: committed synthetic PDF → presigned upload → complete → parse job via real venv docling → `opening_source_chunks` rows for pages 1/2 with provenance texts → `parse_state='ready'`; audio upload lands `unsupported`; warm conversion ~15-40s.

## Lead corrections (evidence chain)

1. Part A worker request timed out after writing files — lead verified gates directly before committing (no blind re-dispatch).
2. Part B first test worker left parse-source unit tests + integration unwritten; second attempt failed with API 521; third completed them. Integration initially failed on assertion strings ("Alpha/Beta" from the lead's brief described the /tmp smoke PDF; the committed fixture contains "Opening parser page one/two") — lead fixed the test strings; root cause was brief error, not product code.
3. Worker 1 of part B punt-check: no implementation files staged until gates personally re-run.

## Pre-existing breakage discovered (NOT from this slice — recorded for follow-up)

Running the FULL integration project (`vitest run --project integration`, all 25 files) fails 19 tests across 7 Phase-1-era suites (exploration-repository, promotion-repository, revision-proposal-repository, identity-migration-compatibility, multi-goal-course, card-multi-goal-state, search). Root cause verified by direct execution: e.g. `exploration-repository.test.ts:29` inserts two workspaces with the SAME owner in one statement (`VALUES (workspaceA, ownerA), (workspaceB, ownerA)`), which necessarily violates `workspaces_owner_user_uidx` UNIQUE(owner_user_id) introduced by migration 0003/0004 identity repair. These suites predate the index and were never re-run: every evidence file on this branch runs integration with explicit opening file lists only. NOT a regression from I02 — the 5 opening integration suites pass individually and as a set. Follow-up required (Phase-1 maintenance, outside opening-release scope): fix or retire the 7 legacy suites, then re-enable full-project integration runs as a gate.
