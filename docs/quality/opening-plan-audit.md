# 全项目计划核验：开学版主线与长期研究边界

状态：**审查待确认，未修复、未发布**。基线：`feat/opening-release`，HEAD `0d9d287bb8210c7af10a9c1df87145242f972372`。

结论：**结构检查通过；当前计划仍有语义缺口，不应直接冻结全部接口或宣称算法/性能已验证。** 可继续 F01 安全基座；F02 先解决下列契约问题。高级算法研究不阻塞确定性基础功能。

标记：`[V]` 本轮直接核对/执行；`[C]` 文档或行为相互冲突；`[H]` 推断/建议；`[T]` 等待证据。文档中写了门禁不等于门禁已通过。

## 1. 覆盖范围与证据

| ID | 范围/动作 | 本轮证据及限制 |
|---|---|---|
| E01 | 当前开学版计划 | 总计划、规格、11 份 00–08 子计划、interfaces、traceability、27 项 tasks 与既有证据；三路只读审查，主线程复核关键结论 |
| E02 | 整体方向/历史计划 | PRD、ARCHITECTURE、TODO、EXECUTION_PLAN、旧问题总账、算法地图与研究索引；历史计划做目录/状态/相关段落核对，不声称逐行验证所有旧任务 |
| E03 | 算法/运行边界 | 抽查 domain assessment/planning/srs/practice；worker、provider、迁移/备份、CI 由只读审查定位。不是全源码安全审计 |
| E04 | 计划结构 | `node scripts/validate-opening-plan.mjs`：`Plan structure: PASS (27 tasks, acyclic dependencies, plan/evidence files present)`；`Ready tasks: F01, F02` |
| E05 | 工具回归 | `node --test tests/tooling/install-registry.test.mjs tests/tooling/opening-plan.test.mjs`：`tests 6 / pass 6 / fail 0` |
| E06 | 当前代码回归 | `bash scripts/run-heavy.sh node node_modules/vitest/vitest.mjs run --project unit --project contract`：`Test Files 114 passed (114)`；`Tests 515 passed (515)`；`Duration 76.71s` |
| E07 | 算法反例 | 第 4 节命令实际执行，观察到 4 个边界反例；不是修复测试通过，也不证明生产路径均可触达 |

执行环境：Windows/Git Bash、Node `v24.18.0`、npm `11.16.0`。E06 提示 `flock unavailable; running without cross-process locking.`，本轮重型检查未并行。完整运行日志在临时 `/tmp/opening-plan-audit-vitest.log`，不是长期交付附件。

审查前 `tasks.json` 仅 B00–B02 为 verified，其余 24 项 planned；这是记录状态，不是本轮重跑了安装/类型/构建。本轮未改这些状态。

**未执行**：数据库/handler/Redis/S3 集成、构建/lint/typecheck、手机真机、真实模型/费用、解析器样本和恢复演练。原因：本轮计划审查仅新增文档；F01 保护尚未实现，未配置经授权的隔离服务、样本和付费连接。不读取 `.env`、不访问生产、不调用付费模型。

## 2. 跨模块发现与最小计划修正

以下相对路径以 `docs/superpowers/plans/opening-release/` 为起点；均在 E01 核对。严重度表示**计划决策风险**，不是已经发生的数据事故。所有条目仍 Open。

### PA-01 / 高：承诺的用户动作尚未形成闭合契约 [C]

- 证据：`interfaces.md:91–93,139–156`、`04-memory.md:31,39`、`06-planning.md:38,51`、`07-experience.md:50,71`。
- 记忆需要纠正文本和选择 `deleteSourceText`，但 `MemoryDecision` 仅 confirm/reject/delete，没有新文本或删除选项；服务删除返回 receipt，通用 decision 却返回 MemoryItem，响应语义未对齐。
- 计划 UI 要 reject；任务更新要求版本，但 TaskItem 没有 version，具体更新/拒绝契约未列出。材料归属提供纠正，但 `courseId` 只是 membership 读取投影，没有确认/撤销关联 API 的负责任务。
- `interfaces.md:154` 已明确要求 F02 补齐附加 Zod 类型，不能说“完全没有规划”；问题是请求/响应、版本、幂等、错误、所有权及测试没有逐路由冻结。
- 最小修正：F02 建立 endpoint→schema→service→owner→negative test 矩阵；DATA 定义记忆更正/删除回执、task version、plan reject、source membership 确认。**阻塞 F02 冻结及对应消费者，不需 Grok。**

### PA-02 / 高：解析 outbox 的创建时机前后冲突 [C]

- 证据：`01-foundation.md:81` 写“Source create + parse-job outbox”；`02-ingestion.md:29–30` 写完成对象校验、转不可变原件后才写 parse outbox。
- 若 beginUpload 创建 source 时就派发，worker 可能处理尚未上传/未校验的文件；两处都派发也有重复语义风险。当前实现尚不存在，不能断言已发生。
- 最小修正：F03 保留 source/job/outbox schema、持久化与事务原语责任；I01 的成功 complete 是 parse job 业务记录的唯一创建点，唯一键包含 source/version/kind；pending/rejected 禁止解析。测试“签发后不完成”“重复 complete”“校验失败”行数与状态。**阻塞 F03/I01 交接，不需 Grok。**

### PA-03 / 高：学习摘要函数没有足够输入实现待复习规则 [C]

- 证据：`05-learning.md:39,50–52`；`interfaces.md:98–113`。
- `summarizeObservations(observations,now)` 要按“已接受且到期重测”产生 needs_review，但 observation 不含 retest 的 accepted/due/completed 信息；相同作答历史、不同重测状态无法被该纯函数区分。
- 最小修正：显式传入版本化 retest 状态，或由 read-service 合成；确定已完成/取消、多个候选、修正作答、重复证据的优先级。P02 明确 accepted retest→task 的集成步骤与 owner。**阻塞 L02 摘要规则验收，不需 Grok。** L03 的依赖完成门禁随之未满足，但不必停止独立的 client/网络错误测试准备。

### PA-04 / 高：删除要求与备份 journal 的表达能力不匹配 [C]

- 证据：`04-memory.md:39,51–53`、`08-delivery.md:71`。
- M02 要删除记忆、可选对话正文并排除派生内容；journal 只有 `{sourceId,deletedAt}`。无附件对话也能产生记忆，不能假定每条待删除 memory/turn 都有可替代它的 sourceId。
- 最小修正：明确 workspace、实体类型/ID、删除范围、epoch、来源/派生排除的版本化语义；不得在 journal 保存删除正文。保持当前 journal 在 restore 覆盖集之外。
- 验收：无附件记忆、保留正文但禁止再提炼、删除正文、派生缓存、旧备份逐类重放；最终写入与 epoch 比较同事务。**阻塞 M02/Q03 隐私验收。** 外部保留政策交 R07，内部契约不等待调研。

### PA-05 / 高：备份有 manifest 目标，但一致快照/删除协调协议未定 [H]

- 证据：`08-delivery.md:71,76`；旧 `packages/database/src/repositories/backup-dump.ts:30–94` 分别读取多张表，不能替代新对象存储备份协议。
- DB snapshot 不能自动冻结 S3 删除。导出期间有对象被删或引用变化时，可能得到无法完整恢复的包；仅列 hash 不足以排除这一窗口。
- 最小修正：一致 DB snapshot＋不可变对象版本 manifest；备份期间对象保留/租约或缺失即失败协议；明确删除 journal 在新机恢复时如何取得最新版本，journal 缺失 fail-closed。
- 验收：导出期间更新/删除、对象缺失、恢复时 journal 比备份新；恢复只在全部核验后可见。补 RPO/RTO 与空命名空间演练。**阻塞 Q03，不阻塞 UI。**

### PA-06 / 高：恢复方向正确，仍缺可执行 crash-window 协议 [H]

- 证据：`02-ingestion.md:71–73` 已有 deterministic ID、CAS、heartbeat、stale reconciliation，不能报告为“没有幂等设计”。
- 缺少“入队成功但 dispatch 未落库”“dispatch 已落库而 Redis 丢失”“旧执行者失去 lease 后晚写入”的明确状态转移/重发/隔离规则。
- 最小修正：I03 固定 lease/claim token、过期与重发判定、有限重试/死信；不能只依赖 Redis jobId 的短期去重。逐个窗口故障注入，断言最终一个业务结果、无永久 stranded job。
- **阻塞 I03 恢复验收**；可参考 R06 官方文档，但本地故障注入不可由文献替代。

### PA-07 / 高：性能“有记录”但缺判定标准，列表和上下文仍可能无界 [V/H]

- 证据：`08-delivery.md:63–65` 只要求记录 latency/cost；`interfaces.md:139–146` 列表返回全数组，无 cursor/limit；`03-tutor.md:38,50–51` context 用 maxCharacters。对照 `docs/architecture/ARCHITECTURE.md:128` 要求列表分页。
- 文件大小限制、并发数和费用上限不能代替 backlog、DB pool、RSS、长会话/历史列表上限；字符上限也不是供应商 token/图像费用上限。
- 最小修正：F02 补有界分页；T01/T02 定义总输入 token/图像成本上限；I03 规定准入、队列满的可重试错误、低优先任务让路；Q02/Q03 固定负载、资源配置和通过阈值。建议测量协议见研究清单第 3 节。
- **阻塞“高效可用”的验收声明**；先有界实现，不必等向量检索、调度优化研究。

### PA-08 / 高：照片辅导尚缺显式多模态贯通验收 [T]

- 证据：`02-ingestion.md:50` 允许 OCR 不可用时图像供 vision；`interfaces.md:23–27,49–52` 有 imageObjectKey，但未定义授权图像如何进入 ProviderInput 的实际传输；T02 明确优先文本/关键词。
- imageObjectKey 的存在不证明 provider 能看到图像，保存原件也不证明可辅导。需要限定支持模态、尺寸/页数、供应商图像输入、来源标记和成本；无法读取必须明确拒绝，不让模型猜负号/矩阵。
- 最小修正：I02/T01/T02 增加同一张无 OCR 公式图片的端到端测试和人工标注；音频“原件保存”和“转写”分开验收。**阻塞照片辅导承诺，不阻塞原件存取。** R01/R02 提供选型依据。

### PA-09 / 中：共享文件的并行冲突未体现在任务图 [V/H]

- 证据：`04-memory.md:38` 与 `05-learning.md:17` 都修改 tutor-turn.ts；M02/L01 同依赖 M01，可以并行。M02 还写将由后续 Q03 创建的 backup adapter。
- F01→U01 修改 middleware 已有依赖，不能把它当成并行冲突；真正需解决的是无顺序的共享写入及“先修改后创建”。
- 最小修正：明确共享文件由集成者应用 patch 或增文件级串行交接；M02 定义 backup privacy 接口，Q03 创建适配器，避免人为加入反向依赖形成环。**限制对应并行派工/合并方式，不是功能依赖错误，也不阻塞独立叶任务。**

### PA-10 / 中：长期平台计划与开学版状态入口没有明确对接 [C]

- 证据：`TODO.md:9–14,31–39`、`docs/roadmap/EXECUTION_PLAN.md:3` 仍指向旧路线；`docs/product/PRD.md:118–135` P0 广于开学版五项。
- 最新规格已经明确独立开学范围，不能把所有旧 P0 都强加为本版缺项；缺的是 release profile 与 AIST 旧问题→新任务映射。
- 最小修正：保留历史，说明本分支以 opening spec/master/tasks 为状态来源；笔记/市场/导出投影/离线等分别标“本版不承诺/已有但未复验/后续”。不得从 opening 局部通过推导整个 AIstudy 完成。**阻塞验收口径，不需要 Grok 替用户选范围。**

费用补充：`interfaces.md:77–79`、`03-tutor.md:31–32` 已有 requestKey、未知结果保留预留、先对账或人工重试。不是“未知请求会自动重试”的已知漏洞；待 T01/R02 明确真实供应商幂等能力、对账权限、价格版本/币种、unknown 处理和告警，不得按超时盲目释放费用预留。

## 3. 算法和长期扩展判断

| 板块 | 可保留的基线 | 未被证明的部分 / 决策门 |
|---|---|---|
| 材料检索 | 授权/版本过滤＋当前文件优先＋有界关键词 | R01/R03：公式、跨语言、扫描课件召回；不是引用 ID 存在就语义正确 |
| 学习状态 | 独立/帮助/未知分开，观察不等于掌握 | R04：参考答案核验、延迟重测、选择偏差；不能从上传难题推断整门课 |
| SRS | 固定规则 O(1) 单卡更新；到期排序 O(n log n) | R05：FSRS 只研究记忆保持，不替代理解/迁移诊断；开学版两天重测是启发式 |
| 每日计划 | 硬时间块排除＋稳定排序＋装不下明确列出 | 新 planDay 尚未实现，不能给实测速率；朴素任务×空档扫描 O(nm)，需要负载上限而非立即引入求解器 |
| 记忆/对话 | 来源表、确认/过期、有限上下文 | R07：纠正后实际改变后续回答、删除不复活、no-save 全数据流；存了记忆不等于正确个性化 |
| 长期平台 | 统一资产、模块化单体、确定性事件/版本、显式降级 | 复杂 BKT/IRT/DKT、bandit、GraphRAG、图数据库、CRDT、连接器/市场均保持后续门；不以论文榜单替代自身负载/收益证据 |

复杂度是源码/候选算法分析，不是性能测试。旧 planner 多目标 options 分支还存在 `reserved.some` 的嵌套扫描，不能把整个领域统一宣传为 O(n log n)。

## 4. 已复现的旧算法复用风险 [V，E07]

| 反例 | 实际输出 | 根因 / 开学版处理 |
|---|---|---|
| A | budget=30，total=70 | `packages/domain/src/planning/planner.ts:57–66,114–129` 无条件保留 60 分钟 locked 加 10 分钟探索；P02 应显式报硬约束不可行，不静默挤占 |
| B | budgets=30,10，totals=20,0，sameSnapshot=true | 同文件 `150–154` 快照不包含预算等排程输入；新 P02 应保存规范化完整输入及依赖版本，不能直接沿用此 ID 作并发依据 |
| C | allCorrect=true，仍 repeated-error-cause | `packages/domain/src/assessment/status-rules.ts:81–85` 只数 errorCause，不检查 correct；须限定错误证据或拒绝矛盾输入 |
| D | 无 timed 字段仍 timed-unstable | 同文件 `75–79` 只看 errorCause=time；是错因启发式，不足以声称经过真实限时测量 |

以下在仓库根运行可复现；断言确认的是**当前不理想行为**，不是目标回归测试。未改业务代码，故无“修复/同命令修复后复测”记录；进入实现时先把期望性质写成失败测试，再修正并复测。

```bash
node --import tsx --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { buildTodayPlan } from './packages/domain/src/planning/planner.ts';
import { deriveStatus } from './packages/domain/src/assessment/status.ts';
const base={ownerUserId:'audit',date:'2026-09-12',budgetMinutes:30,scenario:'final',points:[],dueReviews:[],lockedTasks:[]};
const locked={id:'locked',kind:'practice',refId:'p',title:'locked',estimatedMinutes:60,reason:'user',locked:true,status:'pending'};
const overflow=buildTodayPlan({...base,lockedTasks:[locked],protectedExplorationMinutes:10});
assert.equal(overflow.totalMinutes,70);
console.log(`PROBE-A budget=${overflow.budgetMinutes} total=${overflow.totalMinutes}`);
const point={pointId:'p',title:'p',status:'weak',estimatedMinutes:20,practiceItemId:'i'};
const a=buildTodayPlan({...base,points:[point]});
const b=buildTodayPlan({...base,budgetMinutes:10,points:[point]});
assert.equal(a.evidenceSnapshotId,b.evidenceSnapshotId); assert.notEqual(a.totalMinutes,b.totalMinutes);
console.log(`PROBE-B budgets=30,10 totals=${a.totalMinutes},${b.totalMinutes} sameSnapshot=${a.evidenceSnapshotId===b.evidenceSnapshotId}`);
const events=Array.from({length:3},(_,i)=>({correct:true,assisted:false,hintCount:0,confidence:4,slice:'recognition',occurredAt:`2026-09-12T0${i}:00:00Z`,source:'attempt',errorCause:'concept'}));
const c=deriveStatus('p',events,new Date('2026-09-12T04:00:00Z'));
assert.ok(c.reasonCodes.includes('repeated-error-cause'));
console.log(`PROBE-C allCorrect=true reasons=${c.reasonCodes.join(',')}`);
const d=deriveStatus('p',events.map(e=>({...e,errorCause:'time'})),new Date('2026-09-12T04:00:00Z'));
assert.ok(d.reasonCodes.includes('timed-unstable'));
console.log(`PROBE-D noTimedField=true reasons=${d.reasonCodes.join(',')}`);
JS
```

复核剔除/降级：没有采用“重排选项必然判错”的初步结论，因字面答案和字母答案语义不同，未完成 UI/判题路径证明；没有把旧 stable 规则当成已校准预测；没有把正确设计但未实现的 epoch 防护报成已发生泄漏。

## 5. 推进与验收

1. INTEGRATOR/DATA 先修 PA-01–04、PA-09 的契约和交接；更新 interfaces/对应子计划/tasks/traceability 后重跑 E04/E05，语义仍需人工核对。
2. 并行继续 F01 和不依赖待研结论的离线纯规则；R01/R02/R06/R07 是靠近当前交付的研究，R03/R04 次之，R05/R08 不阻塞基础版。
3. 用 [Grok 研究与本地实验清单](opening-plan-research-backlog.md) 冻结验收数据和资源预算；文献结果只能将条目标为“已调研”，不能标 verified。
4. 发布仍依 Q03→Q01→Q02：隔离服务故障测试、恢复、真实 API 浏览器、真实材料/模型和真机；付费/生产操作另行授权。PR/CI 附日志、数据集版本、失败清单与实际人工验收记录，不能仅有 agent 总结。
5. 本轮只新增审查/研究文档并登记研究索引；未修改实现、迁移、任务状态、已批准产品范围，未提交 Git。无数据库回滚动作；后续迁移仍依原计划备份及回滚门禁。

图谱边界：开始时 `graphify-out/` 仅有 cache，没有 graph.json/wiki，无法执行基于已有图的 query；本轮源码定位用 rg/read。结束执行一次 `timeout 90s graphify update .`，退出 **124**：753/753 个未缓存文件 AST 扫描完成，但未在时限内结束；另报告 6 个配置文件零节点、16 个 SQL 文件因缺 `tree_sitter_sql` 未入图。缺 SQL 依赖只能解释 SQL 覆盖不足，不能确认为超时根因；超时暂怀疑发生在后续聚合/输出阶段，未定位。未安装依赖、未修复、未盲目重跑，不将图谱刷新报告为通过。

文档反向复核：另一路 reviewer 核对了 PA-02/03/04/09，确认核心风险，并促使本报告明确 F03 持久化责任、L02 与 L03 阻塞边界及文件级串行交接；复核者未独立重跑 E04–E07，不把其意见当第二份运行证据。
