# 开学版代码任务总计划 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task; independent leaf tasks may use superpowers:subagent-driven-development after their contracts land. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在隔离分支交付手机/电脑可用的个人学习助理：材料、辅导、记忆、学习证据和协商计划形成真实闭环。

**Architecture:** 复用AIstudy的认证、workspace、契约和数据库基础；保留Next.js + TypeScript模块化单体、独立worker。首版新增明确的opening API/client，正式入口只读服务器数据，不为赶时间完整重写旧StudyDataProvider的所有探索功能；旧Mock页面在opening模式不可成为正式入口。

**Tech Stack:** Next.js 15.5.21、React 19.1.9、TypeScript 5.8.3、PostgreSQL、Drizzle、BullMQ/Redis、S3兼容存储、Vitest、Playwright；新增库须锁版本和许可证。

## Global Constraints

- 已批准规格：`../specs/2026-09-12-opening-release-design.md`。
- 工作区：`E:/Project/study-assistant-opening`；分支`feat/opening-release`；起点`e7639c9930bf230185551c86ea825e2524c40a39`。
- 原工作区只读；不搬入未提交的0016迁移和goals/plan-state文件，不自动合并或push。
- 单用户使用，但所有对象仍按workspace/owner验证；无公开注册、无自行扩大采集。
- 所有新代码文件≤200行；既有大文件不继续堆业务，不做无关重构。
- domain纯函数不得依赖HTTP/DB；AI调用只在AI边界；所有SQL/迁移只由database负责。
- UI仅Tailwind，lucide-react图标；加载/空态/失败/重试必须可见；移动端优先；不编造掌握百分比。
- 重要安排、稳定个人事实经确认；临时状态有过期；倾诉不自动变待办；不保存模式不持久化对话正文。
- 测试用fake模型不能成为产品兜底。无真实连接显示未配置；付费调用默认关闭。
- 生产/用户数据库禁止用于测试。DB测试必须同时校验独立测试URL、数据库名和显式测试标志。
- Windows npm嵌套bash脚本使用当前调用级script-shell：`npm --script-shell="$(cygpath -w "$(command -v bash)")" run <script>`；不提交机器绝对路径配置。
- 不承诺完美或确定工期；用可验收切片、真实证据、回滚和范围控制降低失败风险。

---

## 1. 任务分配：27项，6个逻辑职责

以下是代码所有权角色，不代表已启动27个agent。主线程负责调度和验收；不会虚构评审员或签字。

| 角色 | 所有权 | 禁止事项 |
|---|---|---|
| INTEGRATOR | 基线、共享契约出口、运行时组装、迁移编号、最终集成 | 不用全量暂存或覆盖原工作区 |
| DATA | schema/repository、所有权、事务、并发、隐私删除 | 不写UI或模型提示；不修改历史迁移 |
| PIPELINE | 上传、解析、outbox/worker、存储适配 | 不直接接受客户端owner或任意URL |
| AI | provider、预算、材料引用、对话和记忆建议 | 不直接写正式计划或赋予工具任意权限 |
| EXPERIENCE | 纯学习/计划规则与移动端界面，分别按任务分文件 | 不伪造数据填充产品页面 |
| QA | 独立验收案例、故障注入、浏览器与恢复证据 | 不能只复述实现者结论 |

| ID | 负责人 | 交付 | 依赖 | 子计划 |
|---|---|---|---|---|
| B00 | INTEGRATOR | 可复现依赖安装 | 无 | 00-baseline.md |
| B01 | INTEGRATOR | 既有lint问题与基线类型检查 | B00 | 00-quality-baseline.md |
| B02 | INTEGRATOR | 浏览器/Node备份边界 | B01 | 00-browser-boundary.md |
| F01 | INTEGRATOR | 测试环境保护、owner初始化、注册关闭 | B02 | 01-foundation.md |
| F02 | INTEGRATOR | opening共享契约和接口冻结 | B02 | 01-foundation.md |
| F03 | DATA | sources/jobs/outbox与测试fixtures | F01,F02 | 01-foundation.md |
| I01 | PIPELINE | 私有上传、完成确认和读取 | F03 | 02-ingestion.md |
| I02 | PIPELINE | 文档解析适配与音频保存 | I01 | 02-ingestion.md |
| I03 | PIPELINE | 持久队列、重试与恢复 | F03 | 02-ingestion.md |
| T01 | AI | 真实模型适配和预算账本 | F03 | 03-tutor.md |
| T02 | AI | 有来源的上下文检索 | I02,T01 | 03-tutor.md |
| T03 | AI+DATA | 对话、材料辅导和状态API | T02,I03 | 03-tutor.md |
| M01 | AI+DATA | 记忆候选、确认、过期与纠正 | T03 | 04-memory.md |
| M02 | DATA | 删除与后台重建竞态防护 | M01 | 04-memory.md |
| M03 | AI | 倾听与不保存会话 | T03,M02 | 04-memory.md |
| L01 | DATA | 纸面作答、帮助曝光与证据 | T03,M01 | 05-learning.md |
| L02 | EXPERIENCE | 可解释状态和延迟重测 | L01 | 05-learning.md |
| L03 | EXPERIENCE | 服务端学习读模型与Mock隔离 | L02 | 05-learning.md |
| P01 | EXPERIENCE | 分周课表、时间约束 | F02 | 06-planning.md |
| P02 | DATA+EXPERIENCE | 任务与版本化协商计划 | P01,F03,L01 | 06-planning.md |
| P03 | PIPELINE | 到期队列、提醒状态 | P02,I03 | 06-planning.md |
| U01 | EXPERIENCE | 今天/助理/课程移动端壳 | F02,F01 | 07-experience.md |
| U02 | EXPERIENCE | 上传、原件和处理状态 | I01,I02,U01 | 07-experience.md |
| U03 | EXPERIENCE | 对话/记忆/卡点/计划真实交互 | T03,M03,L03,P03,U02 | 07-experience.md |
| Q01 | QA | 鉴权、并发、失败与删除集成 | U03,Q03 | 08-delivery.md |
| Q02 | QA | 浏览器、手机和最终样本验收 | Q01 | 08-delivery.md |
| Q03 | INTEGRATOR+QA | 打包、恢复与运行监督能力 | P03,M02 | 08-delivery.md |

## 2. 可并行的边界与交接

- F02契约定型之前，不并行写消费方接口。变更F02由INTEGRATOR合并，任务作者不能擅改字段。
- F03后可并行I01/I03/T01；P01与U01只依赖已冻结契约，可并行。
- T03后可分开做记忆、学习和计划；数据库迁移始终由DATA按顺序合入。
- 预留迁移：0016 sources/jobs/outbox/budget，0017 conversations，0018 memories/privacy，0019 paper learning，0020 timetable/plans/reminders。若基线迁移变化，先修任务清单，不复用已发布号。
- 所有`package.json`、lockfile、包index、vitest配置、全局导航、migration注册由INTEGRATOR单写；子任务提交变更清单而非抢写。
- 禁止多个agent同时修改同一工作树中的同一文件；并行代码任务使用独立分支/工作树再集成。

## 3. 每个任务统一执行闭环

1. 阅读本任务、`opening-release/interfaces.md`、相关AGENTS与既有实现。
2. 增加具体失败测试，运行并确认失败原因与需求有关。
3. 完成最小实现；不把后续任务功能提前塞入本任务。
4. 同命令复测，然后typecheck、相关lint；涉及UI需可见状态证据。
5. 复核权限、边界、实际费用、失败路径；展示文件diff和输出。
6. 窄范围本地提交；更新`opening-release/tasks.json`的状态、证据、阻塞项。没有通过的门禁不得记done。

任务状态：planned -> active -> verified；需要真实环境而未验证则blocked，不把“代码写完”改名verified。
`verified`只证明任务中列出的门禁，不自动证明生产交付。B00/B01/B02状态应由实际日志更新，不照抄研究阶段513个测试。

## 4. 里程碑与降级规则

- **M0：基线可信** = B00-B02 + F01-F03。无安全持久化不堆功能。
- **M1：能提交材料并求助** = I01-I03 + T01-T03 + U01-U02。必须是真实链路；没有模型配置明确显示不可用。
- **M2：会记住、能重测** = M01-M03 + L01-L03。隐私删除是长期记忆启用门禁。
- **M3：每天用得起来** = P01-P03 + U03。协商确认、失败状态与移动端流程完整。
- **M4：可交付** = 先Q03打包/恢复实现，再Q01集成，再Q02最终验收。真实材料/模型/手机的结果单列，不能用fake测试替代。

时间不足先暂缓自动转写、外部推送、复杂检索和视觉细节；不得悄悄取消五项核心范围。核心范围仍不能达到时必须明确报告缺口，不把demo称为开学版。

## 5. 监督与审批

普通实现、离线测试、本地修复、文档与本地提交已获继续授权。以下需确认/配置：付费模型调用预算和密钥、生产部署/生产数据迁移、购买服务、公开开放、扩大采集范围、改变产品范围。

不等待密钥而停全部开发：provider用明确标识的测试适配，接口与失败流程可验；真实效果任务保持blocked。不会在会话结束后声称仍有后台agent自动监督。

## 6. 当前证据入口

- `../evidence/2026-09-12-opening-release/baseline.md`：安装、lint、类型、构建与测试的实际结果。
- `opening-release/tasks.json`：任务依赖与状态。
- 各子计划：准确文件、接口、测试样例和执行步骤。
- 计划自检脚本：`scripts/validate-opening-plan.mjs`（仅校验任务引用/依赖/覆盖，不证明代码正确）。
