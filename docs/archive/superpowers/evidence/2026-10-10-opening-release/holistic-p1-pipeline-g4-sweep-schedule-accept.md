# ACCEPT：upload/materials P1 G4 — Pipeline sweep schedule only

**Date:** 2026-10-10 ~23:46 CST (Asia/Shanghai)  
**Reviewer:** Integrator (Grok Bot executor)  
**Branch:** `feat/opening-release`  
**Tip baseline:** `3af5c01` (working tree dirty for G4 Pipeline schedule + Data G4 + unrelated P1 WIP)  
**Verdict:** **ACCEPT**  
**Claim:** `holistic-p1-pipeline-g4-sweep-schedule-implement.md`  
**Plan:** `holistic-upload-materials-audit-p0-plan.md` § P1 backlog G4; gap inventory `holistic-upload-materials-audit-understand.md` § G4; Data half already ACCEPTED in `holistic-upload-p1-g4-data-accept.md`

---

## Verdict

**ACCEPT** Pipeline half of upload/materials P1 **G4 schedule only**: worker `setInterval` every **60_000 ms** invokes Data’s `sweepExpiredPendingUploadsAll` via `createSweepPendingUploadsJob`, with shutdown `clearInterval` and swallowed sweep errors.

No product edits by this Accept turn, no commit/push. **Notify delivery not done** (honest — returned swept list is the hook only). **Pipeline G12/G19/G8/G9 package is out of slice** (separate PM-ordered Accept); dirty-tree files for that pack were not reviewed as part of this verdict.

---

## Gates (re-run 2026-10-10 ~23:46 CST)

```bash
cd /workspace/study-assistant-opening
npx vitest run --project unit apps/worker/src/jobs/sweep-pending-uploads.test.ts
# → Test Files  1 passed (1)
# → Tests       3 passed (3)

npx tsc -p apps/worker/tsconfig.json --noEmit
# → exit 0
```

| Gate | Result |
|---|---|
| Vitest `sweep-pending-uploads.test.ts` (**3**) | **Pass** |
| `apps/worker` tsc -p tsconfig.json --noEmit | **Pass** (exit 0) |

---

## Spot-checks (claim / plan acceptance hooks)

| Hook | Result |
|---|---|
| Separate slower interval (60s) vs dispatch 1s tick | **Pass** — `PENDING_UPLOAD_SWEEP_INTERVAL_MS = 60_000`; `setInterval(..., PENDING_UPLOAD_SWEEP_INTERVAL_MS)` |
| Interval actually calls Data `sweepExpiredPendingUploadsAll` | **Pass** — `createSweepPendingUploadsJob({ sweepAll: (options) => sweepExpiredPendingUploadsAll(sql, options) })` then `void sweepPendingUploads()` |
| Import from `@aistudy/database` (re-export via `export * from "./repositories/opening-sources"`) | **Pass** — `packages/database/src/index.ts` line 30; `sweepExpiredPendingUploadsAll` at opening-sources.ts:192 |
| Shutdown clears sweep timer | **Pass** — `clearInterval(sweepTick)` beside dispatch tick |
| Errors swallowed (`stopping` guard + `.catch`) | **Pass** — no crash path from sweep failure |
| No notify delivery (Slack / email / in-app) | **Pass** — job returns `{ swept, count }` only; index comments “delivery skipped this wave”; no send on swept ids |
| No new BullMQ queue / cron | **Pass** — `setInterval` style matching dispatch tick |
| Data SQL/repo not edited by this Pipeline schedule wave | **Pass** — schedule files only call All; Data G4 already accepted separately (dirty `opening-sources.ts` is Data half, not re-accepted here) |
| Job unit tests: mock `sweepAll` once + options forward + interval constant | **Pass** (3/3) |

### Stronger review (tests must not pass while missing G4 schedule behavior)

| Risk | Assessment |
|---|---|
| Job tests green while `index.ts` interval wiring removed | **Residual** — no `main()` harness; unit suite covers job module + constant only. Mitigated by code review of the exact `setInterval` → `sweepExpiredPendingUploadsAll(sql, …)` path and tsc confirming the import resolves. |
| Constant-only third test | Acceptable: `PENDING_UPLOAD_SWEEP_INTERVAL_MS === 60_000` fails if interval constant drifts; first two tests fail if `sweepAll` not invoked / options dropped. |
| Wrong Data entry (scoped vs All) | Code uses **All** as claimed; injects `sql` at wire site. |
| Notify invent sneak-in | None in job module or sweep tick path. |
| Folding G12/G19/G8/G9 into this Accept | **Refused** — see out-of-slice list below. |

**Blockers:** none for Pipeline G4 schedule slice.

---

## Files in scope (Pipeline G4 schedule only)

| Path | Role |
|---|---|
| `apps/worker/src/jobs/sweep-pending-uploads.ts` | new job + `PENDING_UPLOAD_SWEEP_INTERVAL_MS` |
| `apps/worker/src/jobs/sweep-pending-uploads.test.ts` | 3 unit tests |
| `apps/worker/src/index.ts` | import + 60s `setInterval` + shutdown `clearInterval` (**G4 hunk only**) |
| `docs/.../holistic-p1-pipeline-g4-sweep-schedule-implement.md` | implement claim (read-only for Accept) |

## Explicitly not accepted here (out of slice)

### Pipeline G12 / G19 / G8 / G9 package (PM: separate Accept)

Dirty / untracked alongside this wave; **not** part of this verdict:

| Path | Gap (per `holistic-p1-pipeline-g12-g19-g8-g9-implement.md`) |
|---|---|
| `apps/worker/src/runtime/queue.ts` | G12 |
| `apps/worker/src/runtime/queue.test.ts` | G12 |
| `apps/worker/src/jobs/parse-source.ts` | G8 |
| `apps/worker/src/jobs/parse-source.test.ts` | G8 |
| `apps/web/.../sources/source-service.ts` (+ test) | G19 |
| AI readiness / OCR checklist files | G9 |

### Other

- Data G4 SQL/repo (already ACCEPTED: `holistic-upload-p1-g4-data-accept.md`)
- Notify delivery channel
- Experience G5 / other P1 dirty tree
- commit / push / stash / reset

---

## Notes

- Plan P1 backlog lists G4 as one-line sketch (“Pending TTL sweeper → rejected + optional notify”); Data half closed SQL/`rejected`; this Accept closes **Pipeline schedule** only. Optional notify remains deferred.
- Tip remains `3af5c01`; G4 Pipeline schedule is uncommitted (as claim stated). Integrator did not commit or push.
