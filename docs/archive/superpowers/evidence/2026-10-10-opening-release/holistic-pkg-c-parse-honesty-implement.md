# IMPLEMENT：Package C — Parse honesty + media failure projection (G6+G7)

**Date:** 2026-10-10 ~22:30 CST (Asia/Shanghai)  
**Owner:** Pipeline (Grok Bot executor)  
**Branch:** `feat/opening-release`  
**Status:** **READY_FOR_ACCEPT** (no commit / no push / `tasks.json` untouched)  
**Plan:** `docs/superpowers/plans/opening-release/holistic-upload-materials-audit-p0-plan.md` § Package C  
**Companion:** `holistic-upload-materials-audit-understand.md`; prior `parse-stuck-after-upload-understand.md`  
**Auth:** PM AGREE on Package C

---

## Scope respected

- **No** commit / push  
- **No** `tasks.json` verified flips  
- **No** Package A / B / D  
- **No** `infra/deploy/aistudy-worker.service` MemoryMax edit (ops already raising memory; note only below)  
- **No** source-row redesign / cancel-parse API / fake UI timeout → failed  
- Pipeline-only: fail projection, claim → running, honest copy

---

## Changes

| Path | Change |
|---|---|
| `packages/database/src/repositories/opening-job-failure.ts` | Project source `parse_state=failed` for `kind === "parse" \|\| kind === "parse-media"` (privacy + version fences unchanged) |
| `packages/database/src/repositories/opening-job-failure.test.ts` | `fakeSql` accepts `kind`; new case: parse-media → source failed + version fence |
| `packages/database/src/repositories/opening-jobs.ts` | `claim`: after job → `running`, if parse/parse-media + valid `sourceId`, set source `parse_state=running` (upload=uploaded, version fence, only from not_started/queued/running) |
| `packages/database/src/repositories/opening-jobs.test.ts` | claim → source running (parse + parse-media); race-loss claim skips source update |
| `apps/web/src/features/opening/inbox/upload-state.ts` | Honest labels: `running` →「正在解析」; `queued`/`not_started` →「解析排队中」; aged (≥3m via optional `createdAt`) →「解析排队中，可能较慢」. **No** timer that marks failed |
| `apps/web/src/features/opening/inbox/upload-state.test.ts` | running / fresh queued / aged queued assertions |

### Explicit non-changes

- `apps/worker/src/jobs/parse-media.ts` — untouched; `BLOCKED_NOT_CONFIGURED_ERROR.retryable: false` still covered by existing unit tests  
- `infra/deploy/aistudy-worker.service` — still ships `MemoryMax=1024M`; ops raising on hermes outside this PR  
- `source-row.tsx` / cancel API — not in this package’s Pipeline-minimal scope

---

## Ops note (evidence only)

Hermes live addendum already identified Docling + `MemoryMax=1G` pressure. Unit file not bumped here; coordinate with Data/ops for MemoryMax/MemoryHigh on the running host. Worker must stay active for claim→running to matter.

---

## Tests

```bash
npx vitest run --project unit \
  packages/database/src/repositories/opening-job-failure.test.ts \
  packages/database/src/repositories/opening-jobs.test.ts \
  apps/web/src/features/opening/inbox/upload-state.test.ts \
  apps/worker/src/jobs/parse-media.test.ts
# → 4 files, 24 tests passed

# typecheck
(cd packages/database && npx tsc -p tsconfig.json --noEmit)  # exit 0
(cd apps/web && npx tsc -p tsconfig.json --noEmit)            # exit 0
```

### Acceptance mapping

| Criterion | Result |
|---|---|
| Unit: `failOpeningJob` parse-media updates source like parse | Pass (new test) |
| Unit: claim → source running | Pass (parse + parse-media) |
| Whisper `blocked_not_configured` still `retryable: false` | Pass (parse-media.test.ts regression; file untouched) |
| No fake UI fail-on-timer | Pass (copy-only age branch) |
| web/database tsc | Pass |

---

## READY_FOR_ACCEPT

Integrator Accept handoff: Package C code + tests green; MemoryMax remains ops; no commit/push/tasks.json.
