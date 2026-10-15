# 自适应副驾驶闭环：最终执行计划

**日期：** 2026-10-15
**基线：** `feat/opening-release` @ `e69a406`（含 #47；上游两份外部建议基于更早的 `544304e`）
**取代：** 外部《优化实施计划 v2》的 T00–T11 编号，以及 PR #46 中的 `docs/plans/2026-10-15-human-ai-adaptive-architecture.md`。编号沿用 [`2026-10-15-adaptive-learning-loop-v2.md`](2026-10-15-adaptive-learning-loop-v2.md) 的 L0–L8，本文只补充新增切片和对原卡片的修订；原文的接口、档位规则、L4/L6/L8 任务卡仍然有效，冲突处以本文为准。
**状态：** 计划。本文不代表任何切片已实现。

## 0. 一句话目标

**一次有依据的学习表现，能改变下一份每日草案和下一次讲解；学生能看懂原因，并能接受、修改或拒绝。**

批次 A 完成后，下面这条路径在真实数据库上成立：作答 → 核对 → 观察入账 → 次日（或当日刷新）草案出现对应活动及原因 → 学生勾选接受 → 恰好创建一次任务 → 开始此项时主讲知道要针对什么困难。

## 1. 已核实的基线（2026-10-15，本计划作者复核）

外部两份分析的大方向成立，以下几处已按源码和 CI 核对或修正：

| 事项 | 结论 | 依据 |
|---|---|---|
| 实际每日草案不走自适应规则 | **属实**。`plan-service.ts` 只调用 `buildDailyDraftInput → planDay`；`proposeAdaptiveTasks`、`rankForPlan` 在 `packages/domain` 之外没有任何生产调用方 | `apps/web/src/features/opening/planning/plan-service.ts:200-213` |
| 接受事务不含选中建议 | **属实**。`acceptPlan` 的 payloadHash 只含 `draftId + expectedBaseVersion`，不创建建议任务 | `packages/database/src/repositories/opening-plans.ts:347-353` |
| HTTP 学情摘要裁剪为 20 条 | **属实**。`REPRESENTATIVE_LIMIT = 20` 仅用于展示 | `apps/web/src/features/opening/learning/summary-response.ts:5` |
| 技能名默认取活动意图 | **属实**。`context.intentSummary.slice(0, 200)`；数据库只有 `skill_label TEXT`，没有稳定技能 id | `teaching/inline-attempt.tsx:34`，迁移 `0019` |
| 技能名不稳定还会破坏排程去重 | **新增**。建议身份 `suggestionIdentity(kind, courseId, hash(skillLabel))`，任务 clientKey 为 `planner:<日期>:<身份>`，`plannerHistory` 由此重建。技能名漂移会让“连续跳过减负”“同日不重复”全部失效 | `packages/domain/src/opening/adaptive/types.ts:58-71` |
| 主讲输入没有学情 | **属实**。worker 只传材料、`intentSummary`、`intentKind` | `apps/worker/src/runtime/compile-teaching-unit-wiring.ts:53,107` |
| 课程交替会跨越优先层 | **属实**。`interleaveCourses` 作用于截止任务之后的整段（补测/顺延/自有任务/建议），可把低优先项提到补测之前 | `rank-for-plan.ts:46-66` |
| 估计器 `firstAttempt` 恒为 null | 属实，但**估计器目前没有生产调用方**，不影响现有功能；只在接 BKT 前需要补 | `packages/domain/src/opening/estimators/skill-evidence.ts:9` |
| 已有技能名归一化工具 | **新增**。`normalizeSkillLabelKey`、`collectSkillLabelOptions`、`findSkillLabelReuseHint`、`nodeIdForSkillLabel` 已存在，可直接复用 | `learning/skill-label-options.ts`、`learning/knowledge-node-lookup.ts` |
| PR #46 的 CI | 外部报告说“workflow 布局与 Jobs API 不一致”，**不成立**：CI 只有一个 job `lint-typecheck-test-build`。PR #46 的 Lint、Typecheck、单元、集成、handler **全部通过**，仅 `Browser tests` 失败、`Build` 因此被跳过 | Actions run 38731475149 |
| 浏览器步骤失败的归属 | **基线问题，不是 #46 引起的**：`feat/opening-release` 上 `7fb4f85`、`544304e`、`c96211f`、`e69a406` 四次 push 的 CI 都在同一步 `Browser tests` 失败 | Actions runs 179/180/183/184 |
| 主干 | `e69a406`（#47 已 squash 合入，外加一个 lint 修复）；#48（侧栏导航）open | — |

PR #46 的代码改动（`propose-tasks.ts` 两处、30 行左右）已复核：同日 done/skipped 不复活、卡片复习减负不反增时长，逻辑正确且有 vitest 测试。

## 2. 对两份外部建议的取舍

**采纳：**
- 不重写、不建多 Agent 平台；规则引擎是主干，LLM 只做意图理解与局部讲解。
- 学情同时驱动“排什么”和“讲什么”；教学目标由服务器构造，不交给提示词自由发挥。
- 内部快照用完整证据计算入口，20 条是展示上限。
- `verifiedCorrect = no` 是有效负证据，`unknown` 才是无法确认；提示后答对不算独立。
- 接受时重验 + 选中集合进幂等身份 + 原子提交；GET 不承担新的执行权。
- 跳过/拒绝/系统撤销语义分开；系统撤销不计入学生连续跳过。
- 副驾驶先上，教练单独验收；BKT 先影子运行。

**修改或推迟（理由：当前是单人自用阶段，见 STATUS 目标；按 AGENTS.md“最小必要实现”）：**

| 外部建议 | 本计划的处理 | 理由 |
|---|---|---|
| 稳定技能身份先做 alias 映射、双写、迁移 | 批次 A 只修**默认值来源**和复用提示（不加迁移）；`skill_ref` 列放批次 C，与 BKT 一起做 | 碎片化的主因是默认值取活动标题；单人数据量小，加列迁移的收益要等估计器真正上线才兑现 |
| `LearnerContext` 带 privacyEpoch、计划版本等完整 provenance | 只带 `workspaceHistoryRevision`（已有）+ `strategyVersion` + 各数据源 `dataStatus` | 授权与版本在接受事务里重读重验，快照里的版本号只用于追溯，不当作安全依据 |
| `TeachingTarget` 九个字段 | 批次 A 只传五项：技能名、最近观察结论（含错因文本）、辅助情况、活动类型、学生的表达偏好 | 先证明“不同证据 → 不同讲解重点”，再扩字段 |
| T08 窄题型自动判分进第一批 | 放批次 B | 参考自核已能产生有效负证据，副驾驶闭环不依赖自动判分 |
| T10a 对话意图抽取随草案管道前移 | 放批次 C，L3a 稳定后再开 | 先让 Today 这条确定性入口跑通真实自用；对话入口复用同一接受通道，晚接不返工 |
| T00 核对“工作流不一致” | 改为 **C0：定位基线浏览器步骤失败**（独立任务，不阻塞开发） | 不一致不存在；真正问题是主干浏览器步骤持续红 |
| 新建 `TeachingTarget` 表、快照哈希、事件总线 | 不做 | 现有修订号、版本、幂等键足够 |

## 3. 设计约束（所有卡片共用）

1. **事实与判断分离**：作答、核对、辅助暴露是事实，只能经现有观察写入路径产生；掌握状态是可重算的投影。任何 LLM 输出、学生自述“我会了”都不直接生成作答事实。
2. **负证据保留**：快照与教学使用 `verifiedCorrect` 的三值语义；不得把 `no` 和 `unknown` 合并，也不得只筛 `yes`。
3. **完整证据**：快照复用 `learning/read-service.ts` 内部的完整 `CourseEvidence` + `summarizeObservations`，不调用 HTTP 摘要接口、不用 `summary-response.ts` 的投影。
4. **读取失败 ≠ 空**：每个数据源返回 `available | not_configured | unavailable`。课表/约束 `unavailable` 时不生成自适应建议（退回现有规则草案并说明原因），不能当成“全天空闲”。单门课程读取失败只跳过该课程。
5. **草案无副作用**：接受前不创建任务；建议正文只来自服务器保存的 `suggested_tasks`，不信任客户端提交的任务内容。
6. **GET 只读+兼容**：Today GET 维持现有“确保未确认草案”的行为，不在 GET 里加模型调用、教练自动接受或外部写入。
7. **锁与事务**：不在持锁事务中调用模型或做大批量查询；规则计算在事务外完成，提交事务只做重验和写入。新增锁顺序必须与 `opening-learning-facts.ts` 现有顺序一致。
8. **开关**：所有新行为在 `OPENING_ADAPTIVE_PLANNING=1` 时才生效；关闭时现有 `opening-daily-draft`、`opening-plans`、`opening-today-read` 测试不改且通过。
9. **不新增**：通用 Agent 框架、事件总线、快照哈希、gate/baseline/evidence 文件、`setMastery` 类接口。

## 4. 批次与依赖

```text
批次 A（副驾驶最小闭环）
  C0 浏览器基线失败定位 ──────────────(并行，阻塞发布不阻塞开发)
  A0 合入 #46 代码 ─┐
  A1 交替不跨层 ────┼─▶ L2a 学生快照 ─▶ L2b 自适应草案 ─▶ L3a 接受选中建议 ─▶ L4 Today 副驾驶
  A2 技能名默认值 ──┘          │                                     └──▶ L6 课程目标编辑(可与 L4 并行)
                              └─▶ TT 学情进入主讲（L2a 后即可开始，与 L2b/L3a 并行）
批次 B（真实负担与可靠评价）：L5 反馈与低打扰重排 → L8 闭环指标 → E1 窄题型自动评价
批次 C（有限自主与扩展）：L3b 教练自动确认与条件撤销；L7a 对话进入同一草案管道；I2 skill_ref 迁移 + firstAttempt + BKT 影子
```

**分工（按 `docs/operations/agent-workflow.md`）：** 动 contracts / migration / 事务 / 跨包的卡由 Claude 负责（L2a、L2b、L3a、TT、L3b、I2、C0）；边界清楚的卡交 Grok（A1、A2、L4、L6、L8、L5 的 UI 部分）；每张 Grok 卡合并前由 pi 用不同模型做只读审查。同时最多 3 个 worktree；`today-dashboard.tsx` 同一时间只允许一个写入者（L4 先合，L5 后改）。

**批次 A 的完成标准**见第 7 节验收矩阵；批次 A 全部合入且用户浏览器验收通过后，才在 Hermes 上把 `OPENING_ADAPTIVE_PLANNING` 设为 1。

## 5. 批次 A 任务卡

每张卡的通用要求：基于最新 `feat/opening-release` 新建分支、独立 worktree；先读根 `AGENTS.md` 和目标包 `AGENTS.md`；只跑最近的测试和所属包类型检查；不跑浏览器测试、不调用付费模型；返回改了哪些文件、实际命令与结果、未解决问题。

### C0｜主干浏览器步骤失败定位（Claude，并行）

- **目标**：查明 `feat/opening-release` CI 的 `Browser tests` 自 `7fb4f85` 起持续失败的根因，恢复 CI 全绿或给出明确阻塞说明。
- **做法**：下载 run 38752215093（`e69a406`）的 Playwright 报告/日志，找到第一个失败用例；对照最后一次绿的 run 的提交范围二分。根据 AGENTS.md，浏览器验收归用户，但 **CI 中既有浏览器测试的失败需要定位**；只做最小修复。
- **不许**：跳过、禁用或放宽浏览器用例；把失败改成 `continue-on-error`。
- **完成标准**：CI `Browser tests` 与 `Build` 在主干变绿；或在 STATUS 写明根因、需要用户做什么。
- **回滚**：普通 revert。

### A0｜合入 PR #46 的规则修复（用户/Claude）

- **做法**：PR #46 的 CI 非浏览器步骤已全绿，浏览器失败属于基线（见 C0）。从 #46 删除 `docs/plans/2026-10-15-human-ai-adaptive-architecture.md`（内容已并入本文），保留 `propose-tasks.ts` 与 `propose-tasks-feedback.test.ts`，与主干合并后转为 ready，由用户合并。
- **验收**：`npx vitest run --project unit packages/domain/src/opening/adaptive`；`npm run typecheck -w @aistudy/domain`。
- **注意**：这两项修复要等 L2a 把同日 done/skipped 历史读进快照后才真正生效。

### A1｜课程交替不跨越优先层（Grok）

- **目标**：交替只在同一优先层内部调整顺序；补测、顺延、自有任务、建议四层的先后不被打乱。
- **允许修改**：`packages/domain/src/opening/adaptive/rank-for-plan.ts` 及其测试。
- **要求**：`interleaveCourses` 分别作用于每一层（截止层仍不参与）；每层内保持“同课程最多连续 2 项”；层与层边界处不再为交替而跨层借位。
- **验收**：新增用例——课程 A 有 3 个到期补测、课程 B 有 1 个自有任务时，B 的任务排在 A 的第 3 个补测之后；`loop-simulation.test.ts` 其余断言不变。`npx vitest run --project unit packages/domain/src/opening/adaptive`；`npm run typecheck -w @aistudy/domain`。

### A2｜作答技能名默认值不再取活动标题（Grok）

- **目标**：同一知识点的作答落到同一个技能名下，排程建议身份因此稳定。
- **允许修改**：`apps/web/src/features/opening/teaching/inline-attempt.tsx`、`inline-attempt-submission*`、其测试；只读复用 `learning/skill-label-options.ts`、`learning/knowledge-node-lookup.ts`。
- **规则**（按优先级取默认值）：
  1. 当前讲解块/大纲条目对应的课程知识节点标题（经 `nodeIdForSkillLabel` 能对上节点的）；
  2. 本课程已有技能名中与当前大纲条目标题归一化后相同的那个（`findSkillLabelReuseHint`）；
  3. 当前大纲条目标题；
  4. 都没有：留空并显示本课程已有技能名供选择，**不再回退到 `intentSummary`**。
  学生仍可编辑；输入与已有技能只差空格/全半角/大小写时提示复用（不自动改写）。
- **不许动**：数据库、contracts、观察写入路径、历史数据。
- **验收**：单测覆盖四级回退、`intentSummary` 不再作为默认值、复用提示；`npx vitest run --project unit apps/web/src/features/opening/teaching apps/web/src/features/opening/learning/skill-label-options.test.ts`；`npm run typecheck -w @aistudy/web`。
- **若当前讲解块拿不到大纲条目/节点信息**：停下来报告，由 Claude 在 TT 中补充活动上下文，不在本卡改契约。

### L2a｜学生快照服务（Claude）

- **目标**：服务器内部一次读出排程与教学共用的 `LearnerSnapshot`，覆盖现有 `types.ts` 中的全部字段，再加数据状态与追溯信息。
- **新增**：`apps/web/src/features/opening/planning/learner-snapshot-service.ts`（use case，依赖注入仓储，便于 handler/集成测试）。
- **读取内容**：
  - 课程：未归档课程、`adaptive_planning.courseGoals`、本周已完成分钟（标注为“投入”而非“掌握”）。
  - 技能：经 `read-service.ts` 内部完整证据 + `summarizeObservations` 得到的每个技能状态、最近观察时间、最近 3 次 `assistance`；保留最近一次有效观察的 `verifiedCorrect` 三值与学生填写的错因文本（供 TT 使用）。只取有效 head（被修订/撤回的不计）。
  - `nextSkills`：课程知识图中先修已 `observed_independent`（或无先修）且自身 `unobserved` 的节点，且课程 `hasUsableMaterials`。
  - 到期卡片数；任务；昨日已确认块；时间窗口与硬约束。
  - `plannerHistory`：近 7 天 `client_key` 以 `planner:` 开头的任务，用 `parseSuggestionKey` 还原 `{date, identity, status}`，**包括当日 done/skipped 与更早仍 pending 的**。
- **新增字段**（扩展 domain `LearnerSnapshot` 类型，可选字段，不破坏现有纯函数测试）：`dataStatus: Record<'courses'|'evidence'|'cards'|'constraints'|'history', 'available'|'not_configured'|'unavailable'>`、`workspaceHistoryRevision`（复用 `opening-learning-facts.ts` 的修订计数）。
- **要求**：scope 只来自认证；按课程批量查询，记录查询次数与耗时（日志），先不加缓存；读取在事务外完成。
- **验收（integration）**：新增 `tests/integration/opening-learner-snapshot.test.ts`：
  - 同一技能 25 条观察 → 快照状态与按全量计算一致（证明不受 20 条裁剪影响）；
  - 一条 `verifiedCorrect=no` 的独立作答 → 技能为 `needs_review` 且保留负证据；`unknown` 不被当作错；
  - 提示后答对 → `recentAssistance` 含 `hinted`，不升级为 `observed_independent`；
  - 被修订的观察只按新 head 计算；
  - 当日 done/skipped 的 planner 任务出现在 `plannerHistory`；
  - 某课程证据读取抛错 → 其他课程正常，`dataStatus.evidence = 'unavailable'`；
  - 跨工作区读取被拒。
  - 类型：`npm run typecheck -w @aistudy/domain -w @aistudy/web`。

### L2b｜真实自适应每日草案（Claude）

- **目标**：开关开启时，`ensureDailyDraft` 走 `snapshot → proposeAdaptiveTasks → rankForPlan → planDay`，草案持久化 `suggested_tasks`、`reasons`、`strategy_version`。
- **允许修改**：`planning/plan-service.ts`、`packages/database/src/repositories/opening-plans.ts`（自动草案输入与映射）、相关 contracts（如需）。
- **要求**：
  - 开关关闭或 `autonomy=manual`：完全走现有路径。
  - `dataStatus.constraints !== 'available'`：退回现有规则草案并在 `reasons` 中给出“时间约束读取失败，未生成建议”。
  - 快照与规则计算在 `ensureAutoDraft` 的锁外完成；锁内只比较输入（任务、free/hard blocks、**以及 `workspaceHistoryRevision` 与建议集合**）并写入。
  - 草案“仅变得不是最优”（学情修订号变了但已有草案仍可执行）时**保持原草案 id**，在 Today 返回 `hasNewerSuggestion: true`；草案已不可执行（任务完成、材料不可用、时段已过）时才重建。已接受计划不被自动重建（现有行为保持）。
  - 建议时段放不下时保留在 `suggested_tasks` 并标 `unplaced` 原因，不伪造时段。
- **验收**：
  - handler：`opening-daily-draft.test.ts` 开关关闭用例原样通过；新增开关开启用例——在 DB 中写入一条合格的独立错误观察后，下一份草案出现该技能的 `weak_skill` 建议并带原因与 `adaptive-1`；只写一条未核对作答不产生 `weak_skill`；未接受时 `opening_tasks` 无新增行。
  - integration / handler：`tests/integration/opening-adaptive-loop.test.ts`、`tests/integration/handler/opening-prb-auto-draft-recompute.test.ts` 补“同日完成一项建议后刷新，不再出现同一建议”“剩余时间不足 25 分钟时给出短活动或说明无可行项”。
  - `npm run typecheck -w @aistudy/database -w @aistudy/web`。

### L3a｜接受选中建议的原子事务（Claude）

- **目标**：`POST /api/opening/plans/[id]/accept` 携带 `acceptSuggestedKeys` 时，在一个事务里创建选中的建议任务并接受计划。
- **允许修改**：`opening-plans.ts` 的 `acceptPlan`、plan-service、accept route、client、契约（`acceptPlanInputSchema` 已有可选 `acceptSuggestedKeys`）。
- **事务内顺序**：确保并锁定 plan-state 行（不存在时先 `INSERT … ON CONFLICT DO NOTHING` 再 `FOR UPDATE`，不能依赖对空结果的 `FOR UPDATE`）→ 读服务器存储的草案 → 规范化选中集合（去重、排序；未知 key 返回 `VALIDATION`）→ 幂等检查（**payloadHash 纳入规范化后的选中集合**；同 clientKey 不同集合返回 `CONFLICT`）→ 重验：baseVersion、草案仍为 draft、引用任务仍 pending、建议的课程未归档且材料可准入、时段未过期 → 以 `planner:<日期>:<身份>` 为 clientKey 幂等创建任务（正文来自草案）→ 写 plan state 与 acceptance。任一步失败整体回滚，错误码区分 `STALE_VERSION / TASK_CHANGED / SOURCE_UNAVAILABLE / SLOT_EXPIRED`。
- **省略 `acceptSuggestedKeys`**：按 L0 契约等于“全部建议”；空数组等于只接受已有任务部分。
- **验收（integration + handler）**：同请求重放不增任务；同 clientKey 不同集合冲突；未选中不创建；`unplaced` 建议不创建；两个并发首次接受只成功一个；确认前任务已完成不被复活；材料撤销/课程归档/版本变化/时段过期各有用例；任何失败后 `opening_tasks` 与 plan state 均无半写入。`npm run test:handler -- opening-plans`、`npx vitest run --project integration tests/integration/opening-adaptive-loop.test.ts`。
- **回滚**：关开关后接受入口退回旧语义；已创建任务保留。

### TT｜学情进入主讲（Claude）

- **目标**：同一材料、不同学情的学生得到不同的讲解重点和第一道练习。
- **新增纯函数**：`packages/domain/src/opening/adaptive/next-learning-step.ts`：输入某技能的快照条目，输出 `{ activityKind: 'diagnose' | 'targeted_explain' | 'reduced_help_practice' | 'transfer_check' | 'full_explain', focus: string | null, reasonCode }`。
  - 无观察或只有未核对作答 → `diagnose`（一道有区分度的短题）
  - 有独立错误且有错因文本 → `targeted_explain`，`focus` = 错因
  - 最近多为 `hinted/revealed` → `reduced_help_practice`
  - 已 `observed_independent` → `transfer_check`
  - 学生在本次活动明确要求完整讲解 → `full_explain`（记为辅助，不惩罚）
- **接线**：创建教学活动时由服务器从 L2a 快照取该技能条目，构造 `learnerFocus { skillLabel, activityKind, focus, recentAssistance, presentationPreference }`，存入活动并传给 `compile-teaching-unit-wiring.ts` 的编译输入；编译提示只拿这五项和少量例证，不发全部学情。
- **要求**：开始作答后内容版本固定，新证据不改写进行中的题目；模型不可用时现有降级路径不变；`learnerFocus` 缺失时行为与现在完全一致。
- **验收**：domain 单测覆盖五种分支；worker 单测用假模型断言三种学情（未知 / 行列配对错 / 已独立）产生不同的编译输入；`npx vitest run --project unit packages/domain/src/opening/adaptive apps/worker/src/runtime`；`npm run typecheck -w @aistudy/domain -w @aistudy/worker -w @aistudy/web`。真实模型生成质量由用户自用抽检。

### L4｜Today 副驾驶（Grok，按原 L4 卡并作以下修订）

原卡见 `2026-10-15-adaptive-learning-loop-v2.md` 的“任务卡 L4”，修订：
- 默认只显示“下一项 + 一句原因”，原因与依据（观察时间、辅助情况、策略版本）放在展开区；不在首屏展示权限表。
- 每条建议提供：勾选、“不适合我”（可选原因：没时间 / 太难 / 已经会了 / 不相关，可不选）。本批次只记录原因并从当日草案移除，不改变能力状态；原因的规则化使用放 L5。
- `hasNewerSuggestion` 为真时显示“有新建议”提示，用户点击后才刷新草案，界面不自动跳变。
- 教练摘要条、撤销按钮在 L3b 前隐藏。
- 交付时附：页面入口、数据前提、操作步骤、预期结果；标“待用户浏览器验收”。

### L6｜课程目标编辑（Grok，按原 L6 卡）

补充一条：目标表单把“每周投入分钟”与“阶段成果（文字，可选）”分开展示；成果字段本批次只存储和显示，不参与规则。

## 6. 批次 B / C 概要（批次 A 合入并自用一周后再细化成卡）

| 卡 | 内容 | 关键不变量 |
|---|---|---|
| L5 | 完成/跳过/推迟/“不适合我”回写；`replan-trigger` 只在任务明显超时、可用时间变化、材料撤销或用户主动请求时提出局部重排 | 跳过不降能力；已开始/已确认块不移动；刷新失败不丢学习事实；旧响应不覆盖新计划 |
| L8 | 闭环指标只读接口（原卡）+ 分三组报告：运行可靠性、学习结果（独立检验、提示依赖变化、延迟表现）、负担与控制（计划/实际用时偏差、拒绝原因、改动次数） | 不做混合总分；接受率不当作教学效果 |
| E1 | 一个可客观校验的题型（矩阵维数判断或矩阵运算）走现有 evaluator → observation 通道 | 有拒判；错误参考可争议；评价器与基准不互相泄漏答案 |
| L3b | 教练自动确认（不在 GET 内）+ 条件撤销 | 迁移为 `opening_tasks` 增加关闭来源（学生/系统），**系统撤销关闭的任务不计入 `consecutiveSkippedDays`，但仍计入同日去重**；已开始任务或学生后续编辑不回滚；不删学习事实 |
| L7a | 对话一轮结构化意图抽取（目标、今日时间、先学什么）→ 产出候选 → 同一草案与 L3a 接受通道 | 含糊日期必须确认；模型臆造的 courseId/授权被拒；预算耗尽不重复执行 |
| I2 | 观察/作答增加可空 `skill_ref`（指向课程知识节点）；服务器定义 `firstAttempt`（同题同版本同学生的首个持久化原始作答，含错误与未核对）；BKT 影子预测只写诊断表 | 一个作答多技能共享 attempt 身份，验证集按 attempt/题目划分；影子模型不控制正式计划 |

L7 的多步工具循环（外部 T10b）、外部日历写入、跨用户教学：本计划不排期。

## 7. 批次 A 验收矩阵

| 场景 | 必须成立 | 验证层（卡） |
|---|---|---|
| 学生只说“不会”、未作答 | 不产生作答事实，不出现 `weak_skill`，可出现 `diagnose` 讲解 | handler（L2b、TT） |
| 一条独立核对错误 | 次日草案出现对应 `weak_skill`；开始此项时主讲 `activityKind=targeted_explain` | integration（L2b）+ worker 单测（TT） |
| 提示后答对 | 不升级为独立掌握；下一步为 `reduced_help_practice` | integration（L2a）、domain（TT） |
| 超过 20 条证据 | 快照状态按全量计算 | integration（L2a） |
| 观察被修订 | 只按有效 head 计算 | integration（L2a） |
| 同日已完成/跳过建议后刷新 | 不再出现同一建议 | domain（A0）+ integration（L2b） |
| 技能名只差空格/大小写 | 默认复用已有技能名，建议身份不分裂 | 单测（A2） |
| 补测与低优先任务并存 | 交替不把低优先项提到补测前 | domain（A1） |
| 未接受草案 | 不创建任务 | handler（L2b） |
| 重复确认 / 不同选择同 key / 并发首次确认 | 不重复建任务 / 冲突 / 只成功一次 | integration（L3a） |
| 草案生成后材料撤销、任务完成、版本变化、时段过期 | 接受时被识别，整体回滚，错误可读 | integration（L3a） |
| 约束读取失败 | 不当作全天空闲，退回规则草案并说明 | handler（L2b） |
| 开关关闭 | 现有草案/计划/Today 测试原样通过 | handler（L2b、L3a） |
| 模型不可用 | 学习事实与规则草案不受影响 | 现有降级测试（TT 回归） |
| 整条路径 | 作答 → 草案变化 → 接受 → 开始此项 → 讲解重点不同 | **待用户浏览器验收** |

## 8. 发布与回滚

- 批次 A 无数据库迁移（A2 明确不加列）。回滚 = 关闭 `OPENING_ADAPTIVE_PLANNING`；已创建任务与学习事实保留。
- 发布顺序：C0 让 CI 恢复全绿 → 批次 A 各 PR 合入主干 → Hermes 先以开关 0 部署（行为不变）→ 用户在 Hermes 上开关 1 自用并验收 → 记录到 STATUS“使用反馈”。
- Hermes 当前部署版本、0061–0064 迁移是否已应用，以现场核对为准（STATUS 记录的 `8b500e6` 可能已过时）。
- 批次 C 的 L3b、I2 含迁移：届时按主干实际序号分配，迁移文件末尾写回滚语句，并跑备份恢复相关集成测试。

## 9. 需要用户决定

1. 是否同意按 A0 处理 PR #46（删其架构文档、保留代码、转 ready 后合并）。
2. C0 若定位到需要改 CI 环境或 secrets，需用户操作。
3. 批次 A 合入后何时在 Hermes 打开 `OPENING_ADAPTIVE_PLANNING=1`。
