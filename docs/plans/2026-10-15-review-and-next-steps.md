# 评审结论与下一步：模型调度 + 证据闭环（GPT 实现部分）

**Date:** 2026-10-15
**评审范围：** `feat/opening-release` 上 `2af900e..7fb4f85`（M3 收尾、M4、M5、S8、UX 三轮、E5、E1/E3/E4、文档）
**评审方式：** 读代码 + 在本地 Postgres 上重跑检查；未运行浏览器测试，未接真实供应商。

## 1. 实际检查结果

| 检查 | 结果 |
|---|---|
| `npm run typecheck`（全部包） | 通过 |
| `npm run lint`（含 server-boundary） | 通过，0 个边界违规 |
| 单元（`--project unit` 全量） | 494/495 个文件、3578/3579 项通过；唯一失败 `apps/worker/src/parsers/pdf-page-images.test.ts`，缺本地 docling Python 环境，改动前就失败 |
| handler（全量） | 48/49 个文件、266 项通过；失败的 `opening-upload-desktop.test.ts` 缺 Redis/S3 环境变量 |
| 集成（全量） | 大部分通过。失败分两类：① 需要 Redis/MinIO 的（`opening-worker`、`opening-parse-job`、`opening-sources-storage`、`opening-reminder-delivery`、`dependency-checks`、`opening-source-actions`、备份相关 3 个），本环境没有这两个服务；② **`identity-migration-compatibility.test.ts` 是真实的过期测试**，见 R7 |

结论：GPT 报告的「单元/集成/handler/类型/lint 通过」在它选的子集上成立；全量集成里有一个真实失败（R7）它没有覆盖到。

## 2. 做得好的地方（保持）

- 参考答案接口 `getSubmittedAnswerKey`：必须是已提交、属于同一活动、同一题、同一内容版本的作答才返回答案，材料版本变化时拒绝。泄题面很小。
- 一键配置在一个事务里完成，`(workspace_id, quick_setup_key)` 唯一索引保证幂等，密钥不回读。
- 模型转写：每段发送前都检查隐私 epoch 和材料排除，FFmpeg 错误不外露，分段标记 `needs_check`。
- S8：`outcome_unknown` 回合只在 60 秒后允许用户主动重问，不自动重发，不改原结果。
- 派生卡片受材料隐私约束（`cardReadable`），备份恢复不能抹掉卡片来源。
- 评价器接口 `rules-1` 完全复用现有判定，没有另起评分。

## 3. 需要修的问题（按优先级）

### R1 高：结束今天的学习后，当天无法再开始新的学习
- **现象：** Today「开始学习」用 `clientKey = today-topic:<日期>`（`apps/web/src/features/opening/teaching/today-activity.ts:148`）。活动结束后状态变为 `completed`，不再算可继续的活动，按钮又显示「开始学习」；但点击后仓库按同一个 clientKey **重放出那个已结束的活动**（`packages/database/src/repositories/opening-teaching-activities.ts` 的 create replay），页面只显示小结，学不了新内容。`task:<taskId>` 同理：一个任务学完一次后不能再学。
- **修法：** 小结卡增加「再学一节」，用确定性的链式 key 创建新活动：`${上一个活动的 clientKey}:next:${上一个活动 id}`。同一个按钮重复点击仍然幂等，又不会撞回已结束的活动。Today 的「开始学习」在发现当天 `today-topic` 活动已结束时走同样的链式 key。
- **验收：** 单测覆盖「结束 → 开始学习 → 得到新活动 id」；重复点击得到同一个新活动。

### R2 高：Gemini 转写超过约 7 分钟的音频必然失败
- **原因：** 切片 600 秒、16 kHz 16-bit 单声道 ≈ 19.2 MB，base64 后约 25.6 MB（`apps/worker/src/parsers/model-transcribe-adapter.ts:9-12`）。Gemini 内联请求总大小上限 20 MB（含 base64 后的文件、提示词），超出返回 413。
- **修法：** 切片改为 300 秒（约 9.6 MB 原始 / 12.8 MB base64）；按 **base64 长度 + 提示词** 校验不超过 18 MB；`classifyProviderFailure` 把 413 归为「请求未被处理」（可 release，不 markUnknown），文案「音频分段过大」。
- **验收：** 单测：20 分钟音频切成 4 段，每段 base64 < 18 MB；413 映射为 release。

### R3 中高：课程归档或材料不可用时，卡片复习会整体失败
- **原因：** `gradeCard` 对有 `course_id` 的卡片在同一事务里建 session 并写 observation。`createOpeningLearningSessionInTx` 遇到已归档课程抛 `NOT_FOUND`，`admitLearningSources` 遇到材料重新解析中或已删除抛 `VALIDATION`，整次评分回滚，SRS 也不前进。
- **修法：** 写账本前显式检查课程未归档、来源都可准入；不满足时**只保存 SRS 结果**，在返回值里标出 `evidence: "skipped_course_archived" | "skipped_source_unavailable"`，界面提示「这次复习没有计入学习记录」。不要用 catch 吞错。
- **验收：** 集成：归档课程的卡片可以正常评分、SRS 状态前进、不写 observation。

### R4 中：卡片「提示后作答」被记成独立完成
- **原因：** `cards-grade.ts` 写 observation 时 `assistance` 固定为 `"independent"`，忽略了 `input.assisted`。这会让以后的 BKT 把有提示的复习当成独立表现。
- **修法：** `assisted === true` 时记 `"hinted"`。
- **验收：** 集成：assisted 评分产生 `assistance = hinted` 的 observation。

### R5 中：一键配置免费模型会把已有的日额度清零
- **原因：** `quick-setup-service.ts` 在 `free_tier` 时把整份 `ai_settings` 换成默认值并写 `dailyCapCents: 0`、`budgetConfirmedAt: null`。工作区原来配好的按量模型（例如 Lant）会因此变成 `budget_disabled`；原有的用途映射和转写引擎也被清空。
- **修法：** 免费额度时保留原有 `dailyCapCents`、`budgetConfirmedAt`；按量计费时只覆盖额度相关字段。默认模型切到新模型这一点保持不变，但保留 `taskRoutes` 里用户指定的备用模型和 `transcription` 设置（新模型成为默认后它们仍有效）。
- **验收：** handler：已有 Lant + 确认额度的工作区，一键配置 Gemini 免费模型后 Lant 仍为 `available`。

### R6 中：「结束本次学习」不可撤销，却没有确认
- `activity-end-control.tsx` 点一下就把活动设为 `completed`，之后不能再作答、不能重开。R1 修好之后影响变小，但仍建议加一次确认（「结束后本节不能再作答，可以再学一节」）。

### R7 中：一个集成测试的迁移清单过期
- `tests/integration/identity-migration-compatibility.test.ts` 第 173、271、625 行附近的三处 `applied` 期望只列到 `0060`，实际已有 `0061–0064`，本地 Postgres 上必然失败。补上四个文件名即可（交接任务书只点名了另外两处迁移清单测试，漏了这一处）。

### R8 低：连通性测试用客户端传来的 key 当全局账本键
- `model-probe-service.ts` 的 `operationId: probe:${clientKey}`。预算表的 `request_id` 是**全库唯一**，建议改为 `probe:${workspaceId}:${modelId}:${clientKey}`，避免跨工作区撞键报 CONFLICT。

### R9 低：转写时间戳过严、部分完成后重试必失败
- 模型给的 `endMs` 略超出切片时长就让整段转写失败；建议允许 ≤ 2 秒误差并截断。
- 一个任务前几段已结算、后面失败时，重试会在第一段命中「已结算但结果未保存」而失败。建议每段结果先持久化（按 `transcribe:<jobId>:<段号>` 存），重试只补缺失段。

### R10 低（质量）：作答记录的技能名默认取活动意图文本
- `inline-attempt.tsx` 的技能默认值是 `context.intentSummary`（如「今日主题学习：xx」），同一知识点会被拆成很多技能名，复测和以后 BKT 的数据都会碎。建议默认用当前大纲条目标题；课程有知识图谱时优先用节点。估计器输入里 `firstAttempt` 目前恒为 `null`，接 BKT 前需要补。

## 4. 下一步建议（按顺序）

### 第 1 步：修复批次（约 1 天）
R1–R5、R7 一个提交批次，R6、R8 顺手做；R9、R10 可以放到第 4 步之后。先修再部署，否则第一次自用就会撞上 R1，用 Gemini 转写会撞上 R2。

### 第 2 步：部署 Hermes（从 `8b500e6` 升级）
1. 先做数据库备份（`docs/operations/opening-backup-manifest.md`）。
2. 部署后执行 `npm run db:migrate`，会应用 0061–0064；回滚语句在各迁移文件末尾，0062 回滚前要先处理免费额度模型和 0 元预算记录。
3. `/opt/aistudy/.env.production`（web 与 worker 相同）：
   - `OPENING_TEACHING_COMPILER_ENABLED=1`（主讲用真实模型）；`OPENING_TEACHING_VALIDATION_ENABLED` 先保持 0，内容会显示「待核对」。
   - `OPENING_ADAPTIVE_PLANNING` 保持 0，直到第 4 步完成。
   - 换上新的 Lant key。
4. 在 Hermes 上 `curl -I https://generativelanguage.googleapis.com` 确认能连；连不上就不要配 Gemini。
5. 重启 web 和 worker，`/api/health` 返回 ok。

### 第 3 步：你来做浏览器验收 + 3 天真实使用
按这条路径走一遍，问题记到 `docs/STATUS.md` 的「使用反馈」：
1. 设置 → 一键配置模型（Lant 或 Gemini）→ 测试连接。
2. 课程页「设为今日计划」→ Today「开始此项」→ 等主讲内容生成 → 看内容质量（是否贴合材料、公式是否正确显示）。
3. 主讲里做「试一试」→ 提交 → 看参考答案 → 选「我答对了/我答错了」。
4. 「结束本次学习」→ 看小结 → 选择是否标记任务完成 →（R1 修复后）「再学一节」。
5. 答错的题两天后是否出现在复测建议里；从错题做一张卡片并复习一次。

需要记录的数字：主讲编译成功率、「待核对」比例、每次编译花费、你觉得内容可用的比例。这些决定第 5 步是否要开校验、要不要换模型。

### 第 4 步：让计划跟着学习情况变（PR #43 的 L2–L8）
目前证据已经能进账本，但每日计划还不会因此改变（只有复测会进入计划）：`OPENING_ADAPTIVE_PLANNING` 的数据层和规则纯函数已在主干，读取学习信号的快照服务、自适应每日草案、接受建议、教练自动确认与撤销、Today 档位界面、课程目标编辑、闭环指标接口都还没有。按 [`2026-10-15-adaptive-learning-loop-v2.md`](2026-10-15-adaptive-learning-loop-v2.md) 的 L2、L3（跨包、并发，建议 Claude 做）→ L4、L6、L8（任务卡已写好，可交 GPT/Grok）。之前本地的 WIP 提交 `bd201d7` 如果还在，先推上来再接着做。这一步完成后，「学 → 测 → 记 → 计划调整」才真正闭合。

### 第 5 步：首次启动与安全（STATUS 的 B、C）
- C 安全两项很小，可以和第 4 步并行：`/api/opening/health` 加鉴权或只返回粗粒度状态；`deploy-hermes.sh` 去掉保存的 root 密码和跳过主机指纹。
- B 对话式首次启动：等第 3 步的使用反馈再定细节。

### 暂缓
E2 AI 判分、L7 规划 Agent、BKT 影子运行：等至少两周的真实使用数据。到时先补 R10（技能身份、首次作答）再接 BKT。
