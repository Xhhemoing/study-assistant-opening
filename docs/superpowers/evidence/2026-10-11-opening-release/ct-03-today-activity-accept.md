# CT-03 Today → teaching activity — ACCEPT

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Reviewer:** AIstudy Integrator Accepting Experience（executor subagent）  
**Baseline tip:** `86cdf88717677b25d06da24d1a620db7a2a15b06` (`feat/opening-release`, dirty uncommitted)  
**Implement evidence:** `docs/superpowers/evidence/2026-10-11-opening-release/ct-03-today-activity-implement.md`  
**Gates doc:** `docs/superpowers/plans/opening-release/review-test-gates.md`  
**Verdict:** **ACCEPT**

Implementer ≠ accepter. No commit / push / stash / reset / hermes.

## Stronger review（vs CT-03 / understand / PM #5）

| Checklist | Result | Notes |
|---|---|---|
| Today「继续学习 / 开始学习」→ teaching activity | **PASS** | `today-dashboard.tsx` loads `api.listTeachingActivities()`; primary CTA continues existing `active`/`paused` or `createTeachingActivity` via `buildStartLearningCreateInput` |
| Single primary CTA | **PASS** | One `data-today-primary-cta` button in header (`TodayLearningContext.primaryAction`); empty pane reuses same `runPrimaryCta` |
| Main pane = teaching-activity entry（not embedded AssistantView） | **PASS** | Tip had embedded `AssistantView`; working tree replaces with `TeachingActivityPanel` / `TeachingActivityEmpty`. Diff removes AssistantView import + main-pane embed |
| Free chat demoted to quiet secondary | **PASS** | Header `secondaryAction`「自由对话」; panel/empty/resume use `ui.quiet`「打开自由对话（次要）」; resume primary no longer `/opening/assistant?conversation=`（→ `/opening/today` or onPrimaryCta） |
| No new shell / parallel teaching app | **PASS** | Routes under existing `/api/opening/teaching-activities`; UI stays `/opening/today` Opening shell |
| Honest `generateStatus` / no fake 讲义 | **PASS** | `teachingActivityContentHonesty` + panel badges; empty copy states V2-08+ may not have full AI 主讲 |
| No MediaReader seek scope-creep | **PASS** | No MediaReader / media path diffs vs tip |
| Routes auth / opening scope | **PASS** | `GET/POST` list+create, `GET [id]`, `POST [id]/associate-course` all use `requireOpeningScope` + `getTeachingActivityService`（same pattern as other opening routes） |
| OpeningApi client | **PASS** | `list/create/get/associateTeachingActivity*` with zod parse; api.test covers list+create |
| Green tests hide missing wiring? | **No** | Source wiring is real (list/create + panel swap). Tests cover helpers, panel/resume CTA semantics, route boundary, client — not a loosened fake of broken UI |

### Diff scope vs tip（product）

**Modified:** `client/api.ts`, `client/api.test.ts`, `planning/today-dashboard.tsx`, `today-overview.tsx`, `today-resume-view.tsx`, `today-read.test.ts`, `runtime.ts`  

**New (untracked):** `app/api/opening/teaching-activities/{route.ts,route.test.ts,[id]/route.ts,[id]/associate-course/route.ts}`, `teaching/{today-activity.ts,today-activity.test.ts,activity-panel.tsx}`, `planning/today-dashboard-activity.test.ts`, implement evidence  

**On tip already (not CT-03 new):** `teaching/activity-service.ts`（V2-04）  

**Not touched:** MediaReader, Data migrations, packages/database, commit/push/hermes

## Commands re-run by Integrator（do not trust implementer）

### vitest（targeted）

```bash
cd /workspace/study-assistant-opening
PATH="./node_modules/.bin:$PATH" npx vitest run \
  apps/web/src/app/api/opening/teaching-activities/route.test.ts \
  apps/web/src/features/opening/teaching/today-activity.test.ts \
  apps/web/src/features/opening/planning/today-dashboard-activity.test.ts \
  apps/web/src/features/opening/planning/today-read.test.ts \
  apps/web/src/features/opening/planning/today-view.test.ts \
  apps/web/src/features/opening/client/api.test.ts
```

**Result（Integrator run, Start at 11:00:45 CST）:**

```text
 RUN  v4.1.10 /workspace/study-assistant-opening

 Test Files  6 passed (6)
      Tests  75 passed (75)
   Duration  4.55s
VITEST_EXIT:0
```

| Gate | Exit | Pass count |
|---|---|---|
| vitest targeted (6 files) | **0** | **75 passed** / 75 |

### tsc

```bash
cd /workspace/study-assistant-opening/apps/web && npx tsc -p tsconfig.json --noEmit
```

**Result:** empty stdout; **TSC_EXIT:0**

## not_run

| Item | Status | Reason |
|---|---|---|
| E2E / Playwright live teaching-activities | **not_run** | No live DB / browser gate in this Accept ask; named unit/UI suite only |
| Browser manual click-through `/opening/today` | **not_run** | No desktop session required by named gates; CT-03 note: blocks ACCEPT only if plan requires browser — named must-re-run list does not |
| Full monorepo / heavy vitest beyond targeted files | **not_run** | Scoped to CT-03 named files |
| Migration apply / DB integration of 0053 | **not_run** | Data already on tip `86cdf88`; Experience slice only |
| `TodayDashboard` mounted integration test with mocked list/create effects | **not_run** | Coverage is panel/resume/helpers + route + client; wiring verified by source review |

## Soft gaps（non-blocking）

1. **No browser E2E** — CTA → create/continue → panel not exercised in a real browser; unit/static markup + source review only.  
2. **`TodayDashboard` effect path** not covered by a mounted test with mock `OpeningApi`（list/create success/error）; accept relies on code review + surrounding tests.  
3. **`GET …/[id]` and `POST …/associate-course`** have routes + client methods but no dedicated route unit tests in this slice（list/create `route.test.ts` only）; Today primary path uses list+create.  
4. **Full AI 主讲 UI** intentionally absent（honesty copy → V2-08+）; panel shows status/generateStatus/intentSummary only.  
5. Working tree remains **uncommitted**; Accept does not commit/push.

## Verdict

**ACCEPT** CT-03 Today → teaching-activity Experience IMPLEMENT on tip `86cdf88` (dirty): single primary CTA continues/creates teaching activity; main pane is activity panel with honest generateStatus; AssistantView demoted; no new shell; no MediaReader creep. Integrator re-ran named vitest **75 passed** (exit 0) and `apps/web` tsc **exit 0**. E2E/browser/full-repo marked **not_run**. Soft gaps above do not hide missing product wiring.

Evidence path: `docs/superpowers/evidence/2026-10-11-opening-release/ct-03-today-activity-accept.md`
