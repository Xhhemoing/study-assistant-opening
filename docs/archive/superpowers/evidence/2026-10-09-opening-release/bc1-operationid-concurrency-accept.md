# BC1 remaining operationId/concurrency slice — Accept

Verifier: Grok Bot (executor). Workspace: `/workspace/study-assistant-opening`, branch `feat/opening-release`.
Date: 2026-10-10 ~00:13 CST (Asia/Shanghai).
Base tip: `b174394` (`fix(ai): tolerate malformed GLM answer JSON in parseOutput`).

## Accept vs claim

**ACCEPT: yes** for the remaining worker-side BC1 AC slice.

| # | Claim | Verdict |
|---|---|---|
| 1 | tutor-turn wires `operationId=tutor:${jobId}` (retry reuses reserve) | PASS — `tutorOperationId` passed as both `requestId` and `operationId`; unit locks same-job retry → one reservation |
| 2 | concurrency/cancel/late-result matrix | PASS — discovery: concurrent CAS reserve, cancel-before-send release, PROVIDER_ABORTED→markUnknown, late settle after release, settle-once, release-vs-settle race |
| 3 | settings↔ledger alignment tests | PASS — disabled cap ↔ `budget_disabled`; `PROVIDER_DISABLED` / `BUDGET_EXCEEDED` stay business codes; confirmed workspace cap source |
| 4 | ephemeral web operationId **deferred** | PASS (accepted deferral) — discovery locks double-reserve without `operationId` and reuse with shared `operationId`; no `apps/web` edits |
| 5 | 93 passed across 7 files | PASS — re-run on Accept: **93 passed / 7 files** |

## Diff scope (committed this Accept)

- `apps/worker/src/jobs/tutor-turn.ts`
- `apps/worker/src/jobs/tutor-turn.test.ts`
- `apps/worker/src/runtime/budget-contract-discovery.test.ts`
- slice evidence: `bc1-operationid-concurrency-slice.md`
- this accept file
- `tasks.json` BC1: active → **verified** + evidence append

**Not touched:** `packages/ai/.../provider.ts`, `apps/web/**` ephemeral, Q03 packaging dirt, egg-info.

## Gates (re-run on Accept)

```text
node node_modules/vitest/vitest.mjs run --project unit \
  apps/worker/src/runtime/budget-contract-discovery.test.ts \
  apps/worker/src/runtime/budgeted-call.test.ts \
  apps/worker/src/jobs/tutor-turn.test.ts \
  packages/ai/src/opening/errors.test.ts \
  packages/ai/src/opening/usage.test.ts \
  packages/ai/src/opening/effective-cap.test.ts \
  packages/ai/src/opening/catalog-merge.test.ts
→ Test Files  7 passed (7)
→ Tests       93 passed (93)
→ Duration    ~4.23s
```

## Ledger

BC1 status: **verified** (was active). Ephemeral web `operationId` deferral accepted per Integrator.
Evidence appended:
- `../../evidence/2026-10-09-opening-release/bc1-operationid-concurrency-slice.md`
- `../../evidence/2026-10-09-opening-release/bc1-operationid-concurrency-accept.md`
