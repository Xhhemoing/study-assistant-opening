# P04a UI half accept — Daily auto draft card on today view

**Date:** 2026-10-09 ~17:19 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release`  
**Workspace:** `/workspace/study-assistant-opening`  
**Scope:** Experience UI half only against `docs/superpowers/plans/opening-release/14-loop-closure.md` § P04a.  
**Verdict:** **ACCEPT** (UI half). Data half already **ACCEPT** in [`p04a-data-accept.md`](./p04a-data-accept.md).  
**Browser:** **not run** — do not claim browser pass.  
**tasks.json:** not edited in this UI-half file (ledger close is separate consolidated evidence).  
**Commit/push:** **not done**.

## Files reviewed (UI)

**New**
- `apps/web/src/features/opening/planning/daily-draft-card.tsx` (+ `daily-draft-card.test.ts`) — `DailyDraftCard`, `createDailyDraftControllers`, `reduceDailyDraftCard`, `dailyDraftSkippedCopy`

**Changed**
- `apps/web/src/features/opening/client/api.ts` — Today schema: `dailyDraft`, `dailyDraftSkippedReason` (`accepted`|`rejected`|`no_settings`), `unplannedPendingCount`
- `apps/web/src/features/opening/planning/today-view.tsx` — mounts `DailyDraftCard` when plan ready (passes today fields + CAS `acceptedVersion`)

**Note vs plan file list:** plan § P04a lists `today-dashboard.tsx`; live surface is `today-view.tsx` (same pattern as DL9 `SuggestPlanCard`). No restyle of Data-owned dashboard.

**Out of scope / Data half (cited, not re-owned here)**
- `daily-draft.ts`, `ensureDailyDraft` / `ensureAutoDraft`, advisory lock, handler `opening-daily-draft` — see [`p04a-data-accept.md`](./p04a-data-accept.md)
- Data core left untouched by this UI half

## Plan criteria checklist (UI-owned)

| # | Criterion | Result | Notes |
|---|---|---|---|
| 1 | Confirm → existing accept with version CAS | **PASS** | `createDailyDraftControllers.accept` → `acceptPlan({ draftId, expectedBaseVersion, clientKey })`; `canAcceptPlan` gates stale/pending |
| 2 | Reject → existing reject | **PASS** | `rejectPlan(draftId)` |
| 3 | Adjust → propose only; confirm is separate | **PASS** | `adjust` → `proposePlan` only; tests assert accept call count unchanged after adjust |
| 4 | Fail paths: no optimistic clear of draft | **PASS** | `reduceDailyDraftCard` `action_fail` keeps `state.draft`; copy keeps draft on reject/adjust fail |
| 5 | Accepted skip: 「有 N 项新任务未排入」 | **PASS** | `dailyDraftSkippedCopy("accepted", n)` + card render |
| 6 | Reject / no_settings Chinese tips | **PASS** | Rejected: 已拒绝 / 不再自动生成; no_settings: 学期设置 |
| 7 | Show 「顺延自昨天」 when present on blocks | **PASS** | Block reason + banner「含顺延自昨天的任务」; unit HTML assert |
| 8 | Never auto-accept (mount / adjust) | **PASS** | Mount static render: accept/propose/reject not called; adjust never calls accept |
| 9 | Interface unit: three actions + fail no optimistic | **PASS** | Controllers + reducer + card tests in `daily-draft-card.test.ts` |
| 10 | Did not own/restyle Data core | **PASS** | UI = card + client Today fields + today-view mount only |

## Tests re-run (actual counts)

```text
node node_modules/vitest/vitest.mjs run --project unit \
  apps/web/src/features/opening/planning/
→ Test Files  16 passed (16)
→ Tests       128 passed (128)
→ Duration    ~12.17s

node node_modules/typescript/bin/tsc -p apps/web/tsconfig.json --noEmit
→ exit 0
```

Matches Experience claim (16 files / 128; tsc web).

## Not run

- **Browser** (Paula) — not run; do not claim browser pass.
- Handler/integration for daily-draft — Data half already green in `p04a-data-accept.md` (re-check reserved for ledger close).

## Recommendation

**ACCEPT** UI half of P04a. Full ledger close may proceed when consolidating with data half accept; browser remains user-owned.
