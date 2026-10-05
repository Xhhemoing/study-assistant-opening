# 2026-10-02 至 10-07 开发冲刺计划

> **目标**：完成 M1（能提交材料并求助）和 M2（会记住、能重测）的桌面端功能，不含移动端适配。
> **范围**：U02（上传界面）、M01-M03（记忆系统）、L01-L03（学习证据）、U03 薄切片（基础对话界面）。
> **验收标准**：桌面浏览器（≥1024px）可完成"上传材料 → AI 对话 → 确认记忆 → 记录学习证据"完整流程。

---

## 一、任务分解与时间分配（6 天）

### Day 1-2（10/2-10/3）：上传功能 + 对话界面基础
**目标**：用户能在桌面端上传材料并看到处理状态，进入基础对话界面。

#### **U02-桌面版**（1.5 天）
- [x] `upload-client.ts`：调用 I01 已验证的 beginUpload → PUT → completeUpload 流程
- [x] `upload-state.ts` + 测试：区分上传中/已保存/解析中/解析失败状态
- [x] `capture-dialog.tsx`（桌面文件选择器，不含相机）：
  - 文件选择（PDF/图片/音频）
  - 上传进度条（真实字节进度）
  - 错误处理（文件过大/格式不支持/网络中断）
- [x] `source-row.tsx`：材料列表行，显示状态标签
- [x] `source-viewer.tsx`（桌面版）：
  - 已解析材料：分页查看（PDF）、图片缩放
  - 原件下载（authenticated signed URL）
  - 解析失败提示 + 重试按钮
- [x] 集成测试：`tests/integration/handler/opening-upload-desktop.test.ts`
- [ ] 浏览器测试：上传 → 刷新页面 → 状态保持

**交付标准**：
- 桌面端（Chrome/Edge 1440×900）可上传 PDF，看到"解析中 → 已完成"状态
- 上传失败显示明确错误，可重试
- 刷新页面后材料列表保持，不丢失

#### **U03-薄切片：基础对话**（0.5 天）
- [x] `apps/web/src/features/opening/client/api.ts`：封装 T03 已验证的 `/api/opening/conversations` 接口
- [x] `composer.tsx`（桌面版）：
  - 文本输入框（无移动端键盘优化）
  - 模式选择（hint/explain/listen/think_together）
  - 发送按钮 + loading 状态
  - 材料选择（接入 U02 已上传材料）
- [x] `message-list.tsx`：
  - 用户消息 + 助理回复渲染
  - 引用材料标签（sourceId + 版本号）
  - 空状态提示
- [x] `assistant-view.tsx`：组装 composer + message-list，调用 T03 API

**交付标准**：
- 可发送消息，等待 AI 回复（真实 T01-T03 后端）
- 引用材料 ID 显示在消息旁（尚未实现"点击跳转到材料页"）
- 刷新页面后对话历史保持

---

### Day 3-4（10/4-10/5）：记忆系统核心

#### **M01：记忆候选与确认**（1 天）
- [x] 数据库迁移：`0022_opening_memory_privacy.sql`（kind/source/version/expiry/status）；更正版本追加 `0039_opening_memory_revisions.sql`
- [x] `packages/domain/src/opening/memory-policy.ts` + 测试：
  - `isMemoryEligible(item, now)`：过期/候选状态不进入上下文
  - 候选 vs 确认 vs 临时状态区分
- [x] `packages/database/src/repositories/opening-memory.ts`：
  - `proposeMemory(scope, {text, sourceTurnIds, expiresAt})`
  - `listMemory(scope, {kind?, includeExpired?})`
  - `decideMemory(scope, {id, decision:'confirm'|'reject', expectedVersion, clientKey})`
  - `replaceMemory(scope, {id, expectedVersion, text, sourceTurnIds, clientKey})`
- [x] `apps/web/src/app/api/opening/memory/route.ts`：GET（列表）+ POST（提案）
- [x] `apps/web/src/app/api/opening/memory/[id]/decision/route.ts`：确认/拒绝/更正
- [x] 隔离 PostgreSQL 集成/handler 测试：
  - 候选提案 → 列表可见（kind=candidate）
  - 确认后升级为 kind=confirmed
  - 重复确认幂等（expectedVersion + clientKey）
  - 过期临时状态（expiresAt < now）不进入上下文
  - 更正版本化、旧版本 superseded、同键重放
- [x] contracts、database、domain、AI、web、worker 类型检查及定向 ESLint
- [ ] 浏览器人工验收（按仓库约定由用户执行）

**交付标准**：
- T03 对话结束后，后台可生成记忆候选（通过 handler 测试验证）
- 记忆 API 可列出候选、确认、拒绝
- 确认后的记忆进入下次对话上下文（isMemoryEligible=true）

#### **M02：隐私删除与竞态防护**（0.5 天）
- [x] `packages/database/src/repositories/opening-memory-delete.ts` + privacy service：
  - 事务 tombstone + privacyEpoch++ + content-free exclusion + learning eligibility invalidation
  - `deleteMemory(scope, {id, expectedVersion, deleteSourceText, clientKey})`
- [x] `apps/worker/src/runtime/privacy-guard.ts` + 测试：
  - `assertCurrentEpoch(jobEpoch, currentEpoch)`：provider 发送前和写回前检查 epoch
- [x] `apps/worker/src/jobs/tutor-turn.ts` 与 `completeTurn`：写回事务锁 workspace 并原子校验 epoch
- [x] 隔离 PostgreSQL 集成测试：删除 epoch、双连接写回竞态、来源历史隔离、旧备份 memory 墓碑
- [x] 定向 unit、typecheck、ESLint
- [ ] 浏览器人工验收删除/来源文本选择（由用户执行）

**交付标准**：
- 删除记忆后，旧 epoch 的 worker 无法写回结果
- 删除事务包含：tombstone + epoch++ + 撤销材料块引用
- 集成测试验证竞态场景

#### **M03：不保存模式**（0.5 天）
- [x] `packages/ai/src/opening/conversation-policy.ts` + 测试：
  - `canProposeTask(mode)`：listen 模式不生成任务
- [x] `apps/web/src/app/api/opening/ephemeral/route.ts`：
  - 接收 `{text, sourceIds, mode, history}`
  - 调用 T01 但不持久化对话正文
  - 返回 response，不生成记忆候选
- [x] `apps/web/src/features/opening/tutor/ephemeral-service.ts`：封装临时对话逻辑
- [x] 隔离 PostgreSQL handler 测试：无 saved rows、预算消耗、候选剥离、刷新仅标签页历史/epoch 隔离
- [x] unit、typecheck、ESLint
- [ ] 浏览器人工验收保存/不保存切换与刷新行为（由用户执行）

**交付标准**：
- composer 可切换"保存对话"/"不保存本轮"
- 不保存模式：刷新页面后历史清空，警告用户
- 临时对话不生成记忆候选

---

### Day 5（10/6）：学习证据系统

#### **L01：纸面作答与辅助曝光**（0.7 天）
- [x] 数据库迁移：`0019_opening_learning.sql`（learning_session + observations）；现有 `0028` attempt、`0029` 修订、`0038` 资格迁移在隔离测试库均 verified
- [x] `packages/domain/src/opening/assistance.ts` + 服务端资格规则测试：
  - `resolveAssistance(declared, exposures)`：客户端不能抹除服务端已知的提示
  - 按后续 S2 方案保留原始 assistance 声明，使用 `eligibility.independentAttempt` 与原因码裁决，不改写原始事实
- [x] `packages/database/src/repositories/opening-learning.ts`：
  - `createSession(scope, {courseId, skillLabel, sourceIds})`
  - `insertObservation(scope, {sessionId, assistance, outcome, verdictSource, ...})`
- [x] `apps/web/src/app/api/opening/learning-sessions/route.ts`
- [x] `apps/web/src/app/api/opening/observations/route.ts`
- [x] `tutor-turn.ts`：hint/explain 提示送达与 assistant turn 在同一事务记录 exposure（hinted/revealed）；失败与非学习模式不记录
- [x] 集成测试：已知提示覆盖独立资格、跨题/会话隔离、曝光重放完整意图校验、错误 attempt 与无题目 attempt 归属拒绝
- [x] 真实 PostgreSQL integration：5 files / 50 tests；handler：2 files / 11 tests；unit：6 files / 74 tests
- [x] database 类型检查、新测试入口严格编译与定向 ESLint；[L01 证据](../superpowers/evidence/2026-10-02-week-sprint/l01-learning-verified.md)
- [ ] 浏览器人工验收课程练习、提示后提交与刷新历史（由用户执行）

**交付标准**：
- 可创建学习会话（关联课程 + 材料）
- 记录观察（独立/提示后/答案已知）
- 辅助曝光不可被客户端抹除；原始自报值与服务端资格分开保存/展示，不据少量观察推断掌握

#### **L02：可解释状态与重测建议**（0.3 天）
- [x] `packages/domain/src/opening/learning-summary.ts` + 测试：
  - `summarizeObservations(observations, now)`：
    - 无证据 → 空状态
    - 未验证/模型建议 → needs_check
    - 独立参考检查正确 → observed_independent
  - 服务端资格、来源标签、版本适用性、历史错误与 unknown 计数保持可解释，不推断掌握
- [x] `packages/domain/src/opening/retest-policy.ts` + 测试：
  - `suggestRetestAt(occurredAt, delayDays)`：默认 2 天后重测，可修改的启发式
- [x] `apps/worker/src/jobs/retest-candidate.ts`：默认至多 1 题，不虚构题干/来源；保持课程/requirement 身份，尊重关闭偏好与隐私 epoch
- [x] `apps/web/src/app/api/opening/retests/[id]/accept/route.ts`：真实 task 接受、同键重放与冲突检查；不声明已安排日历
- [x] unit：7 files / 79 tests；真实 PostgreSQL integration：6 files / 63 tests（1 个条件跳过）；handler：2 files / 5 tests
- [x] domain、database、worker、web 类型检查和定向 ESLint；[L02 证据](../superpowers/evidence/2026-10-02-week-sprint/l02-learning-summary-retest-verified.md)
- [ ] 浏览器人工验收摘要、资格说明、重测接受与刷新（由用户执行）

**交付标准**：
- 学习观察 → 状态摘要（needs_check/observed_independent）
- 重测建议生成（2 天后，可编辑）
- 接受重测 → 已接通 P02 task 薄适配，但不等于安排日历，也不代表 P02 整片验证完成

---

### Day 6（10/7）：集成验收与UI连接

#### **L03：真实学习读取 + 对话界面集成**（0.5 天）
- [x] `apps/web/src/app/api/opening/courses/[id]/learning/route.ts` 与 `/learning/summary/route.ts`：
  - owner-scoped 读取 observations + formal learning evidence，返回空状态、固定快照分组摘要、完整计数和有限代表证据
  - 游标绑定课程/用户/隐私 epoch/策略版本，语义变化返回冲突，不混合分页结论
- [x] `apps/web/src/features/opening/client/learning-client.ts` + 测试：
  - `getSummary(courseId)` 和固定快照摘要读取失败抛错，响应按 contract 校验，不返回 fake 数据
- [x] `apps/web/src/features/opening/learning/course-summary-state.ts` 与 `course-view.tsx`：
  - 处理空状态、资格更新、错误重试、固定快照分页和隐私变化刷新
- [x] `tests/contract/opening-no-mock.test.ts`：禁止 opening routes 导入 Mock provider
- [ ] 浏览器测试：手机保存观察 → 电脑刷新 → 状态同步（由用户执行）

**交付标准**：
- 课程页显示学习状态（来自服务端 L02 规则）
- 无观察时显示空状态，不显示假数据
- 非浏览器自动化已完成：真实隔离 PostgreSQL handler/integration、unit、contract、类型检查、定向 ESLint 和差异检查；[L03 证据](../superpowers/evidence/2026-10-02-week-sprint/l03-learning-read-verified.md)
- 跨设备同步（浏览器 A 提交 → 浏览器 B 刷新可见）仍待用户浏览器验收

#### **U03 集成：记忆面板 + 学习状态**（0.5 天）
- [x] `memory-panel.tsx`（桌面版）：
  - 列出记忆候选（kind/source/time）
  - 确认/拒绝按钮 + loading 状态
  - 删除警告（是否删除来源对话文本）
- [x] `course-view.tsx`（桌面版）：
  - 显示学习状态（needs_check/observed_independent）
  - 区分自述/模型建议/参考检查
  - 查看证据来源（observation IDs + 材料标签）
- [x] 集成到 `assistant-view.tsx` 和 `/opening/courses/[id]/page.tsx`

**交付标准**：
- 对话后，记忆候选面板显示待确认项
- 确认后刷新，候选变为已确认记忆
- 课程页显示学习状态（来自 L03 API）

---

## 二、验收标准（10/7 完成）

### 桌面端完整流程（≥1024px，Chrome/Edge/Firefox）

1. **上传材料**
   - 选择 PDF → 上传进度条 → "解析中" → "已完成"
   - 点击材料 → 分页预览 + 下载原件
   - 上传失败 → 明确错误提示 + 重试

2. **AI 对话**
   - 选择已上传材料 → 输入问题 → 发送
   - 等待回复（真实 AI，非 Mock）
   - 引用材料 ID 显示在回复旁
   - 刷新页面 → 对话历史保持

3. **记忆确认**
   - 对话结束 → 记忆候选面板出现
   - 显示提取的知识点 + 来源对话 ID
   - 点击"确认" → 候选变为已确认
   - 下次对话 → 已确认记忆进入上下文

4. **学习证据**
   - 对话中使用提示 → 标记为"提示后作答"
   - 课程页显示学习状态（needs_check/observed_independent）
   - 查看证据详情（时间 + 辅助类型 + 来源材料）

5. **隐私保护**
   - 删除记忆 → 确认是否删除来源对话文本
   - 删除后刷新 → 记忆不再出现
   - epoch 递增 → 旧 worker 无法写回

6. **不保存模式**
   - 切换"不保存本轮" → 警告提示
   - 发送消息 → AI 回复
   - 刷新页面 → 历史清空
   - 数据库无此对话记录

### 不包含（留待后续）
- ❌ 移动端适配（<768px）
- ❌ 计划生成（P02-P03，需 L01 完成后集成）
- ❌ 今日任务队列（依赖 P02）
- ❌ 邮箱/钉钉同步（C01-C03）
- ❌ 音视频转写（V01）

---

## 三、风险与应对

### 风险 1：数据库迁移冲突
- **风险**：0022（M01）和 0019（L01）可能与工作区其他迁移冲突
- **应对**：先检查当前最新迁移号，按顺序分配，避免并行写迁移文件

### 风险 2：T03 对话 API 未完全就绪
- **现状**：T03 标记为 verified，但 UI 未实际调用
- **应对**：Day 1 先写集成测试验证 T03 端到端流程，失败则先修复 T03

### 风险 3：记忆候选生成逻辑未实现
- **现状**：T03 验证不包含"对话结束后生成记忆候选"
- **应对**：M01 需修改 `tutor-turn.ts`，对话完成后调用 `proposeMemory`

### 风险 4：时间不足
- **预留**：Day 6 下午为缓冲时间，优先保证 U02 + M01 + L01 核心流程
- **降级**：L02/L03 可推迟到下周，先交付"能对话、能记忆"版本

---

## 四、每日 Standup 检查点

| 日期 | 完成标志 | 阻塞项处理 |
|---|---|---|
| 10/2 | U02 桌面版上传 UI 可用，至少 1 个 PDF 上传成功 | T03 集成测试失败 → 修复后继续 |
| 10/3 | 基础对话界面可发送消息，AI 回复显示 | 材料选择器未完成 → 先硬编码材料 ID |
| 10/4 | M01 API 可创建候选、确认候选，集成测试通过 | 0022 迁移冲突 → 协调 INTEGRATOR |
| 10/5 | M02 删除 + epoch 检查通过，M03 不保存模式可用 | worker 竞态测试失败 → 增加事务日志 |
| 10/6 | L01 学习会话创建，辅助曝光测试通过 | 0019 迁移依赖 0022 → 等待 M01 合入 |
| 10/7 | 桌面端完整流程验收通过（上传→对话→记忆→学习） | UI 集成延迟 → 优先 API 验证 |

---

## 五、成功标准

- ✅ M1 核心：材料上传 + AI 对话（桌面端）
- ✅ M2 核心：记忆确认 + 学习证据记录（桌面端）
- ✅ 15 个已验证任务 → 19 个已验证任务（+U02, M01, M02, M03）
- ✅ 无 Mock 数据：所有功能连接真实后端 API
- ✅ 隐私保护：删除 + epoch 检查通过集成测试
- ✅ 浏览器验收：Chrome 1440×900 完整流程录屏

**交付物**：
1. 代码提交（feat/opening-release 分支）
2. 更新 `tasks.json`：U02/M01/M02/M03/L01 状态 → verified
3. 证据文档：`docs/superpowers/evidence/2026-10-02-week-sprint/m1-m2-desktop-verified.md`
4. 浏览器录屏：完整流程演示（5 分钟）

---

## 六、后续计划（10/8 起）

- **Week 2**：P01-P03（计划生成与今日任务）
- **Week 3**：Q01-Q03（集成验收与打包）
- **Week 4+**：C01-C03/V01/K01-K02（扩展能力）
