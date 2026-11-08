# 已合 PR 的 P2 与非阻塞跟进索引（2026-11-08）

## 范围与结论

本次核对基线为 `0a45858a825f7b7f48ad0cf3164932f373ee7eb0`（#300 合入）。核对时本地 `origin/integration/opening` 与工作分支 HEAD 均为该提交，`git merge-base --is-ancestor 0a45858a origin/integration/opening` 返回 0；未执行 fetch。以下是该时点的记录，不代表后续远端状态。

本索引核对的 #293/#297/#300 已合问题中，原评审明确标 P2 的项目均已有修复；本次定点检查未复现这些旧失败。未找到同时满足“原评审明确标 P2、当前仍存在、在本卡允许路径内”的新增修复项，因此本卡仅新增本索引，不制造代码改动。**索引完成不等于所有跟进完成**；未合 PR、原 owner 专修和待产品决定的建议仍保留各自状态，不阻塞无依赖的既有卡。

## 原始凭据、现状与精确路径（8 项）

| 项 | 原始凭据与分级 | 当前核对／复现结论 | 精确路径与处理归属 |
| --- | --- | --- | --- |
| 1 | #300 [GPT 原评审 5817869551](https://github.com/Xhhemoing/study-assistant-opening/pull/300#pullrequestreview-5817869551)：**P2**，新用户文案含禁用技术词，required CI lint 失败 | `5352726e18b0f50273aac48c3347c91fe3992c5c` 已将旧词改为“帮助记录”，未改变 schema 校验。当前 strict learner-copy 检查为 0 findings，旧失败未复现 | `apps/web/src/features/opening/exam-sprint/client-schemas.ts:66`；本卡不重复修改 |
| 2 | #293 [GPT 原评审 6720736763](https://github.com/Xhhemoing/study-assistant-opening/pull/293#issuecomment-6720736763)：**P2**，新增 useRouter 导致 workspace 测试宿主失败 | 当前已有稳定 router mock，真实 workspace 挂载断言普通／复测静态导航、零 resume/create 与零内容挂载；该文件本次 unit 通过，旧宿主失败未复现 | `apps/web/src/features/opening/courses/course-study-workspace.test.tsx`；本卡不重复修改 |
| 3 | #297 [GPT 审查 6720811625](https://github.com/Xhhemoing/study-assistant-opening/pull/297#issuecomment-6720811625)、[合入记录 6720929485](https://github.com/Xhhemoing/study-assistant-opening/pull/297#issuecomment-6720929485)：**P2/H**，批改 head 与 replay 混合快照误冲突 | `1a7e987160e87fa652eeb2f3d15373aa2a5b0366` 已由同一 SQL 语句读取 current head 与 existing grade；真实 PG 屏障覆盖并发重放和人工更正先赢。该 suite 本次通过，旧误冲突未复现。原 Opus 建议显式增加暂停时 existing_grade 为 null 的断言未标 P2，不据此另造修复 | `packages/database/src/repositories/opening-ai-grading-context.ts:66–74`；`tests/integration/opening-ai-grading-repository.test.ts:108–180`。不改评分、资格或并发保护 |
| 4 | #293 [Opus 定向复核 6721658026](https://github.com/Xhhemoing/study-assistant-opening/pull/293#issuecomment-6721658026)：**非阻塞建议，未标 P2**，补回续接链强断言 | 已由 `b94c7dc186c57cc333fd4df8a8184720835bf09d` 补回 root 未来 updated_at、paused 后继、仿冒 next key 干扰、显式旧 root 拒绝。当前真实 PG suite 通过，不再是缺失断言 | `tests/integration/opening-sprint-task-targets.test.ts` 的 `restores the real persisted continuation after completing a section without completing its task`；不重复 patch |
| 5 | #295 [Opus 观察 5817633958](https://github.com/Xhhemoing/study-assistant-opening/pull/295#pullrequestreview-5817633958)：**非阻塞，未标 P2**，overview/challenge 下只更新其他偏好仍选择 self-* 步骤 | 原 owner 已在 #301 专修；本次读取 PR 元数据时 #301 为 open/unmerged。本卡不重新复现或修改其候选，不将其记为已合解决 | `packages/database/src/repositories/opening-span-tutor-context.ts`；#301 的近邻回归在 `apps/worker/src/runtime/span-tutor-next-action.test.ts`、`tests/integration/opening-span-tutor-context.test.ts`、`tests/integration/opening-span-tutor-next.test.ts` |
| 6 | #302 [GPT 评审 6722732225](https://github.com/Xhhemoing/study-assistant-opening/pull/302#issuecomment-6722732225)：**P2 非阻塞**，减三分钟可能跨 UTC 日界 | #302 在本次元数据核对时为 open/unmerged；目标文件不在本基线。仅保留原评审触发条件：UTC 当日最初三分钟内，减三分钟落到前一天。**本卡未运行候选复现，待合后再核**；后继应约束 fixture 到同一 UTC 日期，不 skip 或削弱断言 | `tests/integration/opening-m5-joint-acceptance.test.ts:240,255–258,267`（行号绑定 #302 head `6bdce74317a16f32652cc5c9c791138517621df5`）；本卡不修改未合代码 |
| 7 | #302 [同一 GPT 评审](https://github.com/Xhhemoing/study-assistant-opening/pull/302#issuecomment-6722732225)：非阻塞覆盖跟进，archive/resume 使用满预算场景 | 原评审认为已覆盖 accepted history 保留，但 spare-capacity suggestion suppression 仍待补；不是已证明的产品失败。**未合、未复现，待合后列入后继核对**，不把补索引等同补齐验交 | `tests/integration/opening-m5-joint-acceptance.test.ts:156–164`（同一 #302 head）；不提前修改 |
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

## 交回边界

本卡为 **L（仅文档）**，仅授权 commit，不 push、不自行开 PR／合入／部署。主机侧接手 push/PR；独立 GPT 由入口派发，唯一集成者仍须核对精确 head required CI 全绿，L 的指定 Opus 后补审义务不取消。独立审查、required CI、合入及用户浏览器验收未在本卡完成；#301/#302 后继仍保留待办事实，不启动新的全盘审查循环。
