# 开学版代码任务总计划 Implementation Plan

> **2026-09-27 新版实施入口：**[学习连续性与证据可信度项目计划](2026-09-27-learning-continuity-implementation.md)及[验收附件](2026-09-27-learning-continuity-acceptance.md)整合两版优化报告与两轮审阅；本轮修复顺序及业务语义以新版为准。原 43 项任务账本、依赖和 CAP 扩展承诺保留，不因新增计划变更状态。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task; independent leaf tasks may use superpowers:subagent-driven-development after their contracts land. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在隔离分支交付手机/电脑可用的个人学习助理：先贯通材料、辅导、记忆、学习证据和协商计划，再覆盖学校自建邮箱/钉钉接入、音视频理解、课程知识结构与主动辅导安排。

**Architecture:** 复用AIstudy的认证、workspace、契约和数据库基础；保留Next.js + TypeScript模块化单体、独立worker。首版新增明确的opening API/client，正式入口只读服务器数据，不为赶时间完整重写旧StudyDataProvider的所有探索功能；旧Mock页面在opening模式不可成为正式入口。

**Tech Stack:** Next.js 15.5.21、React 19.1.9、TypeScript 5.8.3、PostgreSQL、Drizzle、BullMQ/Redis、S3兼容存储、Vitest、Playwright；新增库须锁版本和许可证。

## Global Constraints

- 已批准规格：`../specs/2026-09-12-opening-release-design.md`；2026-09-14用户要求补齐的能力范围见`../specs/2026-09-14-learning-capability-expansion.md`，与旧范围冲突时以补充为准。
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

当前质量修复与双Agent执行方式见 [质量修复与双Agent计划](../../plans/2026-09-18-quality-dual-agent.md)。T01–T03历史verified仅证明原记录中的局部门禁；材料传输/引用持久化修复需新增证据，历史上下文、每日预算与真实模型验收仍是独立待办，不能从旧状态推导发布完成。

## 1. 任务分配：43项，6个逻辑职责

以下是代码所有权角色，不代表已启动43个agent。主线程负责调度和验收；不会虚构评审员或签字。新增16项均是计划，不改写已有验证状态。其中RP1–RP6来自2026-09-21 PI审查（[审查综合文档](../../plans/2026-09-21-review-synthesis.md)），是既有实现的修复项，不改变M0–M5范围定义。

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
| Q01 | QA | 鉴权、并发、失败与删除集成 | U03,Q03,DL3,DL6,DL7,DL10 | 08-delivery.md |
| Q02 | QA | 浏览器、手机和最终样本验收 | Q01 | 08-delivery.md |
| Q03 | INTEGRATOR+QA | 打包、恢复与运行监督能力 | P03,M02 | 08-delivery.md |
| X01 | INTEGRATOR | 扩展契约与开源库制品核验 | F02 | 09-connections.md |
| C01 | DATA+PIPELINE | 连接授权、凭据、游标、来源与撤销 | X01,F03,M02,P02 | 09-connections.md |
| C01B | DATA+PIPELINE | 导入回执、游标与撤销收口 | X01,F03,M02,P02,C01 | 09-connections.md |
| C02 | PIPELINE | 学校自建邮箱IMAP增量同步及附件 | C01,I01,I03 | 09-connections.md |
| C03 | PIPELINE | 钉钉实际获准通知/文件接入 | C01,I01,I03 | 09-connections.md |
| V01 | PIPELINE | 录音转写、视频音轨/关键帧与时间引用 | X01,I02,I03 | 10-media-knowledge.md |
| K01 | AI+DATA | 课程知识结构生成、纠正与增量更新 | X01,C01,I02,T02 | 10-media-knowledge.md |
| K02a | EXPERIENCE+AI | 材料锚定辅导加深（thin slice；page cite + hint/explain） | L02,T03 | 10-media-knowledge.md |
| K02 | EXPERIENCE+AI+DATA | 技能证据、针对性辅导与重测反馈 | K01,K02a,L02,T03,DL3,DL6 | 10-media-knowledge.md |
| P04 | AI+EXPERIENCE | 多源事项归并及低选择负担的主动安排 | P04a,C02,C03,K02,P02,M01 | 11-proactive-acceptance.md |
| U04 | EXPERIENCE | 连接/知识/媒体/今日行动真实交互 | C02,C03,V01,K02,P04 | 11-proactive-acceptance.md |
| Q04 | QA+INTEGRATOR | CAP01–06真实验收及扩展隐私恢复 | U04,Q02 | 11-proactive-acceptance.md |
| RP1 | DATA | 模型上下文统一隐私准入（历史+材料） | M02 | 12-review-hardening.md |
| RP2 | DATA | completeTurn隐私版本原子写回 | M02 | 12-review-hardening.md |
| RP3 | DATA+EXPERIENCE | 发送幂等收口与刷新恢复 | T03 | 12-review-hardening.md |
| RP4 | EXPERIENCE | 引用证据展示与按版本查看 | T03 | 12-review-hardening.md |
| RP5 | INTEGRATOR | 开发分支push CI门禁 | B02 | 12-review-hardening.md |
| RP6 | EXPERIENCE | 今天页真实恢复入口 | T03,U01 | 12-review-hardening.md |
| RP7 | INTEGRATOR | 同SHA发布证据索引 | RP5 | 15-research-hardening.md |
| DL1 | EXPERIENCE | opening可达页去Mock收口（复习/练习入口、目标与指导模式） | L03,U03 | 13-daily-loop-gaps.md |
| DL2 | EXPERIENCE | 今天队列任务完成/跳过 | P02,RP6 | 13-daily-loop-gaps.md |
| DL3 | DATA+EXPERIENCE | 重测闭环：观察事务内入队（题干提示）、今天页接受/忽略、建议时间不早于、补测绑定retestId | L02,P02,DL2,DL5 | 13-daily-loop-gaps.md |
| DL4 | EXPERIENCE | opening记忆卡片接入真实cards/reviews API（核心闭环后的可选项） | DL1,U03,DL3,DL6 | 13-daily-loop-gaps.md |
| DL5 | DATA+EXPERIENCE | 今天队列快速添加任务（幂等，需迁移）与分组 | DL2 | 14-loop-closure.md |
| DL6 | EXPERIENCE+DATA | 练习判定可信化：参考自对照、帮助曝光自动带入、技能名复用 | L03,K02a | 14-loop-closure.md |
| DL7 | AI+DATA | AI就绪清单、设置内每日额度与未知预留对账 | T01,T03 | 14-loop-closure.md |
| DL8 | PIPELINE+AI | 照片材料作为视觉输入 | I02,T03 | 14-loop-closure.md |
| DL9 | EXPERIENCE+DATA | 课表导入、默认空闲时间与一键安排（需迁移） | P01,P02,DL5 | 14-loop-closure.md |
| P04a | EXPERIENCE+DATA | 每日自动草案：既有任务、到期补测、课表空闲与顺延 | DL2,DL3,DL9 | 14-loop-closure.md |
| DL10 | INTEGRATOR+QA | Windows本地端到端运行手册与只读就绪自检 | I03,T01 | 14-loop-closure.md |
| DL11 | DATA | day-planner earliest/notBefore | DL3 | 15-research-hardening.md |
| BC1 | AI+DATA | 预算门禁费用回执重试契约 | DL7 | 15-research-hardening.md |
| TZ01 | DATA+AI | 工作区时区日边界同一解释 | DL7 | 15-research-hardening.md |

## 2. 可并行的边界与交接

- F02契约定型之前，不并行写消费方接口。变更F02由INTEGRATOR合并，任务作者不能擅改字段。
- F03后可并行I01/I03/T01；P01与U01只依赖已冻结契约，可并行。
- T03后可并行准备记忆、学习和计划的独立契约/纯规则/测试；完整验收仍遵守tasks.json中的M01→L01→P02依赖。数据库迁移始终由DATA按顺序合入，迁移序号不阻止独立叶模块开发。
- 落盘迁移：0016 sources，0017 conversations，0018 jobs/outbox/budget，0019 paper learning，0020 source_chunks，0021 assistant_candidates，0022 memories/privacy（M01），0023 memory privacy epoch（M02，2026-09-20 协调者从0024改配——迁移加载器强制连续编号，禁止占位与例外）。P02 使用 0024 timetable/plans/reminders；当前工作区新增 0025 opening turn intent snapshot；本 H6 切片新增 0026 opening turn outcome unknown；未来预留：0027 connections/imports（C01），0028 knowledge（K01），0029 skill evidence（K02）。保留C01/P02、K01/C01、K02/K01的集成门禁；K02a 已按 thin-slice 证明仅依赖 L02+T03（见 docs/quality/2026-10-05-k02-deeptutor-fold-in.md）；若需拆分依赖，先证明契约/隐私/来源边界独立，再由集成者改任务图。不复用已发布号；新迁移编号一律由集成者分配，实现者不得自选。
- X01为F02旁的增量契约门禁，不重开或篡改F02已验证记录；C02/C03与V01可独立推进，钉钉实接权限不阻塞邮箱/媒体离线开发。扩展接口见`opening-release/capability-interfaces.md`。
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
- **M1：能提交材料并求助** = I01-I03 + T01-T03 + U01-U02 + U03薄聊天切片。必须验证真实适配器材料传输、引用保存、任务结果刷新及跨端恢复；API局部通过不等于用户闭环完成，没有模型配置明确显示不可用。
- **M2：会记住、能重测** = M01-M03 + L01-L03。隐私删除是长期记忆启用门禁。
- **M3：每天用得起来** = P01-P03 + U03 + DL1–DL3、DL5–DL7、DL9、P04a。协商确认、失败状态与移动端流程完整；手动加任务、补测闭环、可核对的练习判定、AI就绪与每日草案在真实链路上可用（2026-10-08扩展）。
- **M4：基础可交付** = 先Q03打包/恢复实现，再Q01集成，再Q02最终验收。真实材料/模型/手机的结果单列，不能用fake测试替代；这不代表本轮新增需求全部满足。
- **M5：新增核心需求完整覆盖** = X01/C01–C03/V01/K01–K02/P04/U04后通过Q04。学校邮箱和钉钉按实际授权验证；视频/录音理解、知识架构、动态学习与主动安排逐项验收。

允许先交付M4收集真实反馈，但不再默认暂缓转写、外部数据接入和课程知识结构；它们已是CAP01–06明确需求。权限/硬件/效果不满足时保留blocked与临时降级说明，缩减完整交付范围需用户确认；手工导入不算自动同步，存储音频不算理解课堂。

2026-09-21审查后新增：RP1–RP6为审查发现的工程修复项（隐私准入、原子写回、发送幂等、引用展示、CI门禁、今天页恢复入口），不扩大产品范围。M2门槛更新为M01–M03＋RP1＋RP2；M1的“跨端恢复”验收增加RP3的三个故障场景；M3今天页以RP6最小恢复入口为先行切片；RP4并入U03体验门禁；RP5为发布证据前置。详见[审查综合文档](../../plans/2026-09-21-review-synthesis.md)。

2026-10-07每日学习闭环审查后新增：DL1–DL4（[每日闭环缺口](opening-release/13-daily-loop-gaps.md)）补齐正式入口去Mock、普通任务完成/跳过、重测自动提议与补测绑定`retestId`、记忆卡片接入真实API；均复用既有API/仓库，预计不新增迁移，不改变M0–M5范围定义。是否把DL1–DL3纳入M3“每天用得起来”与Q01依赖，需用户确认后另行调整（已于2026-10-08经用户确认调整，见下段）。

2026-10-08闭环第二轮审查后新增：DL5–DL10与P04a（[闭环第二轮](opening-release/14-loop-closure.md)）补齐今天页手动加任务与分组、参考自对照的可信判定、AI就绪清单/设置内额度/未知预留对账、照片视觉输入、课表导入与默认空闲时间、每日自动草案、Windows本地端到端运行手册。DL5与DL9需迁移，编号由INTEGRATOR分配；其余不新增迁移。经用户确认调整依赖：DL3增加DL5、DL4排到DL3/DL6之后、K02增加DL3与DL6（判定部分拆入DL6，不再被K01阻塞）、P04增加P04a、Q01增加DL3/DL6/DL7/DL10；M3扩为上述闭环任务。C02/C03保持active与原依赖，只在推荐顺序上排在DL1–DL3之后；DL8补M1照片路径但不回改M1已有验收。执行顺序见该文件“闭环优先级与排期”。

2026-10-09研究硬化新增：RP7/DL11/BC1/TZ01（[研究硬化](opening-release/15-research-hardening.md)）补齐同SHA发布证据索引、day-planner earliest/notBefore、预算门禁费用回执重试契约、工作区时区日边界同一解释；不改写既有 verified 状态（BC1≠B01）。

复用原则：邮箱优先ImapFlow+MailParser；Docling/FFmpeg/faster-whisper承担解析；参考DeepTutor辅导流程，不复制另一套主后端。EmailEngine当前是商业备选，不默认购买。依据见`../../quality/opening-capability-reuse-research.md`。

Q02最终验收依赖保持不变，但脱敏固定样本、离线evaluator与失败集应在T02/T03/U02开发时建立；真实模型语义、真机、恢复演练分别记录，不能等到发布末尾才开始准备。

## 5. 监督与审批

普通实现、离线测试、本地修复、文档与本地提交已获继续授权。以下需确认/配置：付费模型调用预算和密钥、生产部署/生产数据迁移、购买服务、公开开放、扩大采集范围、改变产品范围。

不等待密钥而停全部开发：provider用明确标识的测试适配，接口与失败流程可验；真实效果任务保持blocked。不会在会话结束后声称仍有后台agent自动监督。

## 6. 当前证据入口

- `../evidence/2026-09-12-opening-release/baseline.md`：安装、lint、类型、构建与测试的实际结果。
- `opening-release/tasks.json`：任务依赖与状态。
- 各子计划：准确文件、接口、测试样例和执行步骤。
- 计划自检：`node scripts/validate-opening-plan.mjs`、`node --test tests/tooling/opening-plan.test.mjs tests/tooling/opening-capability-plan.test.mjs`；仅校验任务引用/依赖/需求覆盖，不证明代码正确或学校服务已接通。
