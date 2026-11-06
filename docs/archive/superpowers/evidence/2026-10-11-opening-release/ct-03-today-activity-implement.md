# CT-03 Today → teaching activity — IMPLEMENT

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Experience (executor)  
**Baseline tip:** `86cdf88717677b25d06da24d1a620db7a2a15b06` (`feat/opening-release`, includes V2-04 migration 0053)  
**Status:** IMPLEMENT complete — **uncommitted**; no push / hermes / stash / reset  
**Do not self-mark:** ACCEPT / verified（Integrator 复跑后拍板）

## Goal

Wire Today 「继续学习 / 开始学习」 to `activity-service` / teaching activity. Evolve Today main area from pure embedded `AssistantView` to **current teaching-activity entry**. One primary CTA; UI state follows activity; no new shell / no parallel app.

## Diff scope（本切片）

### New

| Path | Role |
|---|---|
| `apps/web/src/app/api/opening/teaching-activities/route.ts` | `GET` list / `POST` create |
| `apps/web/src/app/api/opening/teaching-activities/route.test.ts` | Route boundary tests |
| `apps/web/src/app/api/opening/teaching-activities/[id]/route.ts` | `GET` by id |
| `apps/web/src/app/api/opening/teaching-activities/[id]/associate-course/route.ts` | `POST` associate-course |
| `apps/web/src/features/opening/teaching/today-activity.ts` | pick CTA / create-input / honesty labels |
| `apps/web/src/features/opening/teaching/today-activity.test.ts` | Helper unit tests |
| `apps/web/src/features/opening/teaching/activity-panel.tsx` | Main-pane activity panel + empty start |
| `apps/web/src/features/opening/planning/today-dashboard-activity.test.ts` | CTA / panel / resume demotion tests |
| `docs/superpowers/evidence/2026-10-11-opening-release/ct-03-today-activity-implement.md` | This evidence |

### Modified

| Path | Change |
|---|---|
| `apps/web/src/features/opening/runtime.ts` | `getTeachingActivityService` |
| `apps/web/src/features/opening/client/api.ts` | `list/create/get/associateTeachingActivity*` on OpeningApi |
| `apps/web/src/features/opening/client/api.test.ts` | Client list+create coverage |
| `apps/web/src/features/opening/planning/today-dashboard.tsx` | Primary CTA + activity main pane; assistant demoted |
| `apps/web/src/features/opening/planning/today-overview.tsx` | `primaryAction` / `secondaryAction` slots |
| `apps/web/src/features/opening/planning/today-resume-view.tsx` | Same CTA semantics; conversation → quiet secondary |
| `apps/web/src/features/opening/planning/today-read.test.ts` | Align with demoted assistant link |

### Explicit non-touches

- No Data migration / repo rewrite（V2-04 already on tip）
- No MediaReader auto-seek
- No push / hermes / stash / reset / commit
- No full AI 主讲 generation UI（V2-08+）；`generateStatus` shown honestly

## UX summary（中文）

1. **主 CTA（唯一主操作）**  
   - 有 `active` / `paused` 活动 → 「继续学习」打开该活动主区  
   - 否则 → 「开始学习」：`POST` 创建活动（有上次对话则 `intentKind: resume` + 诚实摘要；否则 `topic` /「今日主题学习」；`clientKey` 按日幂等）
2. **主区**  
   - `TeachingActivityPanel`：intentSummary、status、generateStatus、updatedAt + 诚实说明（不伪造讲义）  
   - 无活动：空态 + 「开始学习」
3. **自由对话降级**  
   - Header / panel / resume 均为 quiet「自由对话 / 打开自由对话（次要）」；不再嵌入 `AssistantView` 作主区
4. **resume body**  
   - 无 activity 时主 CTA 文案为「开始学习」（创建路径）；有 activity 为「继续学习」；对话链接次要

## Gates（实际跑过）

### vitest（ran）

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

**完整结果摘要（原文）：**

```text
 RUN  v4.1.10 /workspace/study-assistant-opening


 Test Files  6 passed (6)
      Tests  75 passed (75)
   Start at  10:59:01
   Duration  4.48s (transform 1.48s, setup 0ms, import 3.10s, tests 233ms, environment 1ms)
```

| Gate | Result |
|---|---|
| vitest targeted | **75 passed** / 6 files（exit 0） |

### tsc（ran）

```bash
cd /workspace/study-assistant-opening/apps/web && npx tsc -p tsconfig.json --noEmit
```

**完整结果摘要（原文）：**

```text
(no diagnostics; empty stdout)
EXIT:0
```

| Gate | Result |
|---|---|
| `apps/web` `tsc -p tsconfig.json --noEmit` | **exit 0** |

### not_run

| Item | Status |
|---|---|
| Full monorepo / heavy vitest beyond targeted files | `not_run` |
| E2E / Playwright against live DB teaching-activities | `not_run` |
| Migration apply / DB integration of 0053 in this Experience slice | `not_run`（Data tip already includes 0053） |
| Browser manual click-through on /opening/today | `not_run` |

## Accept ask（Integrator）

请 Integrator **Accept CT-03 IMPLEMENT** 当且仅当复跑后确认：

- [ ] Routes：`GET/POST /api/opening/teaching-activities`、`GET …/[id]`、`POST …/[id]/associate-course` 鉴权与 opening scope 与现有 opening 路由一致
- [ ] OpeningApi client：list/create/get/associate 可用
- [ ] Today：单一主 CTA；有活动→继续，无→开始并创建；主区为活动面板；自由对话为次要 quiet link；**无**新 shell
- [ ] `generateStatus` 诚实展示；无伪造主讲讲义
- [ ] 证据内 vitest/tsc 命令可复现；改动仍 uncommitted
- [ ] 未 push / hermes / stash / reset

**本证据不自标 ACCEPT / verified。**

## FYI — room-ready summary

Experience CT-03 on tip `86cdf88`: teaching-activities API + OpeningApi client; Today primary CTA continues/creates teaching activity; main pane is activity panel (honest generateStatus); AssistantView demoted to quiet secondary. Vitest 75 pass + web tsc exit 0. Evidence: `ct-03-today-activity-implement.md`. Ready for Integrator Accept (no self-ACCEPT).
