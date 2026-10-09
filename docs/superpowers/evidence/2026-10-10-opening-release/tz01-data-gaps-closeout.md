# TZ01 — Data remaining gaps closeout

**Date:** 2026-10-10 ~01:10 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release`  
**Role:** AIstudy Data (main)  
**Sources:** `15-research-hardening.md` §TZ01; accept Known gaps; steering (do not fight AI budgeted-call)  
**Prior:** domain helper Accepted (`tz01-day-boundary-accept.md`); AI budget consume (`tz01-ai-budget-local-day.md`, tip `b2a2004`)  
**Verdict for Integrator:** Data slice ready for Accept review — **do not** mark verified; **left uncommitted**

## Per Known gap

| # | Gap | Result | Notes |
|---|---|---|---|
| 1 | Budget / DL7 SQL → `resolveLocalDayBounds` | **DONE (AI-owned)** | Skipped Data rewrite. AI landed `resolveBudgetLocalDay` + opening-budget half-open `[dayStart,nextDayStart)` + `planning_settings.timeZone`. Evidence `tz01-ai-budget-local-day.md`. No Data fork. |
| 2 | Reminder worker / API workspace IANA TZ | **DONE (Data)** | Enqueue stamps `payload.timeZone` from planning settings; worker prefers payload → `resolveTimeZone(job)` → legacy `timeZone()` → `DEFAULT_WORKSPACE_TIME_ZONE`. |
| 3 | Callers pass `localDate`+`timeZone` | **DONE (pre-existing + confirmed)** | All production `planDay` sites use `buildServerPlanDayOptions` (localDate+timeZone). `endOfLocalDayIso` now via shared bounds. Bare UTC fallback remains only when both omitted (documented). |
| 4 | Property/nature tests | **PARTIAL (Data)** | Light overnight + US DST spring/fall + adjacent-day exclusivity + `resolveWorkspaceTimeZone`. **Not** a full research matrix (overlapping free capacity not claimed). |

## Files (this Data slice, uncommitted)

**Modify**

- `apps/worker/src/jobs/remind.ts` — payload.timeZone; `resolveTimeZone` dep; shared default
- `apps/worker/src/jobs/remind.test.ts` — payload vs resolveTimeZone priority
- `apps/worker/src/index.ts` — wire `resolveTimeZone` from planning settings
- `packages/database/src/repositories/opening-reminders.ts` — stamp planning TZ at enqueue
- `packages/database/src/repositories/opening-reminders.test.ts` — mock planning_settings
- `packages/domain/src/opening/extract-study-actions.ts` — `endOfLocalDayIso` → `resolveLocalDayBounds`

**Already in tip `b2a2004` (shared FS / AI commit included Data helpers)**

- `packages/domain/src/opening/local-day-bounds.ts` — `DEFAULT_WORKSPACE_TIME_ZONE`, `resolveWorkspaceTimeZone`
- `packages/domain/src/opening/local-day-bounds.test.ts` — nature tests
- `packages/domain/src/index.ts` — exports

**Not touched**

- `packages/database/.../opening-budget.ts` / `packages/ai` budget path (AI)
- Q03; hermes/services redeploy; commit/push; tasks.json verified

## Tests (actual)

```text
npx vitest run \
  packages/domain/src/opening/local-day-bounds.test.ts \
  packages/domain/src/opening/extract-study-actions.test.ts \
  packages/domain/src/opening/day-planner.test.ts \
  apps/worker/src/jobs/remind.test.ts \
  apps/web/src/features/opening/planning/plan-service.test.ts \
  packages/database/src/repositories/opening-reminders.test.ts
# → Test Files  6 passed (6)
# → Tests  95 passed (95)

npx tsc -p packages/domain --noEmit   # exit 0
npx tsc -p packages/database --noEmit # exit 0
npx tsc -p apps/worker --noEmit       # exit 0
```

## Still open (honest)

1. Full nature matrix (overlapping free blocks / seasonal timetable expand / overnight free capacity) — not claimed complete.
2. Older remind jobs without `payload.timeZone` rely on live `resolveTimeZone` — intentional back-compat.
3. TZ01 remains **active** until Integrator Accept; do not verify from this note.
4. AI budget slice Accept is separate (`tz01-ai-budget-local-day-accept.md`).

## 中文交接（Integrator Accept）

- **缺口1（预算本地日）**：AI 已用 `resolveBudgetLocalDay` 接好账本/就绪半开区间，Data **未再改** opening-budget。
- **缺口2（提醒时区）**：入队写入 `planning_settings.timeZone`；worker 静默时段统一同一 IANA。
- **缺口3（planDay 调用方）**：服务端三条路径已传 `localDate`+`timeZone`；`endOfLocalDayIso` 改为共用日界。
- **缺口4**：仅加轻量 overnight/DST/邻日边界测试，**不宣称**完整性质矩阵。
- **未提交、未标 verified、未动 Q03、未重部署 hermes**。请 Integrator 审 Diff + 上表测试后决定是否 Accept / 是否入账 evidence。
