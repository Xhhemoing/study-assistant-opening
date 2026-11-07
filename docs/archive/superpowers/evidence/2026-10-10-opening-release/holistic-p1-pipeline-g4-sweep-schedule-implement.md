# Holistic upload/materials P1 — Pipeline G4 sweep schedule implement

**Date:** 2026-10-10 ~23:45 CST (Asia/Shanghai)  
**Branch tip at start:** `feat/opening-release` @ `3af5c01`  
**Owner:** Pipeline (this wave)  
**Status:** implemented locally — **no commit / push / stash / reset**

Companion: Data G4 implement `holistic-upload-p1-g4-data-implement.md` (Integrator ACCEPT). Data shipped `sweepExpiredPendingUploads` / `sweepExpiredPendingUploadsAll`; this wave schedules the **All** entry in the AIstudy worker.

---

## What changed

### Scheduled TTL sweep (must)

- New `apps/worker/src/jobs/sweep-pending-uploads.ts`:
  - `createSweepPendingUploadsJob({ sweepAll })` — pure-ish deps injection.
  - Calls injected `sweepAll` once per run; returns `{ swept, count }`.
  - `PENDING_UPLOAD_SWEEP_INTERVAL_MS = 60_000` (1 minute).
  - **No notify delivery** — returned `{ id, workspaceId }[]` is the optional notify hook for a later wave.
- Unit tests: mock `sweepAll` called once; options forwarded; interval constant asserted.
- `apps/worker/src/index.ts` `main()`:
  - Imports `sweepExpiredPendingUploadsAll` from `@aistudy/database` (already re-exported via `export * from "./repositories/opening-sources"` — no index change needed in database).
  - After sql/`sources` exist, wires `setInterval` at **60_000 ms** calling the job.
  - Guards with `stopping` like BullMQ workers; `void … .catch(() => {})` so sweep failure cannot crash the worker.
  - `clearInterval(sweepTick)` in `shutdown` alongside the 1s dispatch tick.
- **No new BullMQ queue** — matches existing dispatch `setInterval` style (simpler than cron/repeatable for this GC).

### Interval choice

| Timer | Interval | Role |
|---|---|---|
| Dispatch tick (existing) | 1_000 ms | `dispatchPending` / `dispatchTutorTurns` |
| Pending-upload TTL sweep (new) | **60_000 ms** | `sweepExpiredPendingUploadsAll` |

1 minute is fine: upload lease is 15m (`PENDING_UPLOAD_TTL_FALLBACK_MS` / staging lease); a 1m sweep keeps orphans from lingering much past expiry without hammering SQL.

---

## Files touched (this Pipeline wave)

| Path | Change |
|---|---|
| `apps/worker/src/jobs/sweep-pending-uploads.ts` | new job module |
| `apps/worker/src/jobs/sweep-pending-uploads.test.ts` | new unit tests |
| `apps/worker/src/index.ts` | import + interval + shutdown clear |
| `docs/.../holistic-p1-pipeline-g4-sweep-schedule-implement.md` | this evidence |

**Not modified:** `packages/database/src/repositories/opening-sources.ts` (Data G4 SQL/repo logic untouched — import/call only).  
**Not touched:** `docs/.../rp5-gha-91b1c73-typecheck-fail.md`.

---

## Non-goals (this wave)

- **No notify channel** (Slack / email / in-app) — skip delivery; only hang the scheduled sweep. Returned swept list remains the hook.
- **No Data SQL / repo logic change** — only call `sweepExpiredPendingUploadsAll`.
- No BullMQ repeatable/cron queue.
- No commit / push / stash / reset.

---

## Tests

Command:

```bash
npx vitest run --project unit apps/worker/src/jobs/sweep-pending-uploads.test.ts
```

Result: **Test Files 1 passed; Tests 3 passed** (vitest 4.1.10).

---

## Accept focus for Integrator

1. Worker has a **separate** slower interval (60s) calling Data’s `sweepExpiredPendingUploadsAll` via the new job module.
2. Shutdown clears the sweep timer; errors are swallowed so the worker does not crash.
3. Job unit tests pass with mock `sweepAll`.
4. Data G4 SQL/repo file not edited by Pipeline; no notify invent; no commit.
