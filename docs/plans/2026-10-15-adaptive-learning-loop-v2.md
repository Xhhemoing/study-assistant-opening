# 学习闭环 v2：按学习情况自适应编排（自动 + 辅助手动）

> 2026-10-26 配置更新：未接入执行路径的 `OPENING_PLAN_AGENT` 环境入口已退役，能力协议暂保留 false。此文保留原设计；现行控制清单见 [配置控制项盘点](../operations/feature-switch-inventory.md)。

**Date:** 2026-10-15
**Baseline:** `study-assistant-opening/feat/opening-release` @ `649353f`（Hermes 已部署）
**Status:** L0、L1 已在 `feat/opening-release`；L5 的「开始此项」与学完询问完成已随证据闭环实现，L5 其余（推迟到明天、上下移、日内重排）与 L2、L3、L4、L6、L8 未开始（2026-10-15 复核）；L7 延后
**开关:** `OPENING_ADAPTIVE_PLANNING`（默认 0，关闭时线上行为不变）、`OPENING_PLAN_AGENT`（默认 0，L7 用）

## 目标

系统每天根据学习情况自己提出今天该做什么、做多久、为什么；用户按档位选择一键确认、逐项挑选、手动调整，或交给教练在预算内自动排；学完后结果回写，当天剩余时间与次日计划随之重排。

## 现状与依据（649353f）

- 排程：`planDay`（`packages/domain/src/opening/day-planner.ts`）贪心首次适配，只按 `dueAt → priority → id` 排序，`priority` 在所有写入方都是常量 1。
- 排程看不到学习情况：`day-planner.ts`、`daily-draft.ts`、`day-blocks.ts` 没有课程或掌握度输入；任务表在 0061 之前没有 `course_id`。
- 系统不主动生成任务；自动化档位只有 `packages/domain/src/guidance/guidance.ts`（`free/advisory/coach`、`canReorderTask`），生产调用方为零。
- 学习信号已存在但没进排程：`readOpeningCourseLearningSummary`（技能状态 `unobserved/needs_check/needs_review/observed_independent`）、`opening_learning_observations`（`outcome`、`assistance`）、`card_review_states.due_at`、补测推荐时间、昨日已确认块、课程知识图先修边。
- 产品约束：`docs/product/UX_AND_AI_POLICY.md` §3 三档（手工 / 副驾驶默认 / 教练）、§4 权限矩阵（今日任务排序：教练自动、副驾驶建议后确认、手工必须手工）、§6 结果必须带 `reason_codes`、`strategy_version`；PRD §9-6 规则模型先产生价值。

## 设计

```
感知 LearnerSnapshot ─▶ 生成 proposeAdaptiveTasks ─▶ 排序 rankForPlan ─▶ 放置 planDay(不改算法)
      ▲                                                                     │
      │                       档位：手工(不出建议) / 副驾驶(草案待确认) / 教练(预算内自动确认+撤销)
      │                                                                     ▼
  回写：完成/跳过、作答观察、卡片评分 ◀── 执行：队列「开始此项」→ 主讲/练习/卡片/补测
      └─ 当日：完成或跳过后提示重排剩余时间；次日：顺延 + 新建议
```

原则：

1. 规则引擎是主干，纯函数、可回放；LLM 是 L7 的可选层。
2. 只扩展既有通道：草案 → 接受/拒绝（三重陈旧校验、咨询锁）；档位复用 `getGuidancePolicy` / `canReorderTask`。
3. 建议任务在接受前不落库：草案携带 `suggestedTasks`（预分配 id），接受时同一事务按 clientKey 幂等创建。
4. 教练不碰用户确认过的东西：仅当天无用户确认版本、或当前版本由教练确认时自动确认；只增 `planner` 任务、只调未确认顺序、新增分钟 ≤ 预算；撤销恢复上一版本，并把教练新建且未开始的任务置为跳过。
5. 原因结构化：`draft.reasons[taskId] = { code, label }` + `strategyVersion: "adaptive-1"`，UI 不再子串匹配。

### 生成规则 `adaptive-1`

| `kind` / `reasonCode` | 触发 | 默认分钟 | 优先级 |
|---|---|---|---|
| `deadline` | 已有任务 `dueAt` 在今天或已过期 | 原值 | 1 |
| `retest_due` | 补测 `recommendedAt` ≤ 当日结束 | 原值 | 2 |
| `carry_over` | 昨日已确认且仍 pending | 原值 | 3 |
| `pending_task` | 用户自己的其他待办 | 原值 | 4 |
| `weak_skill`（建议） | 技能 `needs_review`，或近 3 次观察多数为 `hinted/revealed` | 25 | 5 |
| `review_cards`（建议） | 到期卡片 ≥ 5，合为一项 | `min(30, 张数)` | 6 |
| `new_skill`（建议） | 知识图中先修已 `observed_independent` 或无先修、自身 `unobserved` 的下一个节点，且课程有可用材料 | 25 | 7 |
| `course_pace`（建议） | 课程有目标且本周已完成分钟落后于目标进度 | 25 | 提升同课程建议的排位 |

约束：每天新增建议 ≤ 3；建议总分钟 ≤ 空闲容量 × 0.8 − 已排硬约束任务分钟；同一课程不连续超过 2 项（截止任务除外）；同一建议身份（kind+课程+技能）连续 2 天被跳过 → 时长减半并标 `repeatedly_skipped`，连续 3 天 → 不再建议。

### 档位

| `autonomy` | `GuidanceMode` | 每日草案 | 新建议任务 | 自动确认 |
|---|---|---|---|---|
| `manual` | `free` | 现有规则（`buildDailyDraftInput`） | 不生成 | 否 |
| `copilot`（默认） | `advisory` | 自适应 | 生成，勾选后随确认创建 | 否 |
| `coach` | `coach` | 自适应 | 生成 | 是，限 `coachBudgetMinutes`，可撤销 |

## 已实现接口（L0，本 PR）

**迁移 `0061_opening_adaptive_planning.sql`（只新增）：**

- `opening_tasks`：`course_id uuid NULL REFERENCES courses ON DELETE SET NULL`、`skill_label`、`origin`（`manual|course_seed|retest|planner|agent`，默认 `manual`）、`not_before timestamptz`。
- `opening_plan_drafts`：`origin`（`user|auto_draft|coach|agent`，默认 `user`）、`suggested_tasks jsonb`、`reasons jsonb`、`strategy_version`。
- `workspace_preferences.adaptive_planning jsonb`：档位、教练预算、课程目标。
- 回滚语句写在迁移文件末尾注释。

与草案计划的偏差及原因：

- 档位与课程目标不放进 `planning_settings`：学期设置表单整份重写该文档，会抹掉额外字段。改用独立列 `adaptive_planning`。
- 不建 `opening_course_goals` 表：课程目标存在 `adaptive_planning.courseGoals`，随 `workspace_preferences` 自动进备份，少一张表的备份/恢复改造。
- `opening_tasks.course_id` 加外键：恢复流程会拒绝引用了归档与目标库都不存在的课程的备份，悬空 id 会挡住整次恢复。

**契约（`@aistudy/contracts`）：**

- `taskItemSchema` 可选 `courseId / skillLabel / origin / notBefore`（默认值时省略）；`taskCreateInputSchema` 可选 `courseId / skillLabel / origin: "manual"|"course_seed"`；`taskDeferInputSchema { notBefore: iso|null, expectedVersion }`。
- `planReasonCodeSchema`、`planBlockReasonSchema`、`suggestionKindSchema`、`suggestedTaskSchema { key, id, kind, title, minutes, courseId, skillLabel, reasonCode, reason }`、`planDraftOriginSchema`。
- `planDraftSchema` 可选 `origin / suggestedTasks / reasons / strategyVersion`；`acceptPlanInputSchema` 可选 `acceptSuggestedKeys`（省略 = 全部建议）；`planUndoInputSchema { date, clientKey }`。
- `openingAdaptivePrefsSchema { autonomy, coachBudgetMinutes, courseGoals: Record<courseId, { targetDate, weeklyMinutes }> }`，默认 `copilot / 60 / {}`；`openingAdaptivePrefsPatchSchema`（`courseGoal.goal: null` 删除）。
- 能力：`capabilities.adaptivePlanning`、`capabilities.planAgent`（后者需前者同时开）。

**接口：**

- `PATCH /api/opening/tasks/[id]`：body 含 `notBefore` 即推迟（版本校验，仅 pending），否则仍为状态更新。
- `GET / PATCH /api/opening/adaptive-planning`：读取与合并更新偏好（工作区行锁；课程须属本工作区且未归档）。
- 客户端：`api.deferTask(taskId, { notBefore, expectedVersion })`、`api.getAdaptivePrefs()`、`api.patchAdaptivePrefs(patch)`。
- 领域：`taskNotBeforeAt(task)`；`planDay` 与 `buildDailyDraftInput` 把 `notBefore` 当作通用 not-before（与补测推荐时间取较晚者），推迟到次日的任务不排入也不计入未排。

## L1–L3 接口（Claude 实现，任务卡按此编写）

- 领域 `packages/domain/src/opening/adaptive/`：`ADAPTIVE_STRATEGY_VERSION = "adaptive-1"`；`proposeAdaptiveTasks(snapshot, options) → { suggestions: SuggestedTask[] }`；`rankForPlan(input) → { orderedTaskIds, reasons }`；`autonomyGuidanceMode(autonomy)`；`decideCoachAutoAccept(input) → { allow, acceptKeys, reason }`；`shouldOfferReplan({ acceptedBlocks, tasks, now }) → { offer, taskIds, reason: "missed_block" | "freed_time" | null }`。
- `GET /api/opening/today` 在开关开启时额外返回 `autonomy` 与 `coach?: { draftId, addedTaskIds, addedMinutes, undoable }`。
- `POST /api/opening/plans/[id]/accept` 接受 `acceptSuggestedKeys`。
- `POST /api/opening/plans/undo { date, clientKey }`：撤销教练自动确认；无可撤销时 409。
- 客户端：`api.acceptPlan({ ..., acceptSuggestedKeys })`、`api.undoCoachPlan({ date, clientKey })`。

## 切片与分工

| # | 切片 | 负责 | 依赖 |
|---|---|---|---|
| L0 | 迁移 + 契约 + 开关 + 推迟 + 偏好接口 | Claude | — |
| L1 | 纯函数：快照类型、生成、排序、档位守卫、重排触发、7 天模拟测试 | Claude | L0 |
| L2 | 快照服务 + 自适应每日草案 + 原因落库 | Claude | L1 |
| L3 | 接受时创建建议 + 教练自动确认 + 撤销 | Claude | L2 |
| L4 | Today：档位切换、草案卡 v2、原因抽屉、教练摘要条 | Grok | L3 |
| L5 | 手动工具：开始此项、推迟到明天、上下移预览、完成回写、日内重排 | Grok | L0（前两项）/ L1–L3 |
| L6 | 课程目标编辑 | Grok | L0 |
| L7 | AI 规划层 | 延后 | L3 + 两周自用数据 |
| L8 | 闭环指标只读接口 | Grok | L3 |

文件所有权：L4 独占 `daily-draft-card.tsx`、`today-dashboard.tsx`；L5 独占 `today-view.tsx` 与 `teaching/*`；两者都需改 `today-dashboard.tsx` 时 L4 先合。`packages/contracts` 只由 Claude 改；Grok 需要新契约时在 PR 里说明，由 Claude 补。

---

## 任务卡 L4 — Today 档位、草案卡 v2、原因抽屉、教练摘要条

```text
目标 / 用户可见结果：
开关开启时，Today 头部可切换「手工 / 副驾驶 / 教练」并设置教练预算；每日草案卡逐块显示原因，
建议任务带复选框（默认勾选），确认时只创建勾选的建议；「为什么这样排」抽屉显示原因码与策略版本；
教练自动确认后显示「教练今天调整了 N 项 · 撤销」。

范围 / 允许修改文件：
apps/web/src/features/opening/planning/daily-draft-card.tsx（+ .test.ts）
apps/web/src/features/opening/planning/today-dashboard.tsx（+ today-dashboard-activity.test.ts）
apps/web/src/features/opening/planning/autonomy-switcher.tsx（新增，+ .test.ts）
apps/web/src/features/opening/planning/coach-summary.tsx（新增，+ .test.ts）

约束 / 必须保留的行为：
- 能力 capabilities.adaptivePlanning 为 false 时，Today 与现在逐像素一致（不渲染任何新控件）。
- 草案卡的确认/调整/拒绝语义、陈旧版本提示（baseVersion !== acceptedVersion）、失败不清空草案的 reducer 全部保留。
- 原因读 draft.reasons[taskId]，不得再用子串匹配 "顺延自昨天"；reasons 缺失时退回 block.reason。
- 建议任务未勾选时其时间块在预览中置灰并注明「不会创建」；确认时传 acceptSuggestedKeys（勾选的 key）。
- 撤销调用 api.undoCoachPlan，409 时显示「已无可撤销的教练安排」，不得伪造成功。
- 仅用 Tailwind 与 lucide-react；保留 aria 状态（复选框 aria-checked、抽屉 aria-expanded）。
```

**验收指标**

| 指标 | 检查 |
|---|---|
| 关闭开关零变化 | `daily-draft-card.test.ts` 断言 adaptivePlanning=false 时渲染结果不含档位切换、复选框、原因抽屉 |
| 勾选决定创建 | 单测：取消勾选 1 项后点确认，`acceptPlan` 收到的 `acceptSuggestedKeys` 不含该 key |
| 原因来源 | 单测：`reasons` 存在时显示其 label；删去 `reasons` 时退回 `block.reason`；源码不再出现 `includes("顺延自昨天")` |
| 档位切换 | `autonomy-switcher.test.ts`：切换调用 `patchAdaptivePrefs({ autonomy })`；预算输入超出 10–600 时不提交 |
| 撤销 | `coach-summary.test.ts`：成功后回调刷新；409 显示固定文案且不调用刷新 |
| 类型检查 | `npm run typecheck -w @aistudy/web` 退出码 0 |
| 单测命令 | `npx vitest run --project unit apps/web/src/features/opening/planning` 全绿 |
| 真机观测（用户，待验收） | 开关开启后切到副驾驶，草案出现建议与原因；取消一项确认后队列只多出勾选项；切教练次日出现摘要条，点撤销后计划恢复 |

---

## 任务卡 L5 — 手动编排工具

```text
目标 / 用户可见结果：
队列行可以「开始此项」「推迟到明天」；草案预览可上移/下移后重新生成；从任务进入的学习结束时提示
「把『X』标记为完成？」；完成或跳过后若剩余安排失效，提示「重排剩余时间」。

范围 / 允许修改文件：
apps/web/src/features/opening/planning/today-view.tsx（+ today-view.test.ts）
apps/web/src/features/opening/planning/task-row-actions.tsx（新增，+ .test.ts）
apps/web/src/features/opening/planning/replan-card.tsx（新增，+ .test.ts）
apps/web/src/features/opening/teaching/today-activity.ts、teaching-workspace.tsx（完成回写提示）
apps/web/src/features/opening/planning/plan-service.ts（proposeBodySchema 增加 preferredOrder；新增 delta 路由所需方法）
apps/web/src/app/api/opening/plans/delta/route.ts（新增：POST → proposeDeltaPlan）
apps/web/src/features/opening/client/api.ts（proposeDeltaPlan 客户端方法）

约束 / 必须保留的行为：
- 「开始此项」：task.courseId 存在 → api.createTeachingActivity，courseId=task.courseId、
  intentSummary=任务标题、clientKey=`task:${task.id}`（同一任务重复点击返回同一活动），
  复用 buildStartLearningCreateInput 的 sourceIds 规范化；origin=planner 且 kind=review_cards
  的任务跳转 /opening/cards；补测任务沿用现有「开始补测」。
- 「推迟到明天」：notBefore = 工作区时区（resolveTodayTimeZone）的次日 00:00 对应的 UTC 时刻；
  使用 api.deferTask 带 expectedVersion，409 时提示重新读取，不重试。
- 上移/下移只改草案预览，不直接改已确认计划；提交走 proposePlan(preferredOrder) → 预览 diff
  （复用 diffAgainstConfirmedPlan）→ 用户确认。
- 完成回写只「提示」，不自动标记完成（遵守「计时与浏览不会自动标记完成」）。
- 重排提示用领域 shouldOfferReplan；副驾驶显示卡片，用户确认后才调用 delta 接口。
- 行内操作按钮不得嵌套在行选择 <button> 内。
```

**验收指标**

| 指标 | 检查 |
|---|---|
| 开始此项幂等 | 单测：同一任务点击两次，`createTeachingActivity` 两次收到相同 clientKey 与 courseId |
| 推迟时刻 | 单测：时区 Asia/Shanghai、本地 2026-10-15 23:30 时，notBefore = `2026-10-15T16:00:00.000Z` |
| 推迟后不排入 | 集成：`tests/integration/handler/opening-daily-draft.test.ts` 新增用例，推迟到明天的任务不出现在今日草案块与未排列表 |
| 上下移 | 单测：上移后调用 `proposePlan` 的 `preferredOrder` 顺序正确；未确认前已确认计划不变 |
| 完成回写不自动 | 单测：学习结束只渲染提示，未点击前不调用 `updateTaskStatus` |
| 重排卡 | 单测：错过一个已确认块时出现卡片；点击后调用 delta 接口且 taskIds 为剩余待办 |
| 嵌套交互 | 单测：行内不存在 `<button>` 嵌套 `<button>` |
| 类型检查 | `npm run typecheck -w @aistudy/web` 退出码 0 |
| 真机观测（用户，待验收） | 点「开始此项」进入带课程的主讲；推迟后刷新今日队列不见该项、次日出现；学完回来看到完成提示 |

---

## 任务卡 L6 — 课程目标编辑

```text
目标 / 用户可见结果：
课程页可设置「目标日期（可空）」与「每周投入分钟」；保存后次日草案按 course_pace 规则体现进度。

范围 / 允许修改文件：
apps/web/src/features/courses/course-goal-form.tsx（新增，+ .test.ts）
apps/web/src/features/courses/course-detail.tsx（挂载表单，仅 opening 页面）

约束 / 必须保留的行为：
- 只在 capabilities.adaptivePlanning 为 true 时显示。
- 读写走 api.getAdaptivePrefs / api.patchAdaptivePrefs({ courseGoal: { courseId, goal } })，
  「清除目标」发送 goal: null。
- 目标日期早于今天时提示但允许保存；每周分钟 0–3000 之外不提交。
- 不修改 planning_settings、不修改学期设置表单。
```

**验收指标**

| 指标 | 检查 |
|---|---|
| 读写 | 单测：保存调用 `patchAdaptivePrefs` 的 body 与表单一致；清除发送 `goal: null` |
| 校验 | 单测：weeklyMinutes=3001 或负数时不调用接口并显示错误 |
| 开关 | 单测：adaptivePlanning=false 时不渲染 |
| 类型检查 | `npm run typecheck -w @aistudy/web` 退出码 0 |
| 真机观测（用户，待验收） | 设定目标后刷新课程页数值保留；本周投入落后时次日草案出现该课程的 `course_pace` 原因 |

---

## 任务卡 L8 — 闭环指标只读接口

```text
目标 / 用户可见结果：
开发者设置层可查看最近 N 天（默认 14）的闭环指标，用于判断规则是否贴合、教练是否太激进。

范围 / 允许修改文件：
packages/domain/src/opening/adaptive/loop-metrics.ts（新增纯函数，+ .test.ts）
apps/web/src/app/api/opening/plans/metrics/route.ts（新增 GET ?days=）
apps/web/src/features/settings/advanced-settings-view.tsx（只读展示一块）

约束 / 必须保留的行为：
- 只读；不写任何表；开关关闭时路由返回 404。
- 指标定义（分母为 0 时返回 null，不返回 0）：
  completionRate = 窗口内已确认块所指任务中 status=done 的比例；
  suggestionAdoption = 窗口内被创建的 planner 任务数 ÷ 草案 suggested_tasks 中出现过的不同 key 数；
  coachUndoRate = 撤销次数 ÷ 教练自动确认次数；
  weakSkillLatencyDays = needs_review 技能从首次建议到下一次作答观察的天数中位数。
- 每个指标带 { value, numerator, denominator }，便于核对。
```

**验收指标**

| 指标 | 检查 |
|---|---|
| 纯函数 | `loop-metrics.test.ts` 覆盖 4 个指标的正常值与分母为 0 → null |
| 路由 | 集成：开关关闭 404；开启时返回结构匹配上方定义，其他用户的数据不计入 |
| 类型检查 | `npm run typecheck -w @aistudy/domain` 与 `-w @aistudy/web` 退出码 0 |
| 真机观测（用户，待验收） | 自用两周后在开发者设置看到四项指标及分子分母 |

---

## 验证（L1–L3，Claude）

- 单测：`npx vitest run --project unit packages/domain/src/opening/adaptive`；`loop-simulation.test.ts` 合成两门课、一个 `needs_review` 技能、12 张到期卡、14 天后考试，连跑 7 天并断言：容量不超、截止任务优先、薄弱点第 1 天出现且掌握后 2 天内不再出现、到期卡 ≥5 时每天恰好一项复习、同课程不连续超过 2 项、跳过递减规则、手工档零建议、教练守卫、每块有原因与策略版本、同输入结果完全相同。
- 集成：建议任务勾选后恰好创建一次、重放不重复、未勾选不创建、块内无残留占位；并发两次 `getToday` 在教练档只自动确认一次；撤销后版本 +1、块恢复、教练新建未开始任务变 `skipped`；开关关闭时既有 `opening-daily-draft` 测试不改且通过。
- 类型：`npm run typecheck -w @aistudy/{contracts,config,domain,database,web,worker}`。

## 真实使用指标（用户，自用两周）

进入计划的任务完成率（对比启用前一周）、建议采纳率、教练撤销率（> 30% 说明太激进）、薄弱点从 `needs_review` 到下一次作答的天数、打开 Today 到开始第一项的操作步数（目标 ≤ 2）。由 L8 读出；全部标记「待用户验收」，Agent 不声称通过。

## 回滚

关闭 `OPENING_ADAPTIVE_PLANNING` 即恢复现有排程行为。0061 只新增列，回滚语句见迁移文件注释；关闭开关后不必回滚迁移。
