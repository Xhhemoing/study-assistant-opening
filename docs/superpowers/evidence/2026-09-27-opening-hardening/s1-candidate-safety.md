# S1：审核闭环与候选安全（本轮实现和定向检查完成，待用户浏览器验收）

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

随后观察到根目录及 `apps/web/AGENTS.md` 已更新浏览器验收分工：浏览器由用户负责，不阻塞后续开发，Agent 维护实现与必要非浏览器检查。以下部分沿用当时跳过测试阶段的工作记录；后来补充的实际非浏览器结果以上表为准，不再将对应用例标记为未运行。用户对 AGENTS 的改动未被覆盖。

本片仅运行窄范围 `git diff --check`（exit 0）和 `graphify update .`（exit 0，AST-only）。Graphify 报 SQL parser 未安装、部分文件零节点等警告；生成图不进入提交，图更新不代表业务验证。验证期间曾由本次重启流程遗留孤儿 MinIO（19000）与清单损坏的 Redis（16379）；经命令行/启动时间核对确属本次自有隔离实例后恢复清单并继续，未触碰其他进程。

## 本片改动

- `packages/contracts/src/opening/candidate-review.ts`：新增计划中的 CandidateRef / ReviewResult Zod 契约，身份由 origin、kind、id 联合表达；由 `opening/index.ts` 导出。
- `packages/contracts/src/opening/planning-tasks.ts`：从超过 200 行的 `planning.ts` 提取任务契约，原导出路径兼容。`candidateRef` 对旧客户端可选；若提供，必须与 candidateId、任务/补测来源匹配，记忆候选不能送任务命令。补测快照不能在 candidateId 为空或不同的情况下通过。
- `packages/database/src/repositories/opening-retest-task.ts`：助理候选的原子 UPDATE 限定 payload.kind=task 与 conversation owner；旧请求没有 candidateRef 也受检查。保持候选消费与任务插入同一事务。
- 同一文件抽出重放查找；首次查重后获得候选行锁，再查一次相同 clientKey/意图，先返回已创建任务，再判断 accepted。保留原 retestPayloadHash 算法，不新增 hash。缺失 taskId 返回 NOT_FOUND，不发送空 UUID 查询。
- `packages/database/src/repositories/opening-candidates.ts`：普通 decide 与 listPending 一样校验会话 owner，避免只依据 workspaceId 改状态。

## 已补充的回归用例（执行结果见上表）

- `packages/contracts/src/opening/candidate-review.test.ts`：三类身份、错源/错型/错 ID、旧客户端兼容、补测快照缺失或不匹配、结果引用。
- `packages/database/src/repositories/opening-retest-task.test.ts`：受控模拟首次查重为空、锁后已有结果；同 key 变意图、不同 key 已处理、丢失结果引用。此用例不冒充真实数据库并发证据。
- `tests/integration/opening-assistant-task-candidate.test.ts`：真实 DB 的正常消费、memory 误送任务、同 workspace 错 owner、跨 workspace、助理 ID 误送 retest，以及 generic decide 越权拒绝；历史执行结果见上表，不代表本轮重新运行。

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

## 2026-09-28：S1-A 助理任务接受与可靠重试

本阶段在当前工作区完成服务端增量，独立只读代码审查未发现可确认的实质缺陷；不将其记为整个 S1 或相关原任务全部完成。

- 候选记录持久化接受 clientKey、规范化意图和任务引用；相同请求重试返回原任务，改变意图冲突，不同 key 不重复创建。
- 通过候选行锁与 workspace/key 唯一约束处理真实并发；唯一冲突后在事务外读取已完成结果，不新增通用 hash。
- 重放前检查当前 owner、来源/隐私准入和结果可访问性，不复活已删除或不可访问产物。
- 迁移 `0027_opening_assistant_task_acceptance.sql` 新增三个可空列及部分唯一索引；旧客户端保留平铺任务响应，新审核结果字段可选；备份显式列及新旧备份往返同步覆盖。

本轮实际结果：定向 unit **27/27**、integration **50/50**（含真实双连接竞态、来源准入和新旧备份往返）、handler **15/15**；contracts/database/web 类型检查、新增测试定向编译、定向 ESLint、diff 检查通过。范围仅为本片定向路径，未运行全量、浏览器或远端 CI，交付角色没有重复执行这些检查。

修复过程：新增回归首先重现跨候选同 key 重复创建及原请求无法重放；补持久化与事务处理后相关检查通过。类型检查曾发现新响应类型未从统一入口导出，补导出后复查通过。Handler 首轮因测试启动配置启用发布模式而拒绝注册夹具，调整隔离测试配置后 15 项通过，生产规则未改。测试夹具中的状态、owner 唯一性和 JSON 编码问题已在相应检查中修复复查。

回退：先回退应用行为，可以保留新增可空列和索引；若必须移除，先停用接受入口并导出决定记录，再以前向迁移处理，保留正式任务和候选已接受状态。没有生产迁移、提交、推送或部署。复用已有隔离服务，没有更改其生命周期。

后续：S1-B 审核页面、三类建议接线以及 Today 继续入口并列正在实施；完整 S1 的其余要求与用户实际检验仍待完成。上文初始未完成清单中的助理接受持久化/并发/备份部分由本节更新，记忆与补测其他路径不由本次结果代替。

## 2026-09-28：S1-B 审核页面与 Today 继续入口

本轮补齐 `/opening/review` 的助理任务、记忆、补测三类候选列表及正确接受/忽略路径，提供允许修改的字段和产物链接；Today 同时显示继续项与待审核建议。读取失败不显示伪空状态，补测来源按真实类型标注，异步任务渲染后执行目标定位。记忆正文、补测内容和建议时间在本页只读，接受补测不会自动安排日历。

独立审查发现通用 `/api/opening/tasks` 可绕过补测专用入口的成功状态与当前来源准入。新增 6 个直接入口反例首先复现错误返回 201；修复将准入收敛到共享仓储事务中，在候选锁与重放/插入路径执行，并移除专用服务外层重复预检。接受与忽略使用同一候选锁；原请求可重放，但失去当前准入后拒绝返回旧任务。另修复读取失败误显示空任务、无材料补测误标对话来源及异步任务定位三项前端问题。

实际检查（最新修复后）：handler `opening-review` **13/13**、`opening-retest-accept` **3/3**；integration `opening-review-retest-race` **2/2**（真实双连接）、`opening-retest-task-bridge` **4/4**；受影响仓储/Today/来源/读取 unit **24/24**；Database/Web 类型检查、定向 ESLint、diff 检查通过。此前前端 46 项、API 5 项及 S1-A 未变化检查沿用既有结果，不将重叠检查数字累计冒充新用例。

代码审查角色原先两次仅回复确认，不计为审查。S1-B 前后端独立补审给出上述具体问题，原前端审查者复核三项修复后无新增确定缺陷；重建的代码审查 v2 实际读取通用/专用调用链、共享准入和事务路径，确认后端修复范围未发现可确认缺陷。S1-A 追加核对了隐私删除与接受的工作区锁顺序，未发现确定问题。审查结论不代替运行检查或用户实际使用。

用户浏览器交接：登录同一工作区，准备助理任务、助理记忆、补测三类待审数据；从 `/opening/today` 进入 `/opening/review`，修改允许字段并接受/忽略，检查原请求失败重试和产物链接；回到 Today 核对继续入口与建议数、读取失败提示，以及目标任务实际滚动/焦点。**待用户浏览器验收**，未运行浏览器、全量套件或 Linux CI，不把完整 S1/原任务账本升级为全部验收完成。

本片无新增迁移，未修改 0027，未提交/推送/部署。回退页面或动作时继续保留共享 owner/type/来源准入及候选已处理状态，不恢复错源 API。S1-A 迁移回退说明继续有效。上文历史“明确未完成”中的审核 UI、并列入口与助理决定持久化等项，以本节及 S1-A 增量结果为准，其余缺口保持未完成。
