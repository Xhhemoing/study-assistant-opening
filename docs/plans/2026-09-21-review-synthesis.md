# 2026-09-21 审查综合：计划更新依据

基线：`feat/opening-release` @ `8d616c0`（两份 PI 审查基线一致）；工作区另有未提交的恢复切片（pending-job discovery、R15/R17 等）。

本文记录两份 PI 审查（《AIstudy Opening 项目重新审查》《核心判断：产品方向核查》）中**经代码核实成立**的工程判断如何落到任务账本，以及产品方向建议如何进入后续计划。**审查是静态分析，不是运行验收**；文中"风险"需对应任务的运行证据闭环，不把审查推断写成已复现缺陷。

## 一、审查工程判断 → 代码核实 → 任务落点

| 审查判断 | 代码核实结果 | 落点 |
|---|---|---|
| P0：隐私排除只过滤当前轮材料，`loadTutorHistory` 不查 `opening_privacy_exclusions`，删除记忆后旧问答可经历史回到模型上下文 | 成立：`opening-tutor-history.ts` 的 invalid 判定只查 `opening_sources` 存在/upload_state/版本，无隐私表关联 | **RP1**（DATA） |
| P0：worker 模型返回后查 epoch，但 `completeTurn()` 事务内不校验预期 epoch、不锁工作区行；存在"查完 7→删除提交 8→写回"窗口 | 成立：`tutor-turn.ts:162` 先查 `assertCurrentEpoch`，`completeTurn` 事务（`opening-tutor-jobs.ts:172`）无 `expectedPrivacyEpoch` 参数 | **RP2**（DATA） |
| P0：`Composer` 每次提交生成新 `clientKey`，响应丢失后重试成为新逻辑请求 | 成立：`composer.tsx:43` `newClientKey()`；服务端 `(workspace_id, client_key)` 唯一索引与重放返回已存在但客户端不复用 key | **RP3**（DATA+EXPERIENCE） |
| P0：`activeJobId` 仅在组件状态，刷新后待完成轮次缺 job 关联 | 部分已修：未提交切片新增 owner-scoped pending-job 发现路由；RP3 收口恢复关联与 unknown 终态处理 | **RP3** |
| P0：CI 仅触发 PR 与 main push，开发主线 `feat/opening-release` push 无门禁，最新提交 0 check runs | 成立：`ci.yml` push branches 只有 main | **RP5**（INTEGRATOR） |
| 引用结构后端完整，前端 `message-model.ts` 压缩成 `citationLabels: string[]`，恢复路径引用标签为空 | 成立 | **RP4**（EXPERIENCE） |
| 今天页固定空状态，不读真实数据 | 成立：`today/page.tsx` 渲染 `EmptyState` | **RP6**（EXPERIENCE），与 G2 R2a 衔接 |
| 部署文档称 worker 是内存 smoke processor，实际已启动真实 BullMQ consumer | 成立：`docs/operations/cloud-deployment.md:76` 与 `apps/worker/src/index.ts` 不符 | Q03 文档更新 + 本次 README 修正 |
| `getDownloadUrl` 用当前版本，无被引用版本参数 | 成立：`source-service.ts:30` 硬编码 `source.version` | **RP4**（增加版本参数） |
| 记忆删除为状态删除，正文不清空 | 成立：`opening-memory.ts` `SET status='deleted'`，无正文擦除 | M02 删除语义发布（沿用） |
| 检索会装入零分候选、超预算整块被跳过 | 成立：`selectContext` 无分数下限，`continue` 跳过超长块 | T02 验收补充（gold set 见 G5 R18，不作首版门槛） |
| 帮助曝光按模式记 hinted/revealed，不证明实际未泄露/用户已理解 | 成立：`tutor-turn.ts` mode→level 映射 | L01/L02 验收措辞修正（三层次区分） |
| Provider 仅 text_only，契约含图片对象键 | 成立：`provider.ts:92` 拒绝非 text_only | U03/V01 文案分层（保存/提取/理解三级） |
| 无项目级 LICENSE | 成立（根目录核查） | X01 验收补充 + Q03 发布清单 |

## 二、账本变更

新增 6 项修复任务（全部 `planned`，不改写既有验证状态；任务数 37→43）：

| ID | 交付 | 依赖 | 说明 |
|---|---|---|---|
| RP1 | 模型上下文统一隐私准入 | M02 | 历史加载关联隐私排除表；chunks/历史共用同一排除查询；fetch 断言验证实际发出输入 |
| RP2 | completeTurn 隐私版本原子写回 | M02 | 事务内 `FOR UPDATE` 锁工作区行+校验 epoch，漂移即整体回滚；模型调用留在事务外 |
| RP3 | 发送幂等收口与刷新恢复 | T03 | clientKey 绑定逻辑发送可复用；intent_hash 冲突 409；恢复关联 jobId；三故障场景验收 |
| RP4 | 引用证据展示与按版本查看 | T03 | 视图模型保留完整 Citation；按 sourceVersion 打开；版本不一致明确提示 |
| RP5 | 开发分支 push CI 门禁 | B02 | push 触发加 feat/opening-release + workflow_dispatch；镜像可拉取验证；SHA 绑定发布证据 |
| RP6 | 今天页真实恢复入口 | T03,U01 | 首屏三问（上次停在/现在做什么/待确认）；真实数据五态；R2a 先行子集 |

里程碑调整（M 定义不变，门槛补充）：

- **M2** 门槛 = M01–M03 **＋ RP1＋RP2**（隐私准入与原子写回是记忆启用前置，审查定级 P0）。
- **M1** 跨端恢复验收增加 RP3 三个故障注入场景（响应丢失重试、生成中刷新、结果未知重进）。
- **M3** 今天页：RP6 最小恢复入口先行，完整 R2a/R2c 恢复卡随 G2。
- **RP4** 并入 U03 体验门禁（引用可点可查是"有来源辅导"的兑现）；**RP5** 为发布证据前置（release-readiness）。

## 三、产品方向建议 → 现有计划衔接（不新增任务，不重开范围）

审查第二份报告的五项创造性方向，逐项映射到既有任务/G 门禁，避免范围蔓延：

1. **恢复卡深化为"学习断点"**：即设计稿创新一/R2c（已前移至 G2）。审查补充的"已有尝试/已提供帮助/尚未确认"分层与 L01 帮助曝光、L02 可解释状态共用证据模型，实现时读取同一 exposure/observation 记录，不新建"学习经历平台"。
2. **最小诊断动作**：并入创新二（证据型微学习闭环）作为追问策略验收——每次追问需回答"消除哪类不确定性"；尊重 hint/explain/listen 模式约束。不新增 Agent 框架。
3. **资料变更影响提醒**：依赖 RP4（引用按版本可核验）与 CitationIdentity（13.2）；来源更新≠能力变化的两类变化区分写入 K01 增量更新验收。G5 之后，不作首版门槛。
4. **方法经验记忆**：M01/M03 验收补充"适用范围＋证据＋反例"表达约束；一次成功不固化教学策略，普通学习事件不逐条确认。删除语义发布沿用创新三定稿。
5. **计划器做减法**：P02/P04 已有"现实约束下最小推进"方向；审查场景（20 分钟替代三任务、保留锁定休息）作为 P04 验收用例补充，不提前开发。

审查强调的三层组织关系（资料目录/知识结构/学习证据分离）与既有 membership 原则、K01 范围一致，无需改任务图；"课程→章节→资料夹→材料条目"层级如需落地，属 C01/K01 之后的增量，当前不新增任务。

## 四、验收纪律（沿用并强调）

- 删除与写回并发测试（RP2）、provider 输入断言（RP1）必须在隔离库运行；CI 门禁（RP5）以实际 run 链接为证。
- 最小学习价值实验（L01/L02 窄切片）按 G2/G3 节奏提前于完整视觉治理；验收区分自评/核对/未知，不虚构掌握率。
- 学习效果声明需独立新题与延迟重测证据；辅助表现≠独立表现。
- 本文件与任务账本的一致性由 `node scripts/validate-opening-plan.mjs` 与 tooling tests 保障。

## 五、未采纳/暂缓

- 审查建议的"统一上下文准入检查"抽象层：不新建独立模块，RP1 用同一 repository 查询达成单一规则来源。
- 大规模检索改造（向量/BM25/rerank）：维持 R18 定位（G5+，gold set 先行）。
- 课程多层组织落地：暂不新增任务，见第三节第 3 点后段。
- 部署文档全面重写：纳入 Q03；本次仅修正 worker 事实性错误与 README 入口。
