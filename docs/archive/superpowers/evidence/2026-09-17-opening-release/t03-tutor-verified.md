# T03 durable tutor turn verified — 2026-09-18

Repo: `E:/Project/study-assistant-opening`; branch `feat/opening-release`. LOCAL-ONLY.
Implemented across `xhh/gpt-5.6-luna-fast` run `mu5r6fef-904eea1d` (mode policy + migration 0021 + candidates repository) and lead (handler core, dispatch bridge, wiring, routes, tests) after the worker punted on the core path.

## Delivered

- `apps/worker/src/jobs/tutor-turn.ts`: `makeTutorInstruction(mode)` pure mode policy (listen 不自动创建任务 / hint 下一步提示 / explain 完整答案 / think_together 共同思考); `createTutorTurnHandler` — CAS claim on opening_tutor_jobs (queued, or running stale >5 min), user-turn load, workspace-scoped chunk gather, T02 `selectContext` honoring currentPage/chunkId (RU-03) with whole-chunk budget packing, provider call through T01 `runBudgetedCall` (reserve before send, settle by token pricing, release on definitive, markUnknown on PROVIDER_TIMEOUT/PROVIDER_NETWORK), zod-validated ProviderOutput, `resolveCitations` program-check, then ONE transaction: assistant turn text+complete + pending candidates with PROGRAM-assigned sourceTurnId/sourceIds (model cannot choose) + job succeeded. Failure paths: all-sources-vanished → explicit failed; definitive provider error → failed + reservation released; timeout/network → job outcome_unknown + reservation retained (no blind recost). Provider-error classification is by error CODE, not message sniffing.
- `packages/database/src/repositories/opening-tutor-jobs.ts`: claim/get/listQueued/getUserTurn/completeTurn (single tx)/fail/markUnknown; migration `0021_opening_assistant_candidates.sql` + drizzle schema + `opening-candidates.ts` (saveCandidate/listPending/decide for M01/P02 consumption later).
- Dispatch bridge: `dispatchTutorTurns` enqueues queued tutor jobs onto the BullMQ tutor queue with deterministic dash-safe IDs (dedupe by ID; CAS claim guards execution); worker entry wires the tutor branch separately from generic runJob and ticks both dispatchers. Provider constructed from OPENING_MODEL_* env; disabled (no key) → honest PROVIDER_DISABLED failure.
- Routes: GET `/api/opening/candidates` (owner's pending only), GET `/api/opening/jobs/[id]` (actual status/error polling, no bodies/tokens).
- `tests/integration/opening-fixture.ts` reset extended: truncates opening_assistant_candidates/opening_tutor_jobs/opening_turns/opening_source_chunks (tables added after the fixture was written; without this, candidate rows leaked across tests).

## Lead corrections (evidence chain)

1. Worker delivered only the mode policy + candidates repo and punted the handler/dispatch/routes/tests — lead implemented the durable path directly.
2. Test-fixture UUID constants were malformed (invalid uuid input) → replaced with literal UUIDs.
3. Fake provider cited a hand-written chunk id, but `replaceChunks` lets the DB generate ids → integration failed with `unknown citation`; test now reads the actual chunk id from the DB.
4. `completeTurn` referenced a non-existent `opening_turns.updated_at` column → removed.
5. Parallel-session collision: commit `7f98283` was created by ANOTHER active session while this one worked (it folded in this session's staged T03 files plus its own: a drizzle `opening-conversations.ts` schema whose `citations` column does NOT exist in migration 0017 — latent inconsistency, nothing queries it yet, recorded for follow-up — and an `opening-sources.test.ts` import cleanup). Working tree also holds that session's staged/unstaged parser Windows-encoding fixes (PYTHONIOENCODING, stdout reconfigure), left untouched per ownership discipline.

## Gates (exact output, current tree)

```text
$ node node_modules/vitest/vitest.mjs run --project unit
Test Files 145 passed (145)   Tests 702 passed (702)   (6 consecutive full-suite green runs)
$ OPENING_TEST_DB=1 OPENING_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/aistudy_opening_test \
  node node_modules/vitest/vitest.mjs run --project integration \
    tests/integration/opening-{tutor-turn,worker,sources-storage,foundation,budget,parse-job,retrieval}.test.ts
Test Files  7 passed (7)   Tests  33 passed (33)
$ ... handler: tests/integration/handler/opening-tutor.test.ts → 1 file, 3 tests passed
$ scoped unit (jobs + ai/opening + repositories): 12 files / 49 tests passed
$ npm run typecheck -w @aistudy/database -w @aistudy/worker → clean; npx tsc -p apps/web/tsconfig.json --noEmit → clean
$ npx eslint apps/worker/src/jobs packages/database/src/repositories/{opening-tutor-jobs,opening-source-chunks}.ts apps/web/src/app/api/opening tests/integration/{opening-tutor-turn,handler/opening-tutor}.test.ts → clean
```

Real-DB coverage: appendSavedTurn → tutor job → handler → assistant turn complete + pending candidate with program-assigned provenance; redelivery skip (no second candidate); definitive failure → released reservation; timeout → outcome_unknown + retained reservation; ghost sources → explicit failed; owner-only candidates; 401/404 on routes.

## Anomaly + follow-ups (recorded, non-blocking)

- One unreproduced unit failure occurred during the first post-T03 full-suite run (identity lost to a summary-only grep); 6 subsequent full runs green. Watch for flake recurrence.
- Parallel session's drizzle `opening-conversations.ts` declares a `citations` column absent from 0017 — reconcile before any drizzle consumer lands.
- Parser Windows-encoding fixes in the working tree belong to the parallel session — not gate-verified here.
