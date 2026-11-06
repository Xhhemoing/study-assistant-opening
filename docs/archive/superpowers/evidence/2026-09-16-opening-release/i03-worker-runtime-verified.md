# I03 outbox dispatch + BullMQ runtime verified — 2026-09-16

Repo: `E:/Project/study-assistant-opening`; branch `feat/opening-release`. LOCAL-ONLY.
Implemented by `xhh/gpt-5.6-luna-fast` worker run `mu54vjl7-111122ac`, gap-fix pass by run `mu55xjfe-949855df`; final full-suite run and smoke-restoration by lead.

## Delivered

- `apps/worker/src/runtime/queue.ts`: BullMQ queue factory + `jobQueueId(workspaceId, jobId)` — deterministic, dash-safe, no colons; per-kind queues from one shared connection factory.
- `apps/worker/src/runtime/dispatch.ts`: `dispatchPending(deps)` — outbox poll with row locking via `repository.dispatchPending(callback, limit)`; unknown kind fails explicitly; bounded attempts (2) + exponential backoff; parallel double-dispatch proven to enqueue once.
- `apps/worker/src/runtime/run-job.ts`: `canClaimJob` truth table; `runJob` — DB CAS claim, parse-kind source privacy-epoch validation BEFORE handler execution (mismatch → failed, handler never invoked), definitive-vs-unknown outcome classification by provider ERROR CODE (OpeningProviderError.code ∈ {PROVIDER_TIMEOUT, PROVIDER_NETWORK} → outcome_unknown, mirroring budgeted-call), result written once transactionally.
- `packages/database/src/repositories/opening-jobs.ts`: `claim` CAS — `queued` always claimable, `running` only past a 5-minute stale threshold (updated_at = heartbeat; crashed workers' jobs are taken over without double-running live ones), `finish` guarded on `state='running'`, `sourcePrivacyEpoch(sourceId, workspaceId)`, outbox dispatch marking pending→published/failed.
- `apps/worker/src/runtime/handlers.ts`: finite kind→handler map; unknown kind throws. `apps/worker/src/index.ts`: per-kind Workers (concurrency 2), 1s dispatch tick, graceful shutdown (stop claims, close workers/queues/redis, unfinished jobs stay).

## Lead corrections to worker output (evidence chain)

1. `isUnknownOutcome` sniffed error.message — replaced with error-code check against `OpeningProviderError.code`, matching the T01 budgeted-call discipline; plain `Error("PROVIDER_NETWORK")` no longer maps to outcome_unknown.
2. Plan-required source privacyEpoch guard was missing — added `sourcePrivacyEpoch` + parse-kind pre-execution check (fail-closed).
3. `claim` re-claimed ANY running job (double-execution window) — narrowed to stale-threshold takeover (heartbeat semantics documented in code).
4. Worker rewrote existing `processSmokeJob` (platform "AIstudy"→"aistudy", dropped schema validation), breaking the pre-existing smoke unit tests — restored the original schema-validated contract (full-suite run caught it; scoped runs had missed it).

## Gates (exact output)

```text
$ node node_modules/vitest/vitest.mjs run --project unit
Test Files 140 passed (140)   Tests 673 passed (673)
$ OPENING_TEST_DB=1 OPENING_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/aistudy_opening_test \
  node node_modules/vitest/vitest.mjs run --project integration \
    tests/integration/opening-worker.test.ts tests/integration/opening-foundation.test.ts \
    tests/integration/opening-budget.test.ts tests/integration/opening-sources-storage.test.ts
Test Files  4 passed (4)   Tests  24 passed (24)
$ npm run typecheck -w @aistudy/worker && npm run typecheck -w @aistudy/database && npx tsc -p apps/web/tsconfig.json --noEmit → clean
$ npx eslint apps/worker/src packages/database/src/repositories/opening-jobs.ts tests/integration/opening-worker.test.ts → clean
```

Integration evidence (real Redis 8.10.1 @6379 + portable PG 17.5 @5433): parallel double-dispatch returns [1,0] with one published outbox row and one Redis job under the deterministic ID; runJob claims/completes once, redelivery skips, cancelled never reappears; failed vs outcome_unknown states distinct; stale running (10 min) takeover succeeds while fresh running is protected; an independent second stack (new IORedis + new Queue + new repository) sees the same queue IDs and completes without duplicate business results; privacy-epoch mismatch fails the parse job without invoking the handler.

## Deferred (recorded, non-blocking)

- Killing the shared local Redis mid-test was NOT observed (cannot safely terminate the only local Redis from a test); Redis-loss behavior is covered by design (outbox rows stay pending → re-dispatched; deterministic IDs dedupe) but remains a Q03 full-gate item with an isolated Redis.
- Long-handler heartbeat touching `updated_at` is only needed once I02 parses exceed 5 minutes; stale threshold is the placeholder.
- Handlers are explicit stubs until I02 (parse) / T02 (tutor) land.
