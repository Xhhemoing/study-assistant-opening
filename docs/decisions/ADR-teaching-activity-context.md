# ADR: Teaching Activity Context — 活动 / 内容 / 证据兼容边界

**状态**: 已批准（设计）— 仍不执行 ALTER  
**日期**: 2026-10-11  
**决策者**: AIstudy Data  
**任务**: V2-03（`docs/superpowers/plans/ai-led-learning-v2`）  
**基线 tip**: `1a4cf465c86da7f08b6fda3044f9b0f932b80824`（`feat/opening-release`）

## 背景

AI 主讲学习 v2 需要「可自由开始」的学习活动：不强制先建课程（G3），正式作答仍走唯一事实账本（G8），证据保持诚实（G6），并嵌进现有 Today / 助手 / 资料 / 证据导航（Paula 嵌入约束），而不是旁路新 App。

当前栈对「无课程」的支持不一致：

| 域 | `course_id` / `courseId` | 现状 |
|---|---|---|
| 对话 `opening_conversations` | **NULL 允许** | `0017_opening_conversations.sql` L9；契约 `conversations.ts` 可空 |
| 记忆 / 部分规划 | **可空** | `memory.ts` / `planning.ts` 已用 null 表示 workspace 范围 |
| 学习会话 / 观察 / 尝试 | **NOT NULL** | `0019_opening_learning.sql` L9、L53；`0028_opening_learning_attempts.sql` L2/L8/L17 |
| 历史修订计数器 | **NOT NULL 且为 PK 组成部分** | `opening_learning_history_revisions` PK `(workspace_id, owner_user_id, course_id)` |
| SkillEvidence | **NOT NULL + FK → courses** | `0049_opening_skill_evidence.sql` L7 |
| 补测活动 | **NOT NULL + FK → courses** | `0030_opening_retest_activities.sql` |
| 知识节点 | **NOT NULL + FK → courses** | `0048_opening_knowledge.sql` |

读路径普遍先 `assertOwnedCourse` 再按课程过滤（`apps/web/src/features/opening/learning/read-service.ts` L16–23；`opening-learning-facts.ts` `lockLearningSession` L30–32 `JOIN courses … archived_at IS NULL`）。若仅把列改成 nullable 而不重写授权与修订键，会出现「无课程事实写不进 / 读不出 / 归档孤儿 / 假课程」等失败模式。

章程与计划要求：一份教学正文一个权威存储；Observation / Attempt / Exposure 资格判定仍是唯一事实源；Episode 只读投影不得成为第二套评分；本 ADR **只做设计**，不执行迁移或跨包 API 落地（需单独批准）。

## 决策

### D1. 活动身份（Activity identity）

- 每个学习活动的稳定身份为 **`workspaceId + ownerUserId + activityId`**（三者始终存在）。
- **`courseId` 为可选关联**（可空）：关联表示「此活动挂在某课程下」，不是身份主键。
- **禁止**为满足 NOT NULL 约束而创建用户看不见的「幽灵课程 / 默认课程 / 系统课程」（G3）。
- 后续「关联课程 / 撤销关联」只改活动元数据上的 `courseId` 指针；**不得**就地改写历史 observation / attempt 行的 `course_id` 来「迁就」新关联（见 D5 反例）。

### D2. 内容权威（Content authority）

- **教学正文**唯一权威存储为现有统一资产：`library_documents` / `library_blocks` / `library_revisions`（`0001_library.sql`）。
  - Document：生命周期与当前修订号；
  - Block：`content jsonb` 承载块类型与参数；
  - Revision：append-only 快照（触发器禁止 UPDATE/DELETE）；
  - 候选改写走现有 `revision_proposals`（`0010_revision_proposals.sql`），不平行造第二套正文表。
- TeachingUnit / ActivitySpec（V2-04/05）表**只存**活动顺序、索引、来源引用、验证状态、生成配置等元数据；**禁止**再复制一份正文。
- **个人草稿、作答、反馈**与可复用教学正文分离；未揭示答案不得进入客户端初始化 JSON/DOM/恢复快照（细则留给 V2-05）。
- 若块级元数据不足，优先用 `library_properties` / `library_relations` 做**窄范围**扩展；只有在 ADR 后续修订中说明「为何统一资产无法表达」后，才允许新增教学专用索引表——仍不得复制 body。

### D3. 证据路径与双轨 API（Evidence path + v1/v2 compat）

**单一事实写入路径**：所有正式观察 / 尝试 / 帮助暴露仍写入 `opening_learning_*`（sessions、observations、attempts、help_exposures、eligibility、history revisions）。禁止因「无课程」另建不可合并的作答账本或平行 mastery 表。

**v1 API（保持不变）**

- 契约继续要求 `courseId`：`observationInputSchema`（`learning.ts` L100）、`learningSessionCreateInputSchema`（L201）、`learningAttemptSchema`（`learning-attempts.ts` L25）、`learning-history` / `learning-summary-page` 输入（必填）。
- 行为：`createSession` 校验未归档课程（`opening-learning.ts` L26–27）；读服务先 `assertOwnedCourse`；`nextLearningHistoryRevision(tx, scope, courseId)` 按课程递增。
- 旧客户端 / 课程页路由（`/api/opening/courses/{courseId}/…`）零破坏。

**v2 API（迁移批准后）**

- 新增活动范围契约（拟 `teaching-activity.ts` 等，本 ADR 不落地）：创建 / 命令 / checkpoint 以 `activityId` 为主键；`courseId` 可选。
- 正式作答经 **现有** observation/attempt 服务的 v2 适配写入同一表；迁移批准后，相关列允许 `course_id NULL`，并携带 `activity_id`（NOT NULL，指向教学活动）。
- 无课程时：授权改为 **owner + workspace + activity 成员/所有权**，**不得**再调用 `assertOwnedCourse`。
- 有课程时：可同时做课程所有权校验；课程摘要 API 仍只返回该 `course_id` 范围的事实。
- 旧 LearningEvent v1 只接受其能表达且已适当核验并映射的观察；无课程或无法映射的观察**留在观察层**，不强塞布尔正确事件，也不丢弃。

**必须随 nullable 一起改写的 SQL / 代码接缝（实施前清单，不在本任务执行）**

| 对象 | 当前约束 / 行为 | v2 要求 |
|---|---|---|
| `opening_learning_sessions.course_id` | NOT NULL | 可空；加 `activity_id` |
| `opening_learning_observations.course_id` | NOT NULL | 可空；加 `activity_id`；索引需覆盖 `(workspace, activity)` |
| `opening_learning_attempts.course_id` | NOT NULL | 同上 |
| `opening_learning_item_versions.course_id` | NOT NULL | 同上或改为可空 |
| `opening_learning_history_revisions` | PK 含 `course_id NOT NULL` | 见 D3.1 |
| `lockLearningSession` | `JOIN courses … archived_at IS NULL` | 无课程会话不得依赖课程 JOIN；改 activity 锁 |
| `assertOwnedCourse` 读路径 | 课程必填 | 无课程读走 activity 授权 |
| `opening_skill_evidence.course_id` | NOT NULL FK courses | 无课程时**不写** SkillEvidence（需节点且节点属课程）；有课程关联后再投影 |
| `opening_retest_activities.course_id` | NOT NULL FK | 无课程补测需单独迁移方案；M1 可先限制「有课程才生成任务型补测」 |

#### D3.1 历史修订键演进（只提案，不实施）

现状：`nextLearningHistoryRevision` 以 `(workspace_id, owner_user_id, course_id)` 为冲突键（`opening-learning-facts.ts` L43–47）；另有 workspace 级 `opening_workspace_history_revisions`（`0037`）。PostgreSQL 主键列不能为 NULL，故「把 PK 里的 course_id 改成可空」**不可行**。

| 方案 | 做法 | 优点 | 风险 |
|---|---|---|---|
| **A（推荐）** | 新增 `opening_learning_activity_history_revisions`，PK `(workspace_id, owner_user_id, activity_id)`；v1 课程 API 继续用原 course 计数器；v2 活动写入用 activity 计数器 | 与活动身份对齐；不破坏旧游标语义；无幽灵 UUID | 双计数器；摘要失效需按范围选择 |
| B | 无课程事实只推进 workspace 级计数器 | 少一张表 | 粒度粗；课程页与活动页缓存抖动耦合 |
| C | 用固定 sentinel UUID 填 course_id | 看似少改 SQL | **禁止**：等价幽灵课程，违反 G3/D1 |
| D | 把 PK 改为 `(workspace, owner, scope_kind, scope_id)` 并回填 | 统一模型 | 迁移面大、旧游标/备份兼容成本高；可作远期整理，不作 M1 默认 |

**推荐 A**：M1 在批准迁移中增加 activity 修订表；课程范围读写保持现状；活动范围读写使用 activity 修订；关联课程时不合并/重放历史修订号。

### D4. 禁止平行评分（No parallel scoring）

- **禁止**新增「掌握分 / AI 说会了 / Episode 真值表」作为能力事实来源。
- `LearningEpisode`（及任何跨材料投影）= **只读投影**，由 Observation / Attempt / Exposure + 资格判定派生。
- `opening_skill_evidence` 仍是观察→知识节点的**投影链接**（`0049` 注释已声明 LearningEvent/observation 权威）；不得升级为独立分数系统。
- 完成度、停留时长、点赞、生成状态、活动进度（`active/paused/…`）均不得自动写成 `outcome=correct` 或掌握结论（G6）。

### D5. 授权与生命周期反例（Forbidden designs）

以下设计明确拒绝：

1. **可空 courseId + 仍强制 `assertOwnedCourse`**：无课程写入/读取全部 404。
2. **把无课程事实塞进课程摘要 API**（`summarizeLearning(scope, courseId)` / summary-page）：污染课程视图或静默丢数据。
3. **归档孤儿**：课程 `archived_at` 后，`lockLearningSession` 的 JOIN 使挂在该课的会话不可写；无课程活动若错误依赖同一 JOIN，会被误杀。活动读/写必须以 activity 所有权为准；课程归档只影响「课程关联视图」，不删除已有观察。
4. **事后关联课程时就地 UPDATE 历史 `observation.course_id`**：篡改证据归属、破坏课程历史游标与备份差分。正确做法：活动行更新 `courseId`；历史行保持写入时的 `course_id`（null 或原值）；新写入可选带新关联。
5. **为通过 FK 创建隐藏课程** 或 **把答案 dump 到第二套 store**。
6. **nullable 一行迁移、不改索引/备份/eligibility repair**：遗漏 `opening_learning_history_revisions` PK、eligibility 按 course 过滤、backup 表清单等。

**反例检查（设计验收）**

| 场景 | 期望 |
|---|---|
| 无课程创建活动并提交观察 | 写入成功；auth = owner+workspace+activity |
| 无课程读活动事实 | 活动 API 可读；课程 summary API 不返回这些行 |
| 课程归档后读无课程活动 | 仍可读 |
| 稍后关联课程 | 活动元数据更新；历史 observation.course_id 不变 |
| 撤销关联 | 同上，不删观察 |
| 旧客户端仍传必填 courseId | 行为与今日完全一致 |

### D6. 备份 / 导出 / 回滚

- **新活动表、activity 修订表、教学元数据表**从首次上线起纳入 `OPENING_BACKUP_TABLES`（见 `opening-backup-records.ts` L7–15）。今日清单已含 sessions/observations/attempts/history_revisions，**尚未**含 `opening_skill_evidence` / eligibility——后续迁移批准时一并评估补齐，避免「新表可写不可备」。
- **回滚策略**：功能旗标关闭 + **保留数据** + 旧 v1 API 继续服务；**不** drop 用户数据表；**不**做「正确 / 独立 / 迁移」等不可逆回填来粉饰旧事实。
- 导出范围按用户 workspace+owner；恢复预检沿用现有 opening-backup 校验，不引入第二套备份格式。

### D7. 产品嵌入（Embedding — Paula 约束）

- AI 主讲是 **主区演进**，复用 Today / 助手 / 资料 / 证据账本与现有导航；**不是**旁路新 App 或孤立落地页。
- 入口优先落在现有 **「继续学习 / 开始学习」** 与活动流（例如 `today-resume-view.tsx` 的「继续学习」、Today 队列），不强迫新问卷。
- 新接口与组件接入现有契约与样式；不平行造第二套事实或评分 UI。
- 自由探索对话（`courseId=null`）与无课程教学活动可并存：对话不产生掌握事实；正式尝试仍走 learning 事实路径。

### D8. 本 ADR 明确不在范围

- 不执行任何 schema ALTER / 数据迁移 / 回填。
- 不落地 TeachingUnit 契约与表（V2-04/05）。
- 不实现 Pipeline ingest（V2-07）。
- 不修改 `tasks.json` 状态；不 commit / push / stash / reset。

## 理由

1. **对照已有可空先例**：对话与记忆已证明「workspace 范围 + 可选 course」可行；学习事实域因历史修订 PK、`assertOwnedCourse` 与课程 JOIN 更紧，需要显式双轨而非抄一行 nullable。
2. **统一资产已够承载正文**：Document/Block/Revision + revision_proposals 覆盖版本化、候选审核与 append-only；教学表只做索引符合「一份正文」与 G8 增量原则。
3. **单一事实账本**：避免无课程时答案落入不可合并 store，否则日后关联课程无法诚实合并证据（G6/G8）。
4. **修订键方案 A**：在不引入幽灵课程的前提下，保持 v1 课程游标稳定，并为活动范围提供独立 watermark。
5. **嵌入约束**：入口与导航复用降低产品分叉，满足章程 G1/G8 与 Paula 2026-10-11 嵌入要求。

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| 双计数器（course vs activity）导致缓存失效遗漏 | 写路径文档化「按范围选计数器」；集成测试覆盖课程页与活动页各自游标 |
| SkillEvidence / 知识节点仍强制课程 | 无课程阶段不写 SkillEvidence；关联课程且节点存在后再投影 |
| 补测活动 FK 仍要课程 | M1 可选：仅课程关联活动生成 task 型补测；无课程保留观察层 |
| 备份遗漏新表 | D6：上线日必须登记 `OPENING_BACKUP_TABLES`；CI/清单审查 |
| 实施者「先改 nullable 再补授权」 | D5 反例 + 批准边界：迁移与跨包 API 须单独批准，本 ADR 不授权执行 |
| 历史关联被误实施为 UPDATE course_id | 契约/仓库测试锁定「关联不改写 observation.course_id」 |

## 后续

1. **PM / Paula 批准本 ADR** 后，方可开 M1 迁移与契约变更工单（V2-04 依赖）。
2. 迁移工单必须附带：完整 ALTER 清单、auth 改写 diff 范围、history 方案 A DDL、backup 表登记、回滚旗标、反例测试用例。
3. V2-04 实现活动上下文；V2-05 教学版本化内容；V2-07 Pipeline ingest——均不得违反 D1–D7。
4. 旧 API 无限期保留直至显式弃用 RFC；弃用前不得删除 courseId 必填路径。

## 参考

- 章程：`docs/plans/2026-10-11-ai-led-learning-v2.md`（G3/G6/G8、Paula 嵌入、facts ledger）
- 计划：`docs/superpowers/plans/ai-led-learning-v2/plan.md` §6.1、V2-03
- 契约：`packages/contracts/src/opening/learning.ts`（L100、L173、L182、L201 等）
- 迁移：`0017_opening_conversations.sql`、`0019_opening_learning.sql`、`0028_opening_learning_attempts.sql`、`0037_opening_learning_history_snapshot.sql`、`0049_opening_skill_evidence.sql`、`0001_library.sql`、`0010_revision_proposals.sql`
- 仓库：`opening-learning-facts.ts`（`nextLearningHistoryRevision`、`lockLearningSession`）、`opening-learning-observations.ts`、`opening-learning-summary-read.ts`、`opening-learning-help.ts`、`opening-learning.ts`（`assertOwnedCourse`）
- 读服务：`apps/web/src/features/opening/learning/read-service.ts`
- 备份清单：`packages/database/src/repositories/opening-backup-records.ts`（`OPENING_BACKUP_TABLES`）
- 样式先例：`docs/decisions/ADR-014-scenario-preset-registry.md`

---

**批准栏**

- [x] 架构 / 数据：同意 D1–D8（Integrator ACCEPT + PM 复核 2026-10-11）
- [x] PM：批准进入 M1 时按方案 **A** 做迁移*设计*与 V2-04 工单（**仍不自动执行 ALTER**；须附完整清单）
- [x] Paula：产品嵌入与无幽灵课程约束已在 2026-10-11 聊天确认（嵌进现有程序、不突兀旁路）

**PM 备注：** 批准的是 D1–D8 设计边界与修订键方案 A；M0（V2-01 CI、V2-02 AI fixtures）齐后再开 V2-04 实现切片。禁止幽灵课程（方案 C）、禁止平行评分、禁止就地改写历史 `observation.course_id`。
