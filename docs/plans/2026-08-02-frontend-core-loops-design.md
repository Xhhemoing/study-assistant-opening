# AIstudy 前端核心闭环设计（Plan A）

> 日期：2026-08-02
> 范围：PRD P0 的三入口核心闭环前端（目标学习、自由探索、笔记知识库），不含后端新 API、资源市场、导出、模考。
> 依据：PRD v0.2、ARCHITECTURE.md、UX_AND_AI_POLICY.md、2026-07-21-lifelong-learning-design.md、2026-07-27-three-entry-app-shell-design.md。
> 已批准决策：混合 mock 数据层、核心闭环全功能范围、Approach A 纵向切片交付。

## 一、目标与非目标

### 目标（本次全部做到可用）

1. **目标学习（Learn）：**目标 CRUD（场景预设、日期、科目、每日时长）→ 规则版今日计划 → 练习播放器（作答、提示、用时、信心、错因）→ 精简结果与原因抽屉 → SRS 复习队列。
2. **自由探索（Explore）：**探索线程、mock AI 角色对话、草稿块、选择性沉淀（转笔记走真实 API、转卡片/题目走 mock），保留 provenance。
3. **笔记与知识库（Library）：**块编辑器接入真实 `/api/documents`（替换仅本地草稿）、版本历史、属性/标签、双链与反链、全局搜索与命令面板。
4. **课程（Courses）：**真实课程 API 的列表/创建/详情；文档挂接为课程资产（真实 API）；要求档案与指导模式（mock 持久化）。
5. **设置（我）：**默认入口（真实 preferences API）、指导模式默认值、开发者诊断（只读）。

### 非目标（只做诚实的"规划中"占位）

- 资源市场、导出/备份、模考、PDF/来源锚点、真实 AI Provider、多人协作。
- 不新增后端路由；不引入全局状态库（Zustand/Redux）；不引入第三方 UI 套件。
- 不迁移既有 globals.css；不改既有 shell/auth/onboarding 行为。

## 二、已锁定决策

| 编号 | 决策 | 理由 |
|---|---|---|
| D1 | 混合 mock 数据层 | 用户批准。真实 API 覆盖 auth/documents/courses/preferences；其余域用 mock。 |
| D2 | 核心闭环全功能 | 用户批准。市场/导出/归档/模考为占位。 |
| D3 | 单一 DataProvider 接口 + 纵向切片 | 用户批准（Approach A）。 |
| D4 | 评估/计划/SRS/搜索排序用**真实纯函数**落在 `packages/domain` | 这些正是实施计划 Task 21–25 的内容；mock 只做持久化适配，逻辑不写两次。 |
| D5 | 新增 UI 一律 Tailwind 工具类 | AGENTS.md 强制但仓库缺 Tailwind 配置：本次补齐 Tailwind v4 + `@theme` 令牌，遗留 globals.css 不动。 |
| D6 | BlockNote 为编辑器，持久化走真实 documents API | 依赖已装、本地草稿版已验证；localStorage 仅作离线草稿缓存。 |
| D7 | mock 持久化用 localStorage，按用户命名空间隔离 | 无需后端改动即可完整演示；密钥不落库。 |
| D8 | 未经用户明确要求不提交 git；每个切片结束在对话中汇报进度 | 用户指示。 |

## 三、数据层架构

### 3.1 位置与边界

```text
apps/web/src/lib/data/
  types.ts        StudyDataProvider 接口 + 读取模型
  mock/storage.ts 命名空间 localStorage（aistudy:mock:<userId>:<domain>），带 schemaVersion
  mock/seeds.ts   确定性种子数据（首次写入）
  mock/provider.ts MockStudyDataProvider（50–150ms 模拟延迟）
  react.ts        useGoals/useTodayPlan/usePractice/useReviews/useExplorations 等 hooks（loading/error/data 三态）
```

documents/courses/preferences/auth 继续直连真实 API（现有 fetch 路径），不进 mock。UI 组件只依赖 hooks，不感知数据来源；将来某域换真实 API 时只改 provider/hook 内部。

### 3.2 mock 必须遵守的架构不变量

1. 作答事件 append-only；每次提交带幂等键，重试/双击不产生重复事件。
2. 评估结果由领域纯函数从事件快照派生，携带 `modelVersion`、`strategyVersion`、`evidenceSnapshotId`。
3. 计划输出按任务携带入队原因与策略版本；总时长不超过预算；锁定任务不被移除。
4. SRS 状态每卡一份；复习事件 append-only；归档卡不入队。
5. 种子数据确定性（固定 ID/时间基准），"重置演示数据"可回到初始态。

### 3.3 种子数据（seeds.ts）

- 1 门课程"高等数学（上）"（真实课程 API 若可用则挂接，否则 mock 课程记录）。
- 1 个期末场景目标：14 天后考试、每日 45 分钟。
- 12 个考点（极限、导数、积分等），预置差异化证据：2 个稳固、3 个可用、2 个薄弱、其余未测。
- 20 道练习题：选择/短答/步骤检查点三类，覆盖 recognition/procedure/transfer。
- 8 张复习卡：3 张今日到期。
- 1 条探索线程示例（含 2 条 mock AI 回复与 1 个待沉淀候选）。

## 四、领域纯函数（packages/domain，TDD）

| 模块 | 纯函数 | 规则要点 | 版本常量 |
|---|---|---|---|
| `src/srs/scheduler.ts` | `scheduleReview(state, grade, now)` | SM-2 简化基线：again/hard/good/easy 四档；首次 10 分钟/1 天；间隔 ×ease；lapse 重置；看答案不计高质量回忆 | `SRS_VERSION = "srs-1"` |
| `src/assessment/status.ts` | `deriveStatus(events, pointId, now)` | 输出 stable/usable/weak/untested + ≤3 metrics + reasonCodes + recommendedActions + snapshot/版本号；<2 有效证据=未测；辅助证据降权；区分 recognition/recall/procedure/transfer 切片 | `ASSESSMENT_VERSION = "assess-1"` |
| `src/planning/planner.ts` | `buildTodayPlan(input)` | 预算约束、锁定保留、到期复习优先、薄弱补缺、场景权重表（期末=覆盖优先、高考=跨科轮换、考研=真题/背诵/输出）；多目标冲突给出 2–3 个方案；每任务带 reason | `PLANNER_VERSION = "plan-1"` |
| `src/search/query.ts` | `rankResults(query, docs)` | 分词、标题加权、类型过滤；供 mock 搜索与命令面板 | — |

全部为纯函数：不 import UI/infra；同输入同版本必得同输出（时间由参数注入）。

## 五、契约（packages/contracts，zod）

新增文件并更新 `index.ts` 导出，每个 schema 配负例测试：

- `goals.ts`：`StudyGoal`（scenario=final|gaokao|kaoyan|custom、examDate、subjects、dailyMinutes、archivedAt）、`TimeWindow`。
- `attempts.ts`：`PracticeItem`（kind=multiple_choice|short_answer|checkpoint、stem、options?、answer、syllabusPointId、abilitySlice）、`AttemptEvent`（idempotencyKey、answer、durationMs、hintCount、confidence 1–5、errorCause?、assisted、contentVersion）。
- `assessment.ts`：`StatusResult`（严格对应 UX 政策 §6 机器可读字段）。
- `plan.ts`：`TodayPlan`、`PlannedTask`（kind、estMinutes、reason、locked）、`PlanOption`。
- `srs.ts`：`ReviewCard`、`ReviewState`、`ReviewGrade`。
- `exploration.ts`：`Exploration`、`ChatTurn`、`AIRole`（retriever/explainer/tutor/challenger/editor/examiner/collaborator/silent）、`DraftBlock`、`PromotionRecord`（含 provenance）。
- `diagnostics.ts`：只读诊断载荷（事件、切片、版本、排序理由）。

## 六、设计系统

1. **Tailwind v4 接入：**`apps/web/postcss.config.mjs` 用 `@tailwindcss/postcss`；新建 `apps/web/src/app/tailwind.css`：`@import "tailwindcss"` + `@source` 指向 `packages/ui/src` 与 `apps/web/src`；root layout 在 globals.css 之后引入（后者优先级仅作用于遗留类名，不冲突）。
2. **令牌（@theme，沿用已批准色板）：**`--color-bg:#0b1020`、`--color-surface:#121a2b`、`--color-text:#f5f7ff`、`--color-text-dim:#94a3b8`、`--color-primary:#6ea8fe`、`--color-success:#4ade80`、`--color-warning:#facc15`、`--color-danger:#f87171`；状态色：稳固=success、可用=primary、薄弱=warning、未测=text-dim。间距 4px 基网；标题 24/18、正文 16、辅助 14。
3. **共享原语（packages/ui，Tailwind 类）：**`StatusBadge`（图标+文字，永不只用颜色）、`Card`、`Drawer`（role=dialog、Escape 关闭、aria-modal）、`EmptyState`、`Button`、`Field`、`ProgressBar`（附文字摘要）、`Tabs`、`Skeleton`。既有 app-shell/navigation 组件不动。
4. **文案：**全站 zh-CN；禁用负罪感/虚假紧迫文案；mock AI 回复明确标注"模拟回复"。
5. **图标：**lucide-react。

## 七、路由与页面

全部在 `(workspace)` 组内，每页唯一 h1：

| 路由 | 内容 | 数据来源 |
|---|---|---|
| `/learn` | 今日计划首页：预算进度、任务列表（开始/跳过/置顶）、≤3 风险点状态卡+原因抽屉入口、一行近期趋势、一个主 CTA；空状态→建目标 | mock |
| `/learn/goals`、`/learn/goals/new`、`/learn/goals/[id]` | 目标 CRUD；创建 ≤4 步（场景→日期→科目/考纲→每日时长），全部可跳过 | mock |
| `/learn/courses`、`/learn/courses/new`、`/learn/courses/[id]` | 课程列表/创建/详情：已挂文档、要求档案预设、指导模式 | 真实 API + mock 设置 |
| `/learn/practice/[taskId]` | 练习播放器：题干、作答、提示（计数）、计时、信心 1–5、提交；答错→错因选择（概念不清/审题错误/计算失误/步骤缺失/时间不足/其他）；可看答案但记 assisted；提交幂等、防重 | mock |
| `/learn/practice/[taskId]/result` | 精简结果摘要 + 状态变化 + 下一任务 CTA + "为什么"抽屉 | mock |
| `/learn/review` | SRS 到期队列、翻卡复习（忘记/困难/良好/简单）、完成摘要 | mock |
| `/explore`、`/explore/[id]` | 探索列表+ starters；线程页：角色切换、对话、草稿块、沉淀面板（转笔记=真实 API 写文档并记 provenance；转卡片/题目=mock；可拒绝） | mock + 真实 documents |
| `/library` | 文档列表+搜索框+生命周期/标签过滤（沿用并增强现有页） | 真实 API + mock 属性 |
| `/library/new` | 改为：真实 API 建文档 → 跳编辑器；保留本地草稿作离线缓存 | 真实 API |
| `/library/[id]` | BlockNote 编辑器：加载/保存（PATCH 生成新版本）、保存状态、撤销重做、版本历史抽屉（revisions API 预览/恢复）、属性面板（标签，mock）、反链面板（mock 关系索引） | 真实 API + mock |
| `/search` + `Cmd/Ctrl+K` 面板 | 全局结果页；命令面板：搜索 + 新建笔记/探索/目标，全键盘可达 | mock 索引 |
| `/settings` | 我：默认入口（真实 preferences）、指导模式默认、演示数据重置、开发者诊断（事件流、能力切片、版本号、任务排序理由，只读） | 真实 + mock |
| `/learn/exams`、`/learn/marketplace`、`/settings/export` | "规划中"占位页，说明将到来的能力与当前替代操作 | — |

双链语法：正文内 `[[文档标题]]`；保存时提取建立 mock 关系；反链面板列出引用方；目标被软删显示断链态。

## 八、信息层级合规（UX_AND_AI_POLICY）

- Layer 1 状态卡：1 个状态词 + ≤2 个数据 + 1 个主行动 + 1 个展开入口；无权重/概率/公式。
- 原因抽屉固定结构：**为什么**（≤3 条，各带可执行动作）/ **怎么改善**（带预计分钟）/ **其他操作**（判断不准→记录纠正事件、暂时跳过、调整优先级）。
- 开发者信息只出现在 `/settings` 诊断区。
- AI 不可用不阻塞手动流程；计划可整体关闭；计划外学习不记失败。

## 九、无障碍与响应式

- 每页唯一 h1；抽屉/面板键盘可达（Escape、焦点管理）；练习与复习全流程键盘可完成。
- 状态永不只用颜色（图标+文字）；图表一律文字摘要（本期无图表）。
- 320/768/1440 三档无横向溢出；移动端底栏沿用既有 shell。

## 十、测试策略（TDD）

1. 领域纯函数：vitest 单测先行（srs 间隔序列、assessment 四态与降权、planner 预算/锁定/冲突/确定性、search 排序）。
2. 契约：zod 负例测试。
3. mock provider：fake storage 单测（幂等、append-only、种子确定性、命名空间隔离）。
4. 组件：关键组件测试（StatusBadge 非颜色唯一、ReasonDrawer 结构、PracticePlayer 提交流程）；若仓库缺 `@testing-library/react` 则补 devDependency。
5. 现有测试与 e2e 必须保持绿；本期末视成本加 1 个 `tests/e2e/learn-core-loop.spec.ts`（计划→练习→结果），否则记入后续任务。

## 十一、交付切片与进度汇报

每片结束跑 `npm run lint && npm run typecheck && npm test`（涉及路由/构建变化时加 `npm run build`），然后在对话中汇报：完成内容、门禁结果、下一步。

- **S0 地基：**Tailwind+令牌、契约、mock 存储/种子/provider/hooks、domain 包四模块骨架。
- **S1 Library 闭环：**编辑器接真实 API、版本抽屉、属性/标签、双链反链、搜索+命令面板。
- **S2 Explore 闭环：**线程、mock AI 角色、草稿、沉淀面板。
- **S3 Learn 目标与计划：**目标 CRUD、课程页、planner、`/learn` 首页。
- **S4 练习与评估：**播放器、作答事件、结果页+原因抽屉。
- **S5 复习+设置+收尾：**SRS 复习、设置页+开发者诊断、占位页、无障碍/响应式走查、全量门禁、总结汇报。

## 十二、假设与风险

- UI 文案 zh-CN；仅深色主题；mock 数据按用户隔离并可重置。
- BlockNote 维持 0.52.1；沿用现有样式方案。
- 风险：mock 与将来真实 API 漂移 → 契约+单一 provider 接口缓解。
- 风险：Tailwind 与遗留 CSS 冲突 → 新类只用工具类，shell 页面构建后人工抽查。
- 风险：文件超 200 行 → 播放器、编辑器、抽屉拆子组件。
