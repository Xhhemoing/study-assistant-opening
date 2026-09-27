# Review hardening tasks (RP1–RP6)

> 2026-09-21 两份 PI 审查（项目重新审查 + 产品方向核查，基线 `8d616c0`，工作区另有未提交恢复切片）落实为任务级修复项。各任务新增的**验收条目**（Acceptance additions）写入对应原任务完成条件；本文件本身持 RP 任务的细目。静态风险仍需运行证据，不把审查推断当已复现缺陷。

**Global constraints:** 不改变 M01/L02 等既有任务的账本状态；RP 任务修复审查发现的既有实现缺陷，不扩大产品范围。隐私修复改动 `loadTutorHistory` / `completeTurn` 时，必须保留 T02 已验证的材料版本快照与引用约束行为（`tests/integration/opening-tutor-history.test.ts` 等既有用例先跑红/绿对照）。

### RP1: Unified privacy admission for model context

**Owner:** DATA. **Depends:** M02.
**Modify:** `packages/database/src/repositories/opening-tutor-history.ts`、`packages/database/src/repositories/opening-privacy.ts`、`packages/database/src/repositories/opening-tutor-history.test.ts`、`tests/integration/opening-tutor-history.test.ts`。
**Interfaces:** 复用 `loadTutorHistory(sql, scope, currentTurnId)`；新增 `assertContextAdmission` 语义仅作为内部检查，不改变既有函数签名外的调用者。

- [ ] 先写失败测试：用户删除记忆后追问（本轮不选任何材料），旧问答不得出现在 `loadTutorHistory` 返回中；新增用例与既有"revoked source 使历史失效"用例同文件运行确认红。
- [ ] `loadTutorHistory` 的 invalid 判定增加：本轮或历史轮引用的任一 `source_id` 出现在 `opening_privacy_exclusions` 即整组历史置空（与现有"任一引用失效则全部丢弃"的保守策略一致）。
- [ ] 统一检查实现：worker 侧 chunks 准入（tutor-turn 现有 excluded 过滤）与历史准入共用同一 repository 查询（`listExcludedSourceIds` 或其 `isSourceExcluded` 变体），禁止两处各写一套过滤规则。
- [ ] 评审要求"验收检查实际发往 Provider 的输入"：在 `tests/integration/opening-tutor-turn.test.ts` 增加断言，验证删除后追问时 fetch 收到的 messages/context 不含被排除材料与历史问答（现有 fetch-only mock 模式，不调真实模型）。
- [ ] 回归：T02 版本快照测试、`opening-tutor-history.test.ts` 全量、history 边界（20 轮/12000 字符）不变。

### RP2: Atomic privacy-epoch writeback in completeTurn

**Owner:** DATA. **Depends:** M02.
**Modify:** `packages/database/src/repositories/opening-tutor-jobs.ts`（`completeTurn` 事务）、`apps/worker/src/jobs/tutor-turn.ts`（传参）、`apps/worker/src/jobs/tutor-turn.test.ts`、`packages/database/src/repositories/opening-tutor-terminal.test.ts`、`tests/integration/opening-tutor-turn.test.ts`。
**Interfaces:** `completeTurn(input & { expectedPrivacyEpoch?: number })`；worker 将任务开始时读取的 `jobEpoch` 传入；无隐私表环境（单测）传 undefined 保持现有行为。

- [ ] 先写失败集成测试：模拟删除在 epoch 检查与写回之间提交（同一会话两个连接或仓库钩子），`completeTurn` 必须整体回滚，`opening_turns` 不留 complete 状态，job 转 failed 且错误信息指明 privacy epoch 漂移。
- [ ] `completeTurn` 事务第一步 `SELECT privacy_epoch FROM workspaces WHERE id=$1 FOR UPDATE`，与删除流程使用同一行锁顺序；读取到 `privacy_epoch <> expected` 则抛错回滚。
- [ ] 保持模型调用在事务外；事务内只做：锁工作区行、校验 epoch、更新 job/assistant turn、help exposure、candidates。不新增长事务。
- [ ] `getUserTurn` 与 `completeTurn` 的 scope 校验不变；owner 边界回归用例通过。
- [ ] 文案区分（与 M02 删除语义一致）：不在本任务新增 API；仅在结果错误码与日志中区分 "epoch drift" 与 "turn missing"，不写回基于过期上下文的回答。

### RP3: Client logical-send dedup and recovery completion

**Owner:** DATA+EXPERIENCE. **Depends:** T03.
**Modify:** `apps/web/src/features/opening/assistant/composer.tsx`（clientKey 复用）、`apps/web/src/features/opening/assistant/assistant-view.tsx`（恢复 pending job 轮询，延续未提交切片）、`apps/web/src/features/opening/client/api.ts`、`packages/database/src/repositories/opening-conversations.ts`（intent_hash 冲突检测）、`apps/web/src/app/api/opening/conversations/[id]/pending-job/route.ts`。
**Interfaces:** `clientKey` 语义升级为"同一逻辑发送在重试时复用"：客户端把 `clientKey` 绑定到一次待发送意图（text+mode+sourceIds 指纹），发送成功/失败终态后清空；服务端以 `intent_hash` 识别同 key 不同内容并报 409。

- [ ] 失败测试先行：`composer` 在同一未确认提交上重试时复用同一 `clientKey`；`appendSavedTurn` 命中 `(workspace_id, client_key)` 唯一约束但 `intent_hash` 不同则返回 409 而非静默重放。
- [ ] 服务端：`appendSavedTurn`/`findTurnByClientKey` 已具备唯一索引与重放返回；补 `intent_hash`（0025 列）比较逻辑与同 key 重放时直接返回原 `{jobId, turnId}`。
- [ ] 恢复：`ConversationResume` 已含 pending job 发现（未提交切片）；本任务补：恢复后把 jobId 关联回会话消息、unknown 终态展示"结果未知，勿重复提交"、重试入口复用同 key。
- [ ] 验收场景（浏览器或 handler 级）：响应丢失后重试、生成中刷新、结果未知后重进会话——三者均不产生第二个逻辑轮次/第二次模型调用（以数据库行数与 provider fetch 计数断言）。
- [ ] 防回归：`submitTurn` privacy=saved 校验、空 source 校验、页码授权校验既有用例全绿。

### RP4: Evidence-faithful citation display

**Owner:** EXPERIENCE. **Depends:** T03.
**Modify:** `apps/web/src/features/opening/assistant/message-model.ts`、`apps/web/src/features/opening/assistant/message-list.tsx`、`apps/web/src/features/opening/sources/source-service.ts`（下载链接带版本）、`packages/contracts/src/opening/sources.ts`（如 DTO 缺版本字段）。
**Interfaces:** `ChatMessageView.citations: Citation[]`（不再压缩为 `string[]`）；`getDownloadUrl(principal, id, version?)` 支持按版本取键。

- [ ] 失败测试先行：`messagesFromResume` 对带引用轮次保留 `sourceId/sourceVersion/chunkId` 而非丢弃；引用组件渲染含版本标签。
- [ ] `ChatMessageView` 增加 `citations: Citation[]`，保留原 `citationLabels` 供紧凑展示或删除并同步调用方；恢复路径与轮询路径行为一致。
- [ ] 点击引用打开对应 `sourceVersion` 的下载/查看；当前版本与引用版本不一致时显示明确提示（不静默打开最新版）。
- [ ] `getDownloadUrl` 增加可选版本参数：服务端校验该版本属于同一 source 且有对象键；缺省保持当前版本。为后续 CitationIdentity（重解析后 chunk 定位）预留，不在本任务实现内容级定位。
- [ ] 回归：assistant-view 现有测试、contracts 测试全绿。

### RP5: CI gate for the active release branch

**Owner:** INTEGRATOR. **Depends:** B02.
**Modify:** `.github/workflows/ci.yml`、`docs/operations/ci.md`。
**Interfaces:** 无代码接口；验收以 GitHub Actions 记录为准。

- [ ] `push` 触发分支增加 `feat/opening-release`；增加 `workflow_dispatch` 手动入口。
- [ ] `docs/operations/ci.md` 更新触发范围说明；发布证据要求绑定具体 SHA（写入 Q03 readiness 检查清单的引用位置，不新增文件）。
- [ ] 在干净环境验证工作流外部镜像可拉取（`bitnami/minio` 等）；不可拉取时以等价镜像替换并记录，不沿用历史假设。
- [ ] 验收证据：当前 HEAD push 后 `quality` job 的实际运行链接与结果；不把本文件合并当作"门禁已通过"。

### RP6: Today page real resume entry

**Owner:** EXPERIENCE. **Depends:** T03,U01.
**Create:** `apps/web/src/features/opening/planning/today-read.ts`、`apps/web/src/features/opening/planning/today-read.test.ts`、`apps/web/src/app/api/opening/today-resume/route.ts`（或复用现有 conversations/plans 读路径，由实现时二选一并更新本行）。
**Modify:** `apps/web/src/app/(opening)/opening/today/page.tsx`（替换固定空状态）。
**Interfaces:** `TodayResumeState = { kind: 'continue'|'confirm'|'empty'|'error'|'loggedOut' }` 读模型；继续项含课程/材料版本/阅读位置/上一步问题。

- [ ] 失败测试先行：`TodayResumeState` 对"有未完成轮次/有候选待确认/无任何数据/服务失败/未登录"五种输入给出正确分类；不得伪造数据。
- [ ] 首屏三问：上次停在哪里（继续项）、现在可以做什么（单个主要动作）、哪些事情需要确认（候选/记忆/计划）。不做统计仪表盘。
- [ ] 继续项读取真实数据：最近会话+其材料版本快照+最后用户轮文本摘要；计划数据可用 `GET /api/opening/today` 既有读路径；读失败显示错误态而非空态。
- [ ] 移动端单列布局；链接均指向真实路由（assistant 会话、课程、候选确认），不得出现死链。
- [ ] 本任务只交付"恢复入口"最小切片；与 G2（R2a/R2c 完整恢复卡）的关系：本任务是 R2a 的可先行子集，不替代 G2 验收。
