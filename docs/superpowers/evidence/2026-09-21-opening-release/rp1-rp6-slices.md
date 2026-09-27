# RP1/RP2/RP4/RP6 证据：审查修复项落地

日期：2026-09-21（延续 23:5x–次日 00:1x 工作）
基线：`HEAD=8d616c0` ＋ 工作区未提交恢复切片
执行：主会话（集成者）＋ cursor-grok-worker 两个实现 run；主会话逐条复核 diff 并重跑全部命令

## RP1 统一隐私准入（DATA）

- 变更：`loadTutorHistory` invalid 判定增加两类隐私关联——历史/本轮 `source_ids` 命中 `opening_privacy_exclusions`，或历史 assistant `citations.sourceId` 命中排除，即整组历史置空（与既有"任一引用失效则全部丢弃"保守策略同路径，未新建第二套过滤规则）。
- 测试：`tests/integration/opening-tutor-history.test.ts` 新增 `clears derived history when a referenced source is privacy-excluded`；RED（1 failed/3 passed）→ GREEN（4 passed）。`beforeEach` 增加 `TRUNCATE opening_privacy_exclusions`。
- 主会话复跑：`OPENING_TEST_DB=1 ... vitest run --project integration tests/integration/opening-tutor-history.test.ts` → 4 passed。

## RP2 隐私版本原子写回（DATA）

- 变更：`completeTurn` 事务第一步 `SELECT privacy_epoch FROM workspaces WHERE id=$1 FOR UPDATE`（与 `deleteMemory` 同一锁顺序），`expectedPrivacyEpoch` 不一致即抛 "privacy epoch drift" 整体回滚；`undefined` 仍执行行锁仅跳过数值校验。worker 将 `jobEpoch` 传入。
- 测试：fakeSql 单测（locked epoch=8 vs expected=7 → reject 且不执行写回）+ worker 参数断言；RED（2 failed/31 passed）→ GREEN（33 passed）。集成层新增 drift 回滚用例后 `opening-tutor-turn.test.ts` 18 passed。
- 主会话复跑：unit 33/33；integration 26/26（turn+history+privacy 三文件）；typecheck database/worker exit 0。
- 未覆盖：真实双连接并发重叠（删除事务与写回事务同时在途）未模拟；覆盖的是"epoch 已漂移后写回被拒并整体回滚"。

## RP4 引用证据展示（EXPERIENCE，视图模型切片）

- 变更：`ChatMessageView` 增加 `citations: Citation[]`；`messagesFromTurns` 直出 `turn.citations`；`messagesFromResume` 以类型安全 extras 读取（契约缺口见下）；`message-list` 在有引用时 label 旁显示 `v{sourceVersion}`。
- 测试：RED（3 failed/19 passed）→ GREEN（22 passed）；`npm run typecheck -w @aistudy/web` exit 0；主会话复跑 assistant+today-read 31/31。
- **契约缺口（阻塞 RP4 完全闭环）**：`ConversationResume.boundedHistory` 契约是 `{role, text}`（`providerHistoryMessageSchema`），恢复路径拿不到 citations。需扩展 resume 契约或恢复时改走 `TurnRecord[]`，记入 RP4 后续。
- **接线缺口**：`getDownloadUrl` 版本参数未做（避免与未提交恢复切片同改 `source-service.ts`），任务书已起草见 Notes。

## RP6 今天页恢复入口（EXPERIENCE，读模型切片）

- 变更：`today-read.ts` 纯函数五态分类（loggedOut/error/confirm/continue/empty，优先级 confirm>continue、error>empty/continue、loggedOut>error）；`today/page.tsx` 改为五态框架，空输入渲染真实空态，不编造数据。
- 测试：9 passed（五态+优先级）；typecheck web exit 0。
- **接线缺口**：页面用空输入；接入真实数据可用既有读路径（`/api/auth/me`、`/api/opening/conversations`、`/api/opening/candidates`、`/api/opening/today`）；`/opening/assistant` 未读 `?conversation=` 参数，继续链接暂不能定位会话。

## RP5 CI 门禁（INTEGRATOR）

见同目录 `rp5-ci-gate.md`：push 触发加 `feat/opening-release`＋`workflow_dispatch`；minio 镜像修正为 `bitnamilegacy/minio:2025.4.22-debian-12-r2`（Docker Hub API 验证存在）；compose 迁至 `quay.io/minio/*`（manifest 验证存在）。**push 后实际 run 结果 pending。**

## 环境修复（阻塞所有集成测试的前置）

见 `env-vitest-crlf.md`：`.gitattributes` 增加 `*.mjs text eol=lf`，修复 Vitest 4 对 shebang+CRLF 的 `vm.Script` 求值失败；worktree `../study-assistant-opening-rp12` 使用后已移除。

## 账本状态

RP1–RP6 在 tasks.json 中仍为 `planned`：代码已落地且上述门禁通过，但按纪律由集成者在合并树复跑完整门禁后才更新状态与 evidence 引用；本轮不把"局部 PASS"记为 verified。

## 2026-09-22 收口

- RP3：客户端 `nextClientKey` 复用未确认意图；服务端 `intent_hash` 冲突返回 409；pending job 恢复与 `outcome_unknown` 文案已在工作区。复跑 unit 37/37（source/message/assistant/tutor service）、integration tutor-turn 18/18、handler opening-tutor 6/6。
- RP4 接线：`getDownloadUrl(principal, id, version?)` 校验版本范围与对象存在，返回 `versionMismatch`；下载路由接受 `?version=`，非法版本 422。
- RP6 接线：今天页服务端读取最近会话摘要；401 为未登录，其他异常为读取失败。助理页把 `?conversation=` 传给 `initialConversationId`。待确认计数仍未接入。
