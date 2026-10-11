# V2-16 Teaching loop — Experience UI half Implement Evidence

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Experience (executor / Grok Bot)  
**Branch:** `feat/opening-release`  
**Tip HEAD (baseline; Integrator harness committed):** `72033cb` — `feat(opening): V2-16 AI teaching loop trial gate and harness`  
**Status:** **implemented, awaiting Data or Integrator independent Implement ACCEPT** — do **not** self-ACCEPT; `tasks.json` not marked verified  
**Hard rules held:** No commit / push / hermes / stash / reset · No Integrator harness/flag rewrite (consume only `teaching-loop-flag` / `teaching-workspace-flag`) · Exclusive Experience thin tree · No self-ACCEPT

## Authority followed

- Plan: `docs/superpowers/plans/ai-led-learning-v2/v2-16-teaching-loop-plan.md`（thin entry / empty copy = Experience sequenced）
- PM lock: UI trial = **both** `OPENING_TEACHING_LOOP` + `OPENING_TEACHING_WORKSPACE`
- Integrator Implement + ACCEPT:
  - `docs/superpowers/evidence/2026-10-11-opening-release/v2-16-teaching-loop-implement.md`
  - `docs/superpowers/evidence/2026-10-11-opening-release/v2-16-teaching-loop-accept.md`
- Flag modules on tip (consume only):
  - `apps/web/src/features/opening/teaching/teaching-loop-flag.ts`
  - `apps/web/src/features/opening/teaching/teaching-workspace-flag.ts`
- Style mirror: `v2-15-matrix-transform-experience-implement.md` / `v2-14-learning-resume-experience-implement.md`

## Diff scope (Experience only)

### New

| Path | Role |
|---|---|
| `apps/web/src/features/opening/teaching/teaching-loop-trial.ts` | `resolveTeachingLoopTrialGate` / `isOpeningTeachingLoopTrialEnabled` = **loop && workspace** (calls both existing helpers; no third env parser) |
| `apps/web/src/features/opening/teaching/teaching-loop-trial-empty.tsx` | Honest empty UI：试运行需双旗；不进入主讲工作台；自由对话仅次要链接 |
| `apps/web/src/features/opening/teaching/teaching-loop-trial.test.ts` | Dual-gate matrix + empty SSR honesty |

### Updated

| Path | Change |
|---|---|
| `apps/web/src/features/opening/planning/today-dashboard.tsx` | Today/continue → `TeachingContinueEntry` **仅** when dual trial on；否则 `TeachingLoopTrialEmpty`；resume/clientInit fetch 同步改用 trial gate；props 可覆写 loop/workspace/trial |
| `apps/web/src/features/opening/planning/today-dashboard-activity.test.ts` | V2-16 dual-gate describe：both on → entry；loop/workspace/both off → empty honesty |

### Explicitly not touched

- Integrator: `teaching-loop-flag.ts` / `.test.ts`、`tests/integration/opening-teaching-loop.test.ts`、`tests/e2e/opening-teaching.spec.ts`
- Data contracts/domain / AI compiler
- No migration / no `0058`
- No commit / push / hermes / stash / reset / self-ACCEPT / `tasks.json` verified
- 无关未跟踪文档（`rp5-gha-…`、`p0-assistant-list-…`）未动

## UX summary

1. **Dual gate:** `isOpeningTeachingLoopTrialEnabled` = `isOpeningTeachingLoopEnabled` && `isOpeningTeachingWorkspaceEnabled`。  
2. **Both on** → mount `TeachingContinueEntry`（既有 TeachingWorkspace continue 路径）。  
3. **Either / both off** → `TeachingLoopTrialEmpty`：明确文案「需要同时开启 LOOP 与 WORKSPACE」；列出缺少的旗；**不会**静默进入主讲工作台，也**不会**把自由对话当成主讲试运行。  
4. 自由对话仍为 **quiet 次要**链接。  
5. 试运行关闭时诚实声明：保留既有活动/断点；不伪造讲义。

## Soft gaps (honest)

1. **Browser / user_browser:** `not_run` / pending_user（本切片以 vitest SSR + 纯函数双旗矩阵覆盖）。  
2. **TodayDashboard 全量挂载机：** 未用 jsdom 点选；gate 决策与 empty markup 已测。  
3. **TeachingActivityPanel** 不再由 Today 在 trial-off 时挂载（改由诚实 empty）；组件本身 CT-03 单测仍保留。  
4. Integrator integration / e2e / `real_model` 状态不变（本半不重跑 DB）。

## Commands run + results

### Tip

```text
$ git rev-parse HEAD
72033cbc1235b00ddb745b1fd999da8b5b2d2b17

$ git log -1 --oneline
72033cb feat(opening): V2-16 AI teaching loop trial gate and harness

$ git branch --show-current
feat/opening-release

$ date '+%Y-%m-%d %H:%M %Z'
2026-10-11 14:10 CST
```

### Targeted vitest (Experience dual-gate)

```text
$ PATH="./node_modules/.bin:$PATH" bash scripts/run-heavy.sh vitest run --project unit \
    apps/web/src/features/opening/teaching/teaching-loop-trial.test.ts \
    apps/web/src/features/opening/planning/today-dashboard-activity.test.ts

 Test Files  2 passed (2)
      Tests  20 passed (20)
```

（其中 `teaching-loop-trial.test.ts` **7**；`today-dashboard-activity.test.ts` **13**，含既有 CT-03/V2-10 + 新增 V2-16 五例。）

### Flag helpers smoke (consume-only; untouched)

```text
$ … vitest run --project unit \
    …/teaching-loop-flag.test.ts …/teaching-workspace-flag.test.ts
# → included in earlier 4-file run: 25 passed total with dual-gate files
```

### Typecheck

```text
$ PATH="./node_modules/.bin:$PATH" bash scripts/run-heavy.sh npx tsc -p apps/web/tsconfig.json --noEmit
TSC_EXIT=0
```

## Handoff — 中文 Accept（非作者）

**请 Data 或 Integrator（≠ Experience 本半作者）做独立 Implement ACCEPT。**

验收要点：
1. Tip 仍为 `72033cb`；本半 **未 commit**；脏树仅 Experience 上述文件 + 本证据。  
2. 双旗：`LOOP && WORKSPACE` 才挂 `TeachingContinueEntry`；任一关 → `data-teaching-loop-trial-empty` 诚实 empty（不静默当主讲/自由对话冒充）。  
3. 未改 Integrator flag 实现；Experience 仅 **调用** 既有 `isOpeningTeachingLoopEnabled` / `isOpeningTeachingWorkspaceEnabled`。  
4. 重跑：`vitest run --project unit` 上述 2 文件 → **20 passed**；`tsc -p apps/web` → **0**。  
5. **禁止** self-ACCEPT；**禁止** 翻 `tasks.json` verified（仅 Accept 可翻）。  
6. DDL 仍 NO；无 `0058`。

**Accept 目标角色：** AIstudy Data（优先）或 AIstudy Integrator — **不得**由 Experience 自签。
