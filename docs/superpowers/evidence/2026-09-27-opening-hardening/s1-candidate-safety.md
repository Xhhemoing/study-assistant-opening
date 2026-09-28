# S1：候选安全基础（实现中，未验证）

计划：[learning-continuity-implementation.md](../../plans/2026-09-27-learning-continuity-implementation.md#s1正确审核可靠重试与继续入口)。

## 执行边界

用户先要求“跳过测试，继续按照计划推进”，本片当时未运行验证；继续推进时改为补齐非浏览器验证（浏览器验收按 AGENTS 分工留待用户）。以下为本片实际执行的检查，全部在 `feat/opening-release` 工作区、HEAD `5154078` 上运行，隔离服务为 `scripts/opening-e2e/services.ps1` 管理的 15432/16379/19000。

| 检查 | 结果 |
| --- | --- |
| `vitest --project contract` | 4 文件通过、1 跳过；19 通过 / 12 跳过 / 1 todo，含新增 candidate-review 契约用例 |
| `vitest --project unit`（contracts/opening + repositories 全目录） | 25 文件、136/136，含本片 2 个新测试文件（20 项） |
| 仅本片新测试（candidate-review + retest-task 模拟） | 2 文件、20/20 |
| `tsc -p packages/contracts` / `-p packages/database` | 均 exit 0 |
| ESLint（本片全部触及文件） | exit 0 |
| integration（真实隔离 DB `aistudy_opening_test`，OPENING_TEST_DB=1） | 新增 opening-assistant-task-candidate 6 项 + 既有 retest-task-bridge 4 项 = 10/10 |
| integration 回归（memory candidate + replay） | 2 文件、12/12 |
| handler opening-plans | 1 文件、6/6 |

其中 `prepareRetestTask` 的锁后重放行为是受控模拟证据；真实 PostgreSQL 双连接并发验证仍属后续验收，不因上述结果提前关闭。集成运行中 migration 的 NOTICE（对象已存在时跳过）为幂等迁移的预期输出，非失败。

随后观察到根目录及 `apps/web/AGENTS.md` 已更新浏览器验收分工：浏览器由用户负责，不阻塞后续开发，Agent 维护实现与必要非浏览器检查。本轮仍遵守跳过测试指示，没有重新启动验证循环。用户对 AGENTS 的改动未被覆盖。

本片仅运行窄范围 `git diff --check`（exit 0）和 `graphify update .`（exit 0，AST-only）。Graphify 报 SQL parser 未安装、部分文件零节点等警告；生成图不进入提交，图更新不代表业务验证。验证期间曾由本次重启流程遗留孤儿 MinIO（19000）与清单损坏的 Redis（16379）；经命令行/启动时间核对确属本次自有隔离实例后恢复清单并继续，未触碰其他进程。

## 本片改动

- `packages/contracts/src/opening/candidate-review.ts`：新增计划中的 CandidateRef / ReviewResult Zod 契约，身份由 origin、kind、id 联合表达；由 `opening/index.ts` 导出。
- `packages/contracts/src/opening/planning-tasks.ts`：从超过 200 行的 `planning.ts` 提取任务契约，原导出路径兼容。`candidateRef` 对旧客户端可选；若提供，必须与 candidateId、任务/补测来源匹配，记忆候选不能送任务命令。补测快照不能在 candidateId 为空或不同的情况下通过。
- `packages/database/src/repositories/opening-retest-task.ts`：助理候选的原子 UPDATE 限定 payload.kind=task 与 conversation owner；旧请求没有 candidateRef 也受检查。保持候选消费与任务插入同一事务。
- 同一文件抽出重放查找；首次查重后获得候选行锁，再查一次相同 clientKey/意图，先返回已创建任务，再判断 accepted。保留原 retestPayloadHash 算法，不新增 hash。缺失 taskId 返回 NOT_FOUND，不发送空 UUID 查询。
- `packages/database/src/repositories/opening-candidates.ts`：普通 decide 与 listPending 一样校验会话 owner，避免只依据 workspaceId 改状态。

## 已补但未运行的回归用例

- `packages/contracts/src/opening/candidate-review.test.ts`：三类身份、错源/错型/错 ID、旧客户端兼容、补测快照缺失或不匹配、结果引用。
- `packages/database/src/repositories/opening-retest-task.test.ts`：受控模拟首次查重为空、锁后已有结果；同 key 变意图、不同 key 已处理、丢失结果引用。此用例不冒充真实数据库并发证据。
- `tests/integration/opening-assistant-task-candidate.test.ts`：真实 DB 的正常消费、memory 误送任务、同 workspace 错 owner、跨 workspace、助理 ID 误送 retest，以及 generic decide 越权拒绝。尚未执行。

## 明确未完成

1. today-read 中现有错误 API 跳转仍待审核页面切片替换；本片未将链接指向一个尚不存在的页面。
2. 实际审核列表、三类接受/忽略 UI、修改项、产物链接、继续入口与待处理建议并列。
3. 助理任务决定的 clientKey、规范化意图、resultRef 持久化及备份往返；当前重复接受仍按旧行为冲突，未建立决定记录表。
4. 跨不同候选的同 key 并发仍需唯一约束、事务失败后回读与真实 PostgreSQL 双连接屏障验证；本片只覆盖同一候选锁等待窗口。
5. 当前来源/隐私准入复查与 memory 重放访问复查；本片没有削弱现有 memory 隐私流程。
6. A01–A08 / E01–E02 全链验收、handler/browser、Linux CI；S0 已知 Path C 产品接线缺口仍存在。

## 后续验收与回退

后续完成三类审核浏览器验收（用户执行）；Agent 补齐决定持久化、备份往返与真实 DB 并发后运行相应非浏览器验收，再按计划在含修复提交上运行 CI。上述 136/136、10/10 等结果只覆盖本片触及路径，不等于完整套件。隔离测试服务验证后保持运行以便下一片使用，结束时用 `services.ps1 stop` 停止。

本片没有数据库迁移或数据回填，不需要数据库回滚。若候选动作异常，优先禁用动作并保留 owner/type 校验，不回到错源写入。后续决定字段迁移须单独记录备份兼容和回滚方案。
