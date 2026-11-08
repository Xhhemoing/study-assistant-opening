# 已合 PR 的 P2 与非阻塞跟进索引（2026-11-08）

## 范围与结论

本次核对基线为 `0a45858a825f7b7f48ad0cf3164932f373ee7eb0`（#300 合入）。核对时本地 `origin/integration/opening` 与工作分支 HEAD 均为该提交，`git merge-base --is-ancestor 0a45858a origin/integration/opening` 返回 0；未执行 fetch。以下是该时点的记录，不代表后续远端状态。

本索引最初核对的 #293/#297/#300 已合问题中，原评审明确标 P2 的项目均已有修复；当时定点检查未复现这些旧失败，因此原文档提交仅新增本索引，已由 #307 合入。**索引完成不等于所有跟进完成**。后续获准基于精确 `0380748b4c1e9598c09b4bc31d73495717ac62fa`（已含 #302）续接，仅补第 6、7 项的测试与本文状态；其余原 owner 专修和待产品决定的建议保留原记录，不重复修复。

## 原始凭据、现状与精确路径（8 项）

| 项 | 原始凭据与分级 | 当前核对／复现结论 | 精确路径与处理归属 |
| --- | --- | --- | --- |
| 1 | #300 [GPT 原评审 5817869551](https://github.com/Xhhemoing/study-assistant-opening/pull/300#pullrequestreview-5817869551)：**P2**，新用户文案含禁用技术词，required CI lint 失败 | `5352726e18b0f50273aac48c3347c91fe3992c5c` 已将旧词改为“帮助记录”，未改变 schema 校验。当前 strict learner-copy 检查为 0 findings，旧失败未复现 | `apps/web/src/features/opening/exam-sprint/client-schemas.ts:66`；本卡不重复修改 |
| 2 | #293 [GPT 原评审 6720736763](https://github.com/Xhhemoing/study-assistant-opening/pull/293#issuecomment-6720736763)：**P2**，新增 useRouter 导致 workspace 测试宿主失败 | 当前已有稳定 router mock，真实 workspace 挂载断言普通／复测静态导航、零 resume/create 与零内容挂载；该文件本次 unit 通过，旧宿主失败未复现 | `apps/web/src/features/opening/courses/course-study-workspace.test.tsx`；本卡不重复修改 |
| 3 | #297 [GPT 审查 6720811625](https://github.com/Xhhemoing/study-assistant-opening/pull/297#issuecomment-6720811625)、[合入记录 6720929485](https://github.com/Xhhemoing/study-assistant-opening/pull/297#issuecomment-6720929485)：**P2/H**，批改 head 与 replay 混合快照误冲突 | `1a7e987160e87fa652eeb2f3d15373aa2a5b0366` 已由同一 SQL 语句读取 current head 与 existing grade；真实 PG 屏障覆盖并发重放和人工更正先赢。该 suite 本次通过，旧误冲突未复现。原 Opus 建议显式增加暂停时 existing_grade 为 null 的断言未标 P2，不据此另造修复 | `packages/database/src/repositories/opening-ai-grading-context.ts:66–74`；`tests/integration/opening-ai-grading-repository.test.ts:108–180`。不改评分、资格或并发保护 |
| 4 | #293 [Opus 定向复核 6721658026](https://github.com/Xhhemoing/study-assistant-opening/pull/293#issuecomment-6721658026)：**非阻塞建议，未标 P2**，补回续接链强断言 | 已由 `b94c7dc186c57cc333fd4df8a8184720835bf09d` 补回 root 未来 updated_at、paused 后继、仿冒 next key 干扰、显式旧 root 拒绝。当前真实 PG suite 通过，不再是缺失断言 | `tests/integration/opening-sprint-task-targets.test.ts` 的 `restores the real persisted continuation after completing a section without completing its task`；不重复 patch |
| 5 | #295 [Opus 观察 5817633958](https://github.com/Xhhemoing/study-assistant-opening/pull/295#pullrequestreview-5817633958)：**非阻塞，未标 P2**，overview/challenge 下只更新其他偏好仍选择 self-* 步骤 | 原 owner 已在 #301 专修；本次读取 PR 元数据时 #301 为 open/unmerged。本卡不重新复现或修改其候选，不将其记为已合解决 | `packages/database/src/repositories/opening-span-tutor-context.ts`；#301 的近邻回归在 `apps/worker/src/runtime/span-tutor-next-action.test.ts`、`tests/integration/opening-span-tutor-context.test.ts`、`tests/integration/opening-span-tutor-next.test.ts` |
| 6 | #302 [GPT 评审 6722732225](https://github.com/Xhhemoing/study-assistant-opening/pull/302#issuecomment-6722732225)：**P2 非阻塞**，减三分钟可能跨 UTC 日界 | #302 合入后续接：卡片会话开始点固定为实际 UTC 当日零点；注入的结束时钟最早为当日 00:03，保证至少三分钟且不退到前一天。保留真实 Date／PG event 时钟、原预算与停止时间校验，不 mock、skip 或降低原断言。真实 PG joint suite 通过；未在墙钟 UTC 午夜运行 | `tests/integration/opening-m5-joint-acceptance.test.ts` 的 `deduplicates multi-goal shared-card work and budget, but never copies its grade into course evidence`；仅 fixture 时间修正 |
| 7 | #302 [同一 GPT 评审](https://github.com/Xhhemoing/study-assistant-opening/pull/302#issuecomment-6722732225)：非阻塞覆盖跟进，archive/resume 使用满预算场景 | 新增真实仓储组合：60 分钟预算中已接受 20 分钟，始终余 40 分钟；确认 maintenance 候选真实存在，分别归档课程／目标时抑制、恢复后重现同一 requirement 候选。每步核对 accepted history、共同预算和任务数不变，未用满预算或无候选掩盖。真实 PG 通过；不是新发现的产品失败 | `tests/integration/opening-m5-joint-acceptance.test.ts` 的 `suppresses and restores real maintenance suggestions through course and goal archive/resume with spare capacity`；原全流程断言不变 |
| 8 | #294 [Opus 评审 5817609106](https://github.com/Xhhemoing/study-assistant-opening/pull/294#pullrequestreview-5817609106)：**非阻塞，未标 P2**，旧冲突提示仍称“重新诊断” | 当前源码第 384 行仍有该文本，可直接确认残留；它不是链接，不能据此宣称自动创建或生产故障。原评审明确要求 PM 另定，且与 #301 写集合重叠，因此本卡不修改、不擅自升为 P2 | `packages/database/src/repositories/opening-span-tutor-context.ts:384`；由 PM 协调原 owner，若改变行为须另走 H |

未合 #298 的 worker status-only 确认问题虽有明确 P2 评审，也不属于本卡“已合 PR”范围；未触及其候选。本索引不扩展到共享 AI compiler、compile wiring、route-compilation、route-read、course-route、membership/source API 或 0109/0110。不新增迁移、生产配置、评分资格、权限、隐私变更，也没有本次调查所得的生产 P0/P1 证据可支持 H 提案。

## 本次实际定点检查

检查的是上述基线代码；本卡新增内容仅为本文档，无代码 patch、无删断言、无 skip。依赖使用本工作区独立 `npm ci --prefer-offline --no-audit --no-fund`，exit 0。以下四项在同一次 `aistudy-local-test bash -c '…'` 中串行执行，wrapper exit 0，使用其一次性隔离 PostgreSQL 与合成 fixture，不访问生产或真实模型：

| 命令 | 结果 |
| --- | --- |
| `node scripts/check-learner-copy.mjs --strict` | exit 0；0 findings |
| `npm test -- --project unit apps/web/src/features/opening/courses/course-study-workspace.test.tsx apps/web/src/features/opening/exam-sprint/client.test.ts` | exit 0；2 文件、42 测试通过 |
| `npm run typecheck -w @aistudy/web` | exit 0；web 包类型检查 |
| `npm run test:integration -- tests/integration/opening-ai-grading-repository.test.ts tests/integration/opening-sprint-task-targets.test.ts` | exit 0；2 文件、34 测试通过 |

未执行全量 lint/types/tests/build、本地浏览器、真实模型或生产操作；unit 的 jsdom 挂载不等于用户浏览器验收。不把上述定点绿等同精确提交的 required CI 绿。

## #302 合入后的两项测试跟进检查

续接父提交为 `830a8c05e5fee22aa0e1700a270e407dc3e48225`，其普通 merge parents 为原文档 `a3fb82fcaddeeec600ad5be9d542ce79ea1b9c6a` 与获准 `0380748b4c1e9598c09b4bc31d73495717ac62fa`；未追加合并后续 integration。新增差分仅为上表第 6、7 项及本文状态，不重作 #293/#297/#300。

以下使用 `LC_ALL=C.utf8 HERMES_HEAVY_ENABLED=1 node scripts/run-heavy.mjs aistudy-local-test bash -c '…'`，在一次临时隔离 PG 中依次执行，wrapper exit 0：

| 顺序／命令 | 实际结果 |
| --- | --- |
| `npx vitest run --project integration tests/integration/opening-m5-joint-acceptance.test.ts` | exit 0；5/5，通过原四项与新增 spare-capacity 测试 |
| `psql` 查询并以 `DO` 断言 `learning_events` 全表为空 | exit 0；joint 后 0 行 |
| `npx vitest run --project integration tests/integration/opening-learning-history-backup.test.ts` | exit 0；8/8，与 joint 使用同一个 PG，顺序 joint → backup |
| 再次执行同一 `psql` 零事件断言 | exit 0；backup 后 0 行 |
| `npx tsc -p packages/database/tsconfig.json --noEmit` | exit 0 |
| `npx eslint tests/integration/opening-m5-joint-acceptance.test.ts` | exit 0 |

另经 run-heavy 对目标 joint 测试入口及其导入闭包执行 `tsc -p <临时配置> --noEmit`：继承 web tsconfig，仅 include 该测试，关闭 incremental；首次 exit 2，因系统临时目录下的配置未自动解析工作区 Node 类型。补充指向工作区 `node_modules/@types` 的 `typeRoots` 后复查 exit 0；没有修改仓库配置。这是定点测试入口类型检查，不冒称 web 全包或全仓 types 通过。

原卡片 fixture transaction rollback 与自身 events 比较保留，未删除 append-only events 或修改其 trigger；原评分、独立课程证据与全流程断言不变。未执行全量 lint/types/tests/build、UTC 午夜墙钟实验、本地浏览器、真实模型或生产操作；隔离测试库的既有迁移初始化不代表生产迁移授权。

## 交回边界

本次续接为 **L（仅测试与文档）**，仅授权 commit，不 push、不自行开 PR／合入／部署。两项代码跟进是待新 PR 的净增，不是重复开启已合 #307。主机侧接手 push/PR；独立 GPT 由入口派发，唯一集成者仍须核对精确 head required CI 全绿，L 的指定 Opus 后补审义务不取消。独立审查、required CI、新代码合入未在本卡完成；其余跟进仍保留各自未验边界，不启动新的全盘审查循环。
