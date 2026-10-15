# 自适应副驾驶闭环：最终执行计划

**日期：** 2026-10-15
**基线：** `feat/opening-release` @ `e69a406`（含 #47；两份外部建议基于更早的 `544304e`）
**取代：** 外部《优化实施计划 v2》的 T00–T11 编号，以及 PR #46 中的 `docs/plans/2026-10-15-human-ai-adaptive-architecture.md`。切片名沿用 [`2026-10-15-adaptive-learning-loop-v2.md`](2026-10-15-adaptive-learning-loop-v2.md) 的 L0–L8；该文的接口、档位规则和 L4/L6/L8 原卡仍然有效，冲突处以本文为准。
**状态：** 计划。本文不代表任何切片已实现。

## 0. 目标

**一次有依据的学习表现，能改变下一份每日草案和下一次讲解；学生能看懂原因，并能接受、修改或拒绝。**

批次 A 完成后，这条路径在真实数据库上成立：作答 → 核对 → 观察入账 → 草案出现对应活动及原因 → 学生勾选接受 → 恰好创建一次任务 → 开始此项时主讲知道要针对什么困难。

## 1. 分工原则

按 [`agent-workflow.md`](../operations/agent-workflow.md) 的判断标准，**能交给 Grok 的都交给 Grok**，Claude 只保留下列三类，以及最后的收尾：

- 动 `packages/contracts` 公共导出、migration、事务/锁/幂等、权限的；
- 需要在 web / worker / database 多个包之间权衡接线的；
- 失败一次代价大（数据重复、半写入、越权、CI 门禁）的。

为了让 Grok 尽早并行，难卡里能剥出来的**纯函数、UI、测试**都拆成独立的 Grok 卡；Claude 先落一个很小的接口切片（K0），把 Grok 需要的类型和契约定死。

| 负责 | 卡 |
|---|---|
| **Grok（9 张）** | G1 #46 收尾准备、G2 交替不跨层、G3 技能名默认值、G4 课程目标编辑、G5 快照组装纯函数、G6 下一步学习活动纯函数、G7 Today 副驾驶界面、G8 接受失败与原因展示文案、G9 草案回归测试补齐 |
| **Claude（6 张）** | K0 接口切片、C0 主干浏览器测试失败、C1 快照读取服务、C2 自适应草案接线、C3 接受选中建议的事务、C4 学情进入主讲的接线 |
| **Claude 收尾（Z）** | 审查并合并所有 Grok PR、端到端 handler 测试、CI 全绿、STATUS 与发布清单、交付用户浏览器验收脚本 |
| pi | 每张 Grok 卡合并前用不同模型做一次只读审查（改动小的可跳过） |
| 用户 | 合并 PR、Hermes 部署与开关、浏览器验收 |

## 2. 已核实的基线

外部两份分析的方向成立。以下按源码与 CI 逐项核对，含两处更正和两处新发现：

| 事项 | 结论 | 依据 |
|---|---|---|
| 实际每日草案不走自适应规则 | 属实。`proposeAdaptiveTasks`、`rankForPlan` 在 `packages/domain` 之外没有生产调用方 | `planning/plan-service.ts:200-213` |
| 接受事务不含选中建议 | 属实。payloadHash 只含 `draftId + expectedBaseVersion` | `repositories/opening-plans.ts:347-353` |
| HTTP 学情摘要裁剪为 20 条 | 属实，仅用于展示 | `learning/summary-response.ts:5` |
| 技能名默认取活动意图 | 属实；数据库只有 `skill_label TEXT`，没有稳定技能 id | `teaching/inline-attempt.tsx:34`，迁移 `0019` |
| 主讲输入没有学情 | 属实，只传材料、`intentSummary`、`intentKind` | `worker/src/runtime/compile-teaching-unit-wiring.ts:53,107` |
| 课程交替跨越优先层 | 属实，可把低优先项提到补测之前 | `adaptive/rank-for-plan.ts:46-66` |
| **新发现①** 技能名漂移会破坏排程去重 | 建议身份 = `kind + courseId + hash(skillLabel)`，任务 clientKey 为 `planner:<日期>:<身份>`，`plannerHistory` 由此重建。技能名一变，“同日不重复”“连续跳过减负”都失效 | `adaptive/types.ts:58-71` |
| **新发现②** 独立答错不会触发薄弱点建议 | `summarizeObservations` 只在有到期补测时给 `needs_review`，独立核对错误只得到 `needs_check`；而 `weak_skill` 只认 `needs_review` 或近 3 次多数提示。快照组装时必须补上“最近有效观察 `verifiedCorrect = no` → 计划用 `needs_review`”的映射（G5） | `learning-summary.ts:68-75`，`propose-tasks.ts:136` |
| 估计器 `firstAttempt` 恒为 null | 属实，但估计器没有生产调用方；接 BKT 前再补 | `estimators/skill-evidence.ts:9` |
| 已有技能名归一化与节点匹配工具 | `normalizeSkillLabelKey`、`findSkillLabelReuseHint`、`nodeIdForSkillLabel` 可直接复用 | `learning/skill-label-options.ts`、`learning/knowledge-node-lookup.ts` |
| **更正①** PR #46 的 CI | 外部报告的“workflow 布局与 Jobs API 不一致”不成立：CI 只有一个 job。#46 的 Lint、Typecheck、单元、集成、handler 全部通过，只有 `Browser tests` 失败、`Build` 被跳过 | Actions run 38731475149 |
| **更正②** 浏览器步骤失败的归属 | 基线问题：主干 `7fb4f85`、`544304e`、`c96211f`、`e69a406` 四次 push 都在 `Browser tests` 失败 | Actions runs 179/180/183/184 |

PR #46 的代码改动（`propose-tasks.ts` 约 15 行 + vitest 测试）已复核，逻辑正确。

## 3. 对外部建议的取舍

**采纳：** 不重写、不建多 Agent 平台，规则引擎为主、LLM 只做意图理解与局部讲解；学情同时驱动“排什么”和“讲什么”；内部用完整证据；`verifiedCorrect` 三值不合并；接受时重验、选中集合进幂等身份、原子提交；GET 不承担新的执行权；系统撤销不计入学生跳过；副驾驶先上、教练单独验收、BKT 先影子运行。

**缩小或推迟**（当前是单人自用阶段，按 AGENTS.md“最小必要实现”）：

| 外部建议 | 本计划 | 理由 |
|---|---|---|
| 稳定技能身份：alias 映射、双写、迁移 | 批次 A 只修默认值来源和复用提示（G3，不加迁移）；`skill_ref` 列放批次 C | 碎片化的主因是默认值取活动标题；加列要等估计器上线才有收益 |
| 快照带 privacyEpoch、计划版本等完整 provenance | 只带 `plannerInputRevision`（快照来源的哈希）、`strategyVersion` 和各数据源 `dataStatus` | 授权与版本在接受事务里重读重验，快照版本只用于追溯 |
| `TeachingTarget` 九个字段 | 批次 A 只传技能名、活动类型、原因码、答错的那条观察、近期辅助、策略版本 | 先证明“不同证据 → 不同讲解重点” |
| 窄题型自动判分进第一批 | 放批次 B | 参考自核已能产生有效负证据 |
| 对话意图抽取前移 | 放批次 C | 先跑通 Today 这条确定性入口；对话复用同一接受通道，晚接不返工 |
| T00 核对“工作流不一致” | 改为 C0：定位主干浏览器测试失败 | 不一致不存在 |
| 课程目标加“阶段成果”字段 | 批次 B | 需要改 contracts，批次 A 不依赖它 |

## 4. 设计约束（所有卡共用）

1. **事实与判断分离**：作答、核对、辅助暴露只能经现有观察写入路径产生；掌握状态是可重算投影。LLM 输出和学生自述“我会了”都不生成作答事实。
2. **负证据保留**：`verifiedCorrect` 的 `no` 与 `unknown` 不合并，也不只筛 `yes`。
3. **完整证据**：快照复用 `read-service.ts` 的完整 `CourseEvidence` + `summarizeObservations`，不用 HTTP 摘要。
4. **读取失败 ≠ 空**：每个数据源标 `available | not_configured | unavailable`。时间约束不可用时不出自适应建议、退回现有规则草案并说明；单门课失败只跳过该课。
5. **草案无副作用**：接受前不创建任务；建议正文只来自服务器保存的 `suggested_tasks`。
6. **GET 只读兼容**：Today GET 维持现有“确保未确认草案”，不加模型调用、自动接受或外部写入。
7. **锁与事务**：持锁事务内不调模型、不做大批量查询；规则计算在锁外，提交只做重验与写入；锁顺序与 `opening-learning-facts.ts` 一致。
8. **开关**：新行为只在 `OPENING_ADAPTIVE_PLANNING=1` 时生效；关闭时现有 `opening-daily-draft`、`opening-plans`、`opening-today-read` 测试不改且通过。
9. **不新增**：通用 Agent 框架、事件总线、快照哈希、gate/baseline/evidence 文件、`setMastery` 类接口。

## 5. 执行顺序

同时最多 3 个活跃 worktree，Grok 按波次领卡。Claude 的卡在云端会话中执行。

```text
第 1 波（立即）  Grok: G1  G2  G3              Claude: K0 → C0（并行）
第 2 波（K0 后） Grok: G5  G6  G4              Claude: C1（接 G5）→ C2
第 3 波          Grok: G7  G8  G9              Claude: C3 → C4（接 G6）
收尾             Claude: Z
插空（不占波次） Grok: G10（R9a）  G11（#50 后）  Claude: C0 修复 PR → R9b（G10 合入后）
```

依赖：G5、G6、G7、G8 需要 K0 已合入（类型与契约定死）；G9 需要 C2；G7 可以先用 K0 的契约做界面，C3 合入后联调。C1 若先于 G5 完成，Claude 先用 G5 卡里的函数签名写服务，G5 合入后替换。G10、G11 在某一波有空位时领，不得让活跃 worktree 超过 3 个。

**进度（2026-10-15 晚）**：G2/G3 → #49、教学三项 → #50，均已审查通过待 squash；K0 → #52 待合；G1 → #46 仍 hold；C0 已定位（见 C0 卡），修复 PR 在 #52 合入后开。评审遗留 R10 的技能名部分已由 G3 解决，`firstAttempt` 留到 I2（批次 C）；R9 拆为 G10 + R9b。#51（SenseWeave 试点，draft）不在本计划内，由用户决定。

**批次 A 完成**：第 9 节验收矩阵中可自动验证的项全部通过、CI 全绿、用户浏览器验收通过。之后才在 Hermes 上把 `OPENING_ADAPTIVE_PLANNING` 设为 1。

## 6. Grok 任务卡（可直接粘贴）

所有 Grok 卡共用以下尾注，粘贴时附在每张卡末尾：

```text
仓库：E:/Project/study-assistant-opening，基于最新 feat/opening-release 新建分支，在独立 worktree 里做。
不许动：packages/contracts 公共导出、migration、package.json/lockfile、CI（需要时停下来报告）。
先读根 AGENTS.md 和目标包的 AGENTS.md。不要做 commit/push 之外的 Git 历史操作，不跑浏览器测试，不调用付费模型 API。
返回：改了哪些文件、实际运行的命令和结果、没解决的问题。卡片规则和代码现状对不上时，停下来报告，不要自行扩大范围。
```

### G1｜PR #46 收尾准备（第 1 波）

```text
目标：PR #46 只保留规则修复和测试，可以转为 ready 等用户合并。
分支：在已有分支 fix/adaptive-learner-feedback-20261015 上操作（例外：不新建分支）。
做法：删除 docs/plans/2026-10-15-human-ai-adaptive-architecture.md（内容已并入 docs/plans/2026-10-15-adaptive-copilot-final-plan.md）；git merge origin/feat/opening-release（用 merge，不 rebase、不 force-push）；保留 packages/domain/src/opening/adaptive/propose-tasks.ts 与 propose-tasks-feedback.test.ts 的改动。
要保留的行为：同日 done/skipped 建议不复活；卡片复习减负不反增时长；手工档零建议。
完成标准：npx vitest run --project unit packages/domain/src/opening/adaptive 通过；npm run typecheck -w @aistudy/domain 通过；推送到原分支。不要自己合并 PR。
```

### G2｜课程交替不跨越优先层（第 1 波）

```text
目标：每日计划里，补测、顺延、自有任务、建议四层的先后顺序不再被“换课程”打乱。
允许修改：packages/domain/src/opening/adaptive/rank-for-plan.ts 及其测试。
做法：interleaveCourses 分别作用于每一层（截止层仍不参与）；每层内保持“同课程最多连续 2 项”；层与层之间不为交替借位。
要保留的行为：每个任务都有结构化原因；同输入结果完全相同；loop-simulation.test.ts 的其余断言不变。
完成标准：新增用例——课程 A 有 3 个到期补测、课程 B 有 1 个自有任务时，B 的任务排在 A 的第 3 个补测之后；npx vitest run --project unit packages/domain/src/opening/adaptive 通过；npm run typecheck -w @aistudy/domain 通过。
```

### G3｜作答技能名默认值不再取活动标题（第 1 波）

```text
目标：同一知识点的作答落到同一个技能名下（排程建议身份也依赖它）。
允许修改：apps/web/src/features/opening/teaching/inline-attempt.tsx、teaching/inline-attempt-submission.ts 及其测试；只读复用 learning/skill-label-options.ts、learning/knowledge-node-lookup.ts。
默认值按优先级取：
  1. 当前讲解块/大纲条目对应的课程知识节点标题（nodeIdForSkillLabel 能对上节点的）；
  2. 本课程已有技能名中与当前大纲条目标题归一化后相同的那个（findSkillLabelReuseHint）；
  3. 当前大纲条目标题；
  4. 都没有：留空，并列出本课程已有技能名供选择。
  任何情况下都不再回退到 intentSummary。学生仍可编辑；输入与已有技能只差空格/全半角/大小写时提示复用，不自动改写。
不许动（额外）：数据库、观察写入路径、历史数据。
要保留的行为：已有草稿（initialDraft.skillLabel）优先；提交后不可改；课程为空时不能提交。
完成标准：单测覆盖四级回退、intentSummary 不再作为默认值、复用提示；npx vitest run --project unit apps/web/src/features/opening/teaching apps/web/src/features/opening/learning/skill-label-options.test.ts 通过；npm run typecheck -w @aistudy/web 通过。
如果当前讲解块拿不到大纲条目或节点信息：停下来报告，由 Claude 在 C4 中补充活动上下文。
```

### G4｜课程目标编辑（第 2 波）

按 `2026-10-15-adaptive-learning-loop-v2.md` 的“任务卡 L6”原样执行，附共用尾注。本批次不加“阶段成果”字段。

### G5｜学生快照组装纯函数（第 2 波，需 K0）

```text
目标：把从数据库读出的原始数据，确定性地组装成排程用的 LearnerSnapshot。数据库读取由 Claude 的 C1 负责，本卡只写纯函数。
新增：packages/domain/src/opening/adaptive/assemble-snapshot.ts 及测试；在 adaptive/index.ts 导出。
签名：assembleLearnerSnapshot(sources: LearnerSnapshotSources) → LearnerSnapshot
输入类型已由 K0 定义在 packages/domain/src/opening/adaptive/snapshot-sources.ts（SnapshotCourseSource、SnapshotObservation、SnapshotSkillSummary、SnapshotKnowledgeNode、SnapshotTaskRow），只读不改。
规则（每门课程得到一个 CourseSignal）：
  1. 技能状态：按 skillLabel 合并 summaries（同一技能可能有多行，每个 requirement 一行）：任一行 needs_review → needs_review；全部 observed_independent → observed_independent；否则 needs_check。然后看该技能 observations 中 attemptedAt 最新的一条：verifiedCorrect 为 "no"（不论是否独立）→ 状态改为 needs_review；为 "unknown" 不改，不当作错。只有 observations、没有 summary 行的技能按 needs_check 处理。
  2. lastObservedAt：合并行中最晚的一个（全为 null 时为 null）。
  3. recentAssistance：该技能 attemptedAt 最新的 3 条 observations 的 assistance，新的在前。输入里已只含有效 head，不要再按修订关系过滤。
  4. nextSkills：knowledgeNodes 中 prerequisiteIds 全部满足（对应节点 title 的技能状态为 observed_independent，或无先修）且自身 title 没有出现在任何 summary/observation 中的节点 title，保持输入顺序；hasUsableMaterials 为 false 时为空。
  5. evidenceStatus 不是 "available" 的课程：skills、nextSkills 都为空，其余字段照常（不报错）。
  6. minutesThisWeek：tasks 中 status="done"、courseId 等于该课程、closedLocalDate 落在 date 所在的本地周（周一开始，用 addLocalDays 做日期加减）内的 minutes 之和。这是投入，不是掌握。
  7. plannerHistory：tasks 中 clientKey 能被 parseSuggestionKey 解析的行，得到 {date, identity, status}；只保留 date 前 7 天至当天（含当天）的；包含当日 done/skipped 与更早仍 pending 的。
  8. date、timeZone、dueCardCount 原样带出。
要保留的行为：纯函数、无 IO、不修改输入、同输入同输出。
完成标准：单测覆盖以上 8 条，另含“同一技能 25 条观察时状态与全量计算一致”“独立答错→needs_review→proposeAdaptiveTasks 产出 weak_skill”“仅未核对作答不产出 weak_skill”；npx vitest run --project unit packages/domain/src/opening/adaptive 通过；npm run typecheck -w @aistudy/domain 通过。
```

### G6｜下一步学习活动纯函数（第 2 波，需 K0）

```text
目标：根据某个技能的学情，决定下一次讲解的活动类型和关注点，供主讲使用。
新增：packages/domain/src/opening/adaptive/next-learning-step.ts 及测试；在 adaptive/index.ts 导出。
签名：nextLearningStep(input: NextLearningStepInput) → NextLearningStep
类型已由 K0 定义在 packages/domain/src/opening/adaptive/snapshot-sources.ts，activityKind 取值来自 contracts 的 learningActivityKindSchema，只读不改。
规则（按顺序判断，input.observations 已按新到旧排好）：
  1. wantsFullExplanation 为真 → full_explain，reasonCode "requested_full"。
  2. 没有 observations → diagnose，"no_evidence"。
  3. 最新一条 verifiedCorrect="no" → targeted_explain，focusObservationId=该条 id，"verified_incorrect"。
  4. 全部 verifiedCorrect="unknown" → diagnose，"unverified_only"。
  5. 最新 3 条中 hinted/revealed 占多数 → reduced_help_practice，"assistance_dependent"。
  6. status="observed_independent" → transfer_check，"independent"。
  7. 其他 → diagnose，"needs_check"。
  除规则 3 外 focusObservationId 都为 null。
要保留的行为：纯函数；不把学生自述当作作答结果；full_explain 不视为失败。
完成标准：每条规则至少一个用例，另含“提示后答对→reduced_help_practice 而非 transfer_check”；npx vitest run --project unit packages/domain/src/opening/adaptive 通过；npm run typecheck -w @aistudy/domain 通过。
```

### G7｜Today 副驾驶界面（第 3 波，需 K0；C3 合入后联调）

按原“任务卡 L4”执行，附共用尾注，并作以下修订：

```text
- 首屏只显示“下一项 + 一句原因”；依据（观察时间、辅助情况、strategyVersion）放展开区。
- 每条建议可勾选；“不适合我”只是取消勾选（原因收集放批次 B）。确认时调用 api.acceptPlan({ ..., acceptSuggestedKeys })（K0 已支持），传勾选建议的 key。
- Today 返回 hasNewerSuggestion=true（K0 已加入 TodayPlanRead）时显示“有新建议”，点击后才刷新草案，界面不自动跳变。
- 建议的 id 出现在草案的 unscheduledTaskIds / unscheduled 里时，显示为“今天放不下”及原因（复用现有 unscheduled 原因文案），不可勾选。不新增字段。
- 教练摘要条、撤销按钮隐藏（批次 C 再做）。
- 重复点击确认只发一次请求；旧响应不覆盖新状态。
- 只用 Tailwind 和 lucide-react；保持可访问性状态。
交付：页面入口、数据前提、操作步骤、预期结果，标“待用户浏览器验收”。
完成标准：npx vitest run --project unit apps/web/src/features/opening/planning 通过（daily-draft-card.tsx、today-dashboard.tsx 都在该目录）；npm run typecheck -w @aistudy/web 通过。
```

### G8｜接受失败与原因展示文案（第 3 波，需 K0）

```text
目标：接受草案失败时，学生看到能理解、能操作的提示，而不是通用错误。
允许修改：apps/web/src/features/opening/planning/ 下的错误映射与展示组件（新增 plan-accept-errors.ts 及测试），以及 daily-draft-card.tsx 中调用处（如 G7 同时在改该文件，等 G7 合入后再改）。
读取方式：接受失败时 api 抛 OpeningApiError，status 409、code "CONFLICT"，原因在 error.reason（K0 已接好；取值见 contracts 的 planAcceptConflictReasonSchema）。
映射：
  stale_version → “计划已在别处更新，已为你刷新”并触发重新读取
  task_changed → “有任务已完成或被修改，请重新确认”
  source_unavailable → “相关材料暂不可用，这项建议已移除”
  slot_expired → “部分时段已过，请重新安排”
  selection_mismatch → “请刷新后重新选择”
  reason 为空或未知 → 保留现有通用错误
要保留的行为：不吞错；失败时不清空用户已勾选的内容。
完成标准：单测覆盖每个 reason 及 reason 为空；npx vitest run --project unit apps/web/src/features/opening/planning 通过；npm run typecheck -w @aistudy/web 通过。
```

### G9｜自适应草案回归测试补齐（第 3 波，需 C2）

```text
目标：给 C2 的自适应草案补齐边界用例（Claude 已写核心用例）。
允许修改：tests/integration/handler/opening-daily-draft.test.ts、tests/integration/handler/opening-prb-auto-draft-recompute.test.ts、tests/integration/opening-adaptive-loop.test.ts（只加用例，不改已有断言）。
补充用例：
  1. 同日完成一项建议后刷新，不再出现同一建议；
  2. 剩余时间不足 25 分钟时，建议进入 unscheduledTaskIds 或给出短卡片复习，不伪造时段；
  3. 手工档零建议；
  4. 开关关闭时同一组数据的草案与改动前一致；
  5. 技能名只差空格/大小写的两条观察，只产生一条建议。
完成标准：npm run test:handler -- opening-daily-draft opening-prb-auto-draft-recompute 与 npx vitest run --project integration tests/integration/opening-adaptive-loop.test.ts 通过。如发现 C2 的真实缺陷，写出复现用例并报告，不改实现代码。
```

### G10｜转写时间戳容差（插空，评审 R9 前半）

```text
目标：模型给的段落结束时间略超过切片时长时，不再让整段转写失败。
允许修改：apps/worker/src/parsers/model-transcribe-adapter.ts 的 parseSegments，及其同目录测试。
做法：endMs 超出 durationMs 不超过 2000 时截断为 durationMs；超出更多、startMs >= durationMs、非整数、倒序或重叠仍按现在报 MediaValidationError。容差写成具名常量。截断后若 endMs <= startMs 视为无效。
不要动：分段循环、预算结算、operationId、重试逻辑（R9 后半由 Claude 做）。
完成标准：单测覆盖“超 1 ms / 恰好 2000 ms 截断”“超 2001 ms 报错”“截断后为空段报错”；npx vitest run --project unit apps/worker/src/parsers 通过；npm run typecheck -w @aistudy/worker 通过。
```

### G11｜教学块渲染去重（插空，#50 合入后）

```text
目标：teaching-workspace.tsx 里“已学/跳过折叠区”和“当前+后续主列表”两处几乎相同的块渲染合成一个组件，行为不变。
允许修改：apps/web/src/features/opening/teaching/teaching-workspace.tsx，可在同目录新增一个组件文件。
要保留：当前块的高亮 class、折叠区的 data-teaching-past-collapsed、BlockRenderer 与 BlockCommands 的全部 props、键盘与无障碍属性。
不要改：teaching-commands.ts、block-commands.tsx、任何文案。不新增测试，复用现有测试证明行为不变。
完成标准：npx vitest run --project unit apps/web/src/features/opening/teaching 通过；npm run typecheck -w @aistudy/web 通过；改动文件 eslint 通过。
```

## 7. Claude 任务卡

### K0｜接口切片（已完成，见本分支提交）

只定类型与契约，不接线，让 G5–G8 能并行开工。实际落地：

- domain `adaptive/snapshot-sources.ts`：`LearnerSnapshotSources` 及其组成类型（G5 输入）、`NextLearningStepInput` / `NextLearningStep` / `NextStepReasonCode`（G6），从 `@aistudy/domain` 导出。
- contracts：`planAcceptConflictReasonSchema`（`stale_version / task_changed / source_unavailable / slot_expired / selection_mismatch`）；`learningActivityKindSchema`、`teachingLearnerFocusSchema { skillLabel, activityKind, reasonCode, focusObservationId, recentAssistance, strategyVersion }`。
- 错误通道：`OpeningPlanError` 可带 `reason`，`mapDomainError` 以 409 + `reason` 返回；客户端 `OpeningApiError.reason`。
- Today：服务端 `TodayPlanResult` 与客户端 `TodayPlanRead` 可选 `hasNewerSuggestion`；客户端 `acceptPlan` 接受完整 `AcceptPlanInput`（含 `acceptSuggestedKeys`）。
- 与原设想的差异：放不下的建议**不新增 `unplaced` 字段**，沿用草案已有的 `unscheduledTaskIds` / `unscheduled`（建议有预分配 id，经 `planDay` 自然落入）；教学活动**不加列**，`learnerFocus` 存在已有的 `goal_json`；不加 `presentationPreference`（目前没有数据来源）；观察没有“错因文本”字段，所以聚焦对象是那条答错的观察 id，C4 再取题目与原答案给编译器。
- 验收：相关单测 87 项通过；contracts、domain、database、web、worker 类型检查通过；改动文件 eslint 通过。

### C0｜主干浏览器测试失败定位（第 1 波，并行）

- 取 run 38752215093（`e69a406`）的 Playwright 报告与日志，找到第一个失败用例；对照最后一次全绿 run 的提交范围定位引入点。
- AGENTS.md 规定浏览器验收归用户，但 CI 里既有浏览器测试的失败需要定位；本卡只读日志和产物，不在本地跑 Playwright（除非用户授权）。
- 不跳过、不禁用、不放宽用例，不加 `continue-on-error`。
- 完成：主干 `Browser tests` 与 `Build` 变绿；或在 STATUS 写明根因及需要用户做什么。
- **已定位（2026-10-15）**：不是用例断言失败，是加载失败。`tests/e2e/opening-experience.spec.ts:3` 与 `tests/e2e/opening-unknown-recovery.spec.ts:4` 静态 import `scripts/db-reset-e2e.ts`；根 `package.json` 无 `"type": "module"`，Playwright 按 CommonJS 编译，而该脚本及其引用的 `packages/database/src/migrate.ts` 使用 `import.meta`，Node 22 下报 `exports is not defined in ES module scope`。最后全绿 `649353f`（#42），引入于 `64e889f`、`8eb2eed`。
- **修复**：两个 spec 改为在 `beforeAll` 里以子进程 `npx tsx scripts/db-reset-e2e.ts` 重置（与 `playwright.config.ts`、`scripts/opening-e2e/server.mjs` 同一方式），只改这两个文件。修复后这两个 spec 第一次真正在 CI 运行，若暴露真实断言失败，按产品缺陷另行处理。

### R9b｜转写部分完成后的重试（G10 合入后）

- 前几段已结算、后面失败时，重试在第一段命中“已结算但结果未保存”。改为每段结果按 `transcribe:<jobId>:<段号>` 先持久化，重试只补缺失段；已结算段不重复计费。
- 涉及预算账本幂等与任务重试，测试：第 3 段失败后重试只调用模型补第 3 段起；账本无重复结算；全部成功后结果与一次成功一致。

### C1｜快照读取服务（第 2 波）

- 新增 `apps/web/src/features/opening/planning/learner-snapshot-service.ts`：认证 scope → 按课程批量读取 → 构造 `LearnerSnapshotSources` → 调 `assembleLearnerSnapshot`（G5）。返回 `{ snapshot, dataStatus, plannerInputRevision }`。
- 证据来自 `read-service.ts` 内部完整计算入口；只取有效 head；读取在事务外；记录查询次数与耗时，不加缓存。
- 集成测试 `tests/integration/opening-learner-snapshot.test.ts`：25 条观察按全量计算；独立答错 → `needs_review`；`unknown` 不当错；提示后答对不升级；观察被修订只按新 head；当日 done/skipped 进入 `plannerHistory`；单门课证据读取失败时其他课正常且 `dataStatus.evidence = 'unavailable'`；跨工作区被拒。

### C2｜自适应草案接线（第 2 波）

- `ensureDailyDraft` 在开关开启且非手工档时走 `C1 → proposeAdaptiveTasks → rankForPlan → planDay`，持久化 `suggested_tasks`、`reasons`、`strategy_version`。
- 约束不可用时退回现有规则草案并写原因；快照与规则计算在 `ensureAutoDraft` 锁外；锁内比较输入（任务、free/hard blocks、`plannerInputRevision`、建议集合）。
- 草案仅“不是最优”时保持草案 id 并返回 `hasNewerSuggestion`；不可执行时才重建；已接受计划不自动重建。放不下的建议进入草案已有的 `unscheduledTaskIds` / `unscheduled`。
- 核心测试：写入一条合格的独立错误观察后草案出现 `weak_skill` 及原因；只有未核对作答不出现；未接受不建任务；开关关闭时既有测试原样通过。其余边界交 G9。

### C3｜接受选中建议的事务（第 3 波）

- 事务内：确保并锁定 plan-state 行（不存在时先 `INSERT … ON CONFLICT DO NOTHING` 再 `FOR UPDATE`）→ 读服务器存储的草案 → 规范化选中集合（未知 key 报 `VALIDATION`）→ 幂等检查（payloadHash 纳入规范化后的选中集合，同 key 不同集合报 `CONFLICT`）→ 重验版本、任务状态、课程未归档、材料可准入、时段未过期 → 以 `planner:<日期>:<身份>` 幂等创建任务（正文来自草案）→ 写 plan state 与 acceptance。任一步失败整体回滚，冲突用 `new OpeningPlanError("CONFLICT", message, reason)` 抛出（reason 取 `planAcceptConflictReasonSchema`）。
- 省略 `acceptSuggestedKeys` 等于全部建议，空数组等于不接受建议。
- 测试：重放不增任务；同 key 不同集合冲突；未选中与放不下（在 `unscheduledTaskIds` 中）的建议不创建；并发首次接受只成功一次；确认前任务已完成不复活；材料撤销、课程归档、版本变化、时段过期各一例；失败后无半写入。

### C4｜学情进入主讲的接线（第 3 波）

- 创建教学活动时，服务器从 C1 的快照与来源取该技能条目，经 `nextLearningStep`（G6）得到 `learnerFocus`，写入 `goalJson.learnerFocus`（覆盖客户端传入的同名键）；`compile-teaching-unit-wiring.ts` 把这些字段，以及 `focusObservationId` 对应题目的题干与原答案，传给编译输入，不发全部学情。
- 开始作答后内容版本固定；模型不可用时降级路径不变；`learnerFocus` 缺失时行为与现在一致。
- 如 G3 报告讲解块拿不到大纲/节点信息，在此补上活动上下文。
- 测试：worker 单测用假模型断言三种学情（未知 / 独立答错 / 已独立）产生不同编译输入。真实生成质量由用户自用抽检。

### Z｜收尾

1. 逐个审查 Grok PR 的 diff 和 CI，只修确定的缺陷，风格不返工；按依赖顺序合并到 `feat/opening-release`。
2. 新增一个端到端 handler 测试：写观察 → 取 Today 草案 → 勾选接受 → 开始此项 → 断言活动的 `learnerFocus`。
3. 确认 CI 全绿（含 C0 的结果）；跑受影响包的类型检查。
4. 更新 STATUS；写 Hermes 发布清单（先以开关 0 部署，再由用户开 1）和用户浏览器验收步骤。

## 8. 批次 B / C 分工（批次 A 合入并自用一周后再细化成卡）

| 切片 | Grok | Claude |
|---|---|---|
| L5 反馈与低打扰重排 | 完成/跳过/推迟/“不适合我”原因的 UI 与客户端 | 原因持久化、`replan-trigger` 局部重排、旧响应不覆盖新计划 |
| L8 闭环指标 | 只读接口与诊断页（原卡），按运行可靠性 / 学习结果 / 负担与控制三组展示 | 审查口径，不做混合总分 |
| E1 窄题型自动评价 | 矩阵维数/运算的校验纯函数与测试 | 接入 evaluator → observation 通道、拒判与争议 |
| 课程目标“阶段成果” | 表单与展示 | contracts 字段 |
| L3b 教练自动确认与条件撤销 | 教练摘要条、撤销按钮 | 迁移增加任务关闭来源（学生/系统），系统撤销不计入连续跳过但仍计入同日去重；自动接受不在 GET 内；条件撤销 |
| L7a 对话进入同一草案管道 | 聊天内草案卡 | 结构化意图抽取、预算、拒绝臆造的 courseId 与授权 |
| I2 技能身份与首次作答、BKT 影子 | 离线比较脚本（按 attempt/题目划分验证集，报告校准与误报掌握） | 可空 `skill_ref` 迁移、服务器定义的 `firstAttempt`、影子预测只写诊断表 |

L7 多步工具循环、外部日历写入、跨用户教学：不排期。

## 9. 批次 A 验收矩阵

| 场景 | 必须成立 | 卡 |
|---|---|---|
| 学生只说“不会”、未作答 | 不产生作答事实，不出 `weak_skill`；讲解为 `diagnose` | C2、G6 |
| 一条独立核对错误 | 草案出现 `weak_skill`；开始此项时 `activityKind=targeted_explain` | G5、C2、C4 |
| 提示后答对 | 不升级为独立掌握；下一步 `reduced_help_practice` | G5、G6 |
| 超过 20 条证据 | 按全量计算 | G5、C1 |
| 观察被修订 | 只按有效 head 计算 | G5、C1 |
| 同日已完成/跳过建议后刷新 | 不再出现同一建议 | G1、G9 |
| 技能名只差空格/大小写 | 默认复用已有技能名，只产生一条建议 | G3、G9 |
| 补测与低优先任务并存 | 交替不把低优先项提到补测前 | G2 |
| 未接受草案 | 不创建任务 | C2 |
| 重复确认 / 同 key 不同选择 / 并发首次确认 | 不重复 / 冲突 / 只成功一次 | C3 |
| 材料撤销、任务完成、版本变化、时段过期 | 接受时识别，整体回滚，提示可读 | C3、G8 |
| 约束读取失败 | 不当作全天空闲，退回规则草案并说明 | C2 |
| 开关关闭 | 现有草案/计划/Today 测试原样通过 | C2、C3、G9 |
| 模型不可用 | 学习事实与规则草案不受影响 | C4 |
| 整条路径 | 作答 → 草案变化 → 接受 → 开始此项 → 讲解重点不同 | Z 的端到端测试 + **用户浏览器验收** |

## 10. 发布与回滚

- 批次 A 无数据库迁移。回滚 = 关闭 `OPENING_ADAPTIVE_PLANNING`；已创建任务与学习事实保留。
- 发布顺序：C0 让 CI 恢复全绿 → 批次 A 按依赖合入 → Hermes 以开关 0 部署（行为不变）→ 用户开 1 自用验收 → 问题记到 STATUS“使用反馈”。
- Hermes 当前部署版本、0061–0064 是否已应用，以现场核对为准（STATUS 记录的 `8b500e6` 可能已过时）。
- 批次 C 的迁移按主干实际序号分配，文件末尾写回滚语句，并跑备份恢复相关集成测试。

## 11. 需要用户决定

1. 同意 G1 的处理方式后，由你把 PR #46 转为 ready 并合并。
2. C0 如果需要改 CI 环境或 secrets，需要你操作。
3. 批次 A 合入后，什么时候在 Hermes 上把 `OPENING_ADAPTIVE_PLANNING` 设为 1。
