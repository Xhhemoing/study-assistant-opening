# T02 / T03 tutor path verified — 2026-09-18

Repo: `E:/Project/study-assistant-opening`; branch `feat/opening-release`. LOCAL-ONLY.
T02 unit/integration slice landed in `7ad048b`; T03 slice in `7f98283`; Windows encoding fix in `fa4d023`.
Executed across lead session + parallel subagent runs (no active runs at acceptance time); test files were updated concurrently during the run — final state re-verified below.

## Delivered

- **T02** (`7ad048b`): `selectContext` (deterministic keyword ranking, preferred chunk/page, char budget, UNTRUSTED delimiters), `resolveCitations` (unknown ID → RangeError; program-checked labels with page/slide/timestamp), `opening_source_chunks.listForSources` (scope-checked multi-source fetch), integration `opening-retrieval.test.ts`.
- **T03** (`7f98283`): `tutor-turn` durable worker (CAS claim → authorized chunk fetch → T02 context → T01 budgeted call → one-shot persist of assistant turn + pending candidates with program-assigned provenance); `opening-tutor-jobs`/`opening-candidates` repositories; migration `0021_opening_assistant_candidates`; `candidates` + `jobs/[id]` API routes; worker runtime wiring (provider built only when `OPENING_MODEL_API_KEY` set, else explicit null → 503 semantics).
- **Encoding fix** (`fa4d023`): real math PDFs (Topic 3, 55 pages) crashed the CLI on Windows — redirected stdout defaults to GBK, `˙/∞/→` unencodable. CLI now self-reconfigures stdout to UTF-8; worker spawns python with `PYTHONIOENCODING=utf-8` (Node side decodes UTF-8). Regression tests: pytest subprocess driver (no env var, GBK pipe, stub convert) + worker env-contract test via node child.

## Gates (exact output)

```text
$ node node_modules/vitest/vitest.mjs run --project unit
Test Files 145 passed (145)   Tests 702 passed (702)
$ OPENING_TEST_DB=1 OPENING_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/aistudy_opening_test \
  node node_modules/vitest/vitest.mjs run --project integration \
    tests/integration/opening-{tutor-turn,retrieval,budget,worker,parse-job}.test.ts
Test Files  5 passed (5)   Tests 18 passed (18)
$ OPENING_TEST_DB=1 ... node node_modules/vitest/vitest.mjs run --project handler
Test Files 14 passed (14)   Tests 47 passed (47)
$ ./.local/docling-venv/Scripts/python.exe -m pytest services/parser/tests/test_conversion.py -v
6 passed, 1 xfailed in 51.28s
$ npx tsc -p {apps/worker,apps/web,packages/database,packages/ai}/tsconfig.json --noEmit → clean; eslint apps/worker/src packages/database/src → clean
```

Real math material probe (local CLI, not yet via upload path): Topic_3__Differential_Calculus_SLIDES.pdf → 171s, exit 0, 55 pages; inline math survives (`f ′ (x0) = 0`, `≤`, `j !`), **display formulas are dropped or flattened** (Taylor polynomial block missing on p34) — consistent with RU-03: keep original + explicit statement; do not claim full formula tutoring without multimodal path.

## Lead corrections (evidence chain)

1. Integration run first failed 5/5 with `invalid input syntax for type uuid` from a stale uncommitted test draft; the draft was replaced concurrently (constant chunkId → DB-generated id read back via SELECT). Re-run passed 4/5; remaining failure (`redelivery` count 2≠1) root-caused to `fixture.reset()` TRUNCATE missing `opening_conversations`/`opening_tutor_jobs`/`opening_assistant_candidates` — same-fixture workspace leaked rows across tests. Fixed in `7f98283` (fixture reset widened).
2. Worker entry had unused `createOpeningCandidateRepository` (candidates persist inside `tutorJobs.completeTurn`) — removed; lint clean.
3. `opening-sources.test.ts` unused import — removed.

## Recorded, unresolved

- One unreproduced integration failure (parse-job, 01:19 local) during concurrent test-file updates; both isolated and combined re-runs pass. If it recurs, capture full stack before touching anything.
- Non-ASCII PDF regression uses a stubbed converter (hand-building a CMap-bearing PDF was judged disproportionate); the real-convert path is covered end-to-end by the Topic 3 probe and the synthetic-fixture pipeline tests.
- Real-model answer quality, citations semantics sampling, cost — Q02, needs configured budget/key. Full legacy integration project still has the 7 pre-existing Phase-1 suite failures (recorded in I02 evidence, outside opening scope).
