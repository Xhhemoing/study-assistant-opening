# 系统架构（现状）

> **更新：** 2026-11-28，基于主干 `03e9b3de`。描述“现在是什么样”；要改成什么样见 [roadmap/ARCHITECTURE_PLAN.md](../roadmap/ARCHITECTURE_PLAN.md)，算法细节见 [roadmap/ALGORITHM_PLAN.md](../roadmap/ALGORITHM_PLAN.md)。技术栈决定见 [ADR-001](../decisions/ADR-001-stack.md)，开源/闭源边界见 [ADR-v3](../decisions/ADR-v3-open-core-and-engine-boundaries.md)。

## 1. 仓库结构

| 位置 | 职责 |
|---|---|
| `apps/web` | Next.js App Router：35 个页面、约 217 个 route handler（主要在 `/opening/*`），另有 `/try`、`/s/[token]`、`/onboarding`、登录注册 |
| `apps/worker` | BullMQ Worker：12 个队列（parse、parse-media、index-source、build-course-knowledge、compile-teaching-unit、tutor、tutor-metadata、grade-observation、recognize-photo-question、extract-study-actions、retest、remind），outbox dispatcher，钉钉/IMAP 连接器，隔离舱守卫 |
| `packages/contracts` | 跨层契约（zod） |
| `packages/domain` | 纯领域逻辑（约 40 个子域：证据、复习调度、规划、诊断、考试预测、元认知、卡带、符号等价等） |
| `packages/database` | Drizzle schema 与仓储；原生 SQL 迁移 `0001`–`0113`（`packages/database/src/migrations`），编号注册、校验和、advisory lock、单一 runner |
| `packages/ai` | 模型网关封装、检索（词法 / 混合 RRF / Sparse PPR）、导师图、教学编译器、批改 |
| `packages/config` | 环境配置、功能开关、模型目录 |
| `packages/ui`、`packages/jingwei`、`packages/senseweave` | 共享 UI、图解 artifact、回答渲染（vendored） |
| `tests/integration`、`tests/e2e` | 集成/handler 测试与远端 CI 浏览器测试 |

依赖方向遵循 ADR-v3 的单向 DAG；`database → ai` 仍有一处兼容依赖待拆。

## 2. 主数据流

```
上传 → opening_sources + outbox
  → parse / parse-media → opening_source_chunks
  → index-source → opening_source_embeddings（pgvector）
  → build-course-knowledge（knowledge.extract；节点身份合并）→ opening_course_knowledge
  → compile-teaching-unit（盲解、校验器、公式检查；混合检索）→ teaching units / activity specs
  → 学习会话（study / span / matrix；tutor 作业：TutorGraph、错因记忆只读、SenseWeave）
  → 作答与帮助：attempts、help_exposures（帮助分级）→ 证据资格投影（仓储层同步）
  → opening_skill_evidence、learner-state、shadow 预测
  → 调度：卡片 FSRS、自动错题卡、retest 作业
  → 规划：day-planner、learning-agenda、long-term-planning、local-replan；adaptive-draft（开关）
  → tasks / plan_drafts / learning_decisions → remind
```

## 3. 关键数据

- 证据：`opening_learning_attempts`、`item_versions`、`history_revisions`、`opening_help_exposures`、`opening_skill_evidence`、`opening_retest_activities`、`opening_learning_decisions`；
- 反馈与体验：`opening_plan_feedback`、`opening_suggestion_feedback`、`opening_learning_experience_events`、`opening_measurement_*`；
- 考试：`opening_exam_*`、`opening_course_reserved_questions`（保密题库）；
- 记忆：`opening_memories`、`v3_bitemporal_misconception_edges`、`v3_learner_context_blocks`；
- 预算：`opening_budget_reservations`、`reconcile_events`、`parent_interaction_budgets`；
- 复习：`card_review_states`；旧域 `learning_events`、`practice_*` 仍存在；
- 身份：`users`（无年龄字段）、`workspaces`（每账号最多一个，唯一索引）、`workspace_preferences`（含 `defaultEntry`）。

## 4. 模型网关与预算

- 唯一网关：`apps/worker/src/runtime/model-gateway.ts`；用途注册在 `MODEL_TASKS`（tutor、knowledge.extract、teaching.compile、media.transcribe、probe 等）；调用兼容 `/chat/completions` 的提供方。
- 路由顺序：手动锁 → 用途主模型 → 模式 → 工作区默认 → 服务器默认；不自动 fallback。
- 预算按工作区预留 / 结算 / unknown，按本地日汇总；日上限来自环境或工作区设置；测试期配额模式为 unlimited。

## 5. 功能开关（默认值）

默认开：`OPENING_TEACHING_LOOP`、`OPENING_TEACHING_WORKSPACE`、编译器、`OPENING_CHAT_PROSE`、`OPENING_SYSTEM_QUERY`、自动批改（日上限 50）。
默认关：`OPENING_STUDY_SESSION_V2`（支持账号白名单）、`OPENING_STUDY_SESSION_V2_PHOTO_ANSWER`、`OPENING_ADAPTIVE_PLANNING`、`OPENING_CHAT_ARTIFACTS`；`OPENING_CHAT_SENSEWEAVE` 为 off/shadow + 白名单。完整清单见 [feature-switch-inventory.md](../operations/feature-switch-inventory.md)。

## 6. 前端信息架构（现状）

- 主导航随 `studySessionV2` 变化：关闭时为“学习 / 复习 / 资料”（无探索入口）；开启时为“今日 / 课程 / 探索（`/opening/agent`）/ 资料”（无复习）。
- 旧 `/explore/*`、`/learn/*`、`/preview/*` 由 middleware 重定向到 `/opening/today`；`OPENING_RELEASE=1` 时首页忽略 `defaultEntry`。
- 对话入口分散在抽屉、`/opening/agent`、`/opening/assistant`、`/opening/suggestions`；课内学习分散在 study / span / matrix / handouts / sprint / practice。
- 笔记位于 `/opening/library` 的二级 Tab。

## 7. 已知缺口

| 方面 | 现状 |
|---|---|
| 区域 | 无 region 字段；单库、单对象存储区域、单模型目录 |
| 国际化 | 无框架；`<html lang="zh-CN">` 写死；文案硬编码中文；重定向安全校验绑定无前缀 `/opening/*` |
| 移动 | 基础壳层响应式；无 manifest / Service Worker；可拍照上传；无网页录音；部分工作区小屏不可用 |
| 未成年人 | 无年龄/监护人字段 |
| 配额 | 按工作区预算，无套餐/权益 |
| 遥测 | 有学习体验事件与反馈表；无页面内反馈入口与使用漏斗 |
| 迁移 | 无 expand/contract/backfill 框架；含迁移部署须所有者批准 |
| 无入口能力 | IELTS 工作台、分享海报生成、讲回竞技场、离线闪卡、408 卡带、错因纠偏、KST 诊断、Split CQR 预测、元认知/认知信念、多模态钩子等 |
