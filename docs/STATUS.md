# 项目状态看板

每个工具（Claude Code、pi、Grok Bot）开工前读这一页，收工时只改自己负责的行。不超过一屏；详细内容放在 PR 和计划里。

**更新：** 2026-10-19
**目标（至 2026-11 初）：** 自己每天真实使用 → 按使用反馈迭代笔记与 AI 表达；同时试跑 AI 主讲首个单元。

## 主干

- 开发主干：`study-assistant-opening` 远端的 `feat/opening-release`。
- `AIstudy` 远端的 `main` 冻结，不再推送（PR #2 F01 已过时，待关闭）。
- 已合入：G1 #23、G2 #24、S1 #25、S2 #26、S2 评估 #27、S5 #28、#29、#31、#32、#33、jingwei PR1–3；2026-10-14 合入 Grok 小卡 #34–#38、#39、#42；2026-10-15 合入 #43 的 L0/L1（自适应排程数据层与规则）、模型调度与证据闭环 M1–M6/E1/E3–E5、S8、三轮 UX（`52d6f24..7fb4f85`，迁移 0061–0064）。
- 当前发布主干为 `c5cb6424`（#75，包含 #74、Study 工作区与自动记录查询）；迁移末号 0081。#75 最终 head 的完整 CI 39359526594 成功；合并后的主干 CI 39361727094 已成功，发布必须以目标 SHA 的 push CI 成功为准。

## 进行中

| 切片 | 负责 | 分支 / PR | 状态 |
|---|---|---|---|
| Study R2、学习闭环与 UIUX 整合（2026-10-21） | Codex + 独立复审 | `codex/study-integration-20261021`；UI #79–#93，R2 #94，验收 #97 及后续依赖片 | 按用户授权整合同一候选并提交 GitHub。R1 可验证补丁已恢复，R2 证据规则补完；精确提示/新题身份、连续复习、逐字显示、专注模态与 Drawer 遮挡已修。Chromium 390px 组件体验已验；补 `0082` 持久复测协议、备份负向曝光与旧链接恢复、真实 Web/worker 重启及独立 PDF CI。完整 PG、40 项 axe、升级/备份/解析和重启结果见最终 head PR 检查。真实 72h 学习效果未测量。未合并/部署；见 [UIUX 整合记录](plans/2026-10-20-uiux-delivery.md#2026-10-21-整合与实际验收) |
| UIUX 最终方案 UX0–UX5 | Codex + 独立子代理 | `codex/uix-shell-20261021`（本地） | 核心代码与交叉复审已整合：稳定恢复与鉴权、共享主题/组件、四导航和上下文AI、分级提示/证据、课程四标签、今日/复习/资料及兼容路由。80文件868项定向单元、Web/UI/E2E类型、改动lint、边界、真实Tailwind与Web生产构建通过；后续卡片16项、UI18项通过。10核心视图×4条件axe用例已补，未跑浏览器。SQL补验已准备PG16.14，但宿主仅映射root、无法低权限启动，6套47静态用例未运行；未声明原型逐项全部完成，混排队列/逐字回复/模态转场与量化目标见[实施范围](plans/2026-10-20-uiux-delivery.md)。公开推送被自动审批拒绝，尚无远端ref/PR/head CI/部署；浏览器待用户 |
| 2026-10-20 线上报告整改 | Codex + 独立复核 | `codex/report-remediation-20261020` | 基于已合 #76（170204ff）核实 QA01–09；修作答恢复、费用截断、停用账号存量会话、设置调试泄露和匿名健康详情，备份入口明确 measurement 限制。最近非浏览器测试与四包类型/lint/边界通过，隐私复审修复及24项复查通过，最终CI待收口。内测公开注册且暂不新增/收紧额度为用户决定；可信IP证书已安装并默认TLS实测200，自动续期已启用；完整注销未实现。Hermes根盘已清理/迁备份至3.47GiB，保留原路径与current；9项工具测试及57秒真实parser预检成功，/www发布继续，浏览器待用户。见[逐项记录](operations/report-remediation-2026-10-20.md) |
| 首次学习与发布保护（2026-10-19） | Codex | [#76](https://github.com/Xhhemoing/study-assistant-opening/pull/76) · `codex/first-learning-20261019` | 已整合c5cb6424并推送71f3ce6a；66项最近单元、Web/Database类型通过，最终head待完整CI。补systemd路径引用、跨盘受管发布及0081兼容回退保护；14项真实systemd/配置测试及59项部署模拟通过，旧脚本实际重现5项不安全降级；独立复审无P1/P2。CI39365804145暴露runner无/usr/bin/node，修测试夹具后最终a5f228ad完整CI39366647158成功，已合并为170204ff。Hermes线上保持6c4a4ea8；已按用户授权两次安全停止另一发布构建并持有既有发布锁；另一会话仍重试，待用户停止其发布，Web/Worker PID未变，/www约13.6GiB可用于发布。现有备份在隔离PG16恢复成功（93表/74迁移），未改生产数据库。真实IP限流及用户浏览器/真实学习待验收；见[首启与试用](plans/2026-10-19-first-learning.md) |
| 2026-10-19 GitHub Study 链路整合与清理 | Codex | [#74](https://github.com/Xhhemoing/study-assistant-opening/pull/74) 已合；整合 [#75](https://github.com/Xhhemoing/study-assistant-opening/pull/75) | 用户限定本轮优化与Study链路，历史草稿#46/#51/#63保留。#71、内容前置fe24bd8、#73已整合；修复查询兼容、追问来源隔离、检索评估、历史曝光响应契约及旧夹具。1a321316的CI中1151项集成（1既有跳过）和291项handler均通过；浏览器36通过/5跳过/4个旧夹具失配，已维护折叠入口及显式就绪transport，保留恢复安全和原件字节断言，未本地运行浏览器。完整CI和合并结果以PR75最终head检查为准。0075–0081已在隔离PG迁移，回滚见查询架构与升级计划；未部署，待用户浏览器验收。已清理17个远端/2个本地已合分支，独有提交者保留 |
| UI 审计逐项整改 | Codex | `codex/study-ui-audit-fixes-20261019` | D01–D10、IL01–IL08 的上下文/资料意图/临时分支、阅读适宽与紧凑问答、入口与视觉层级已编码；392 项相关回归分批通过，Web 类型、改动 lint、边界及生产构建通过；未合并/部署，浏览器/窄屏/真实模型待用户复验。基于本地助理升级父提交；不覆盖另会话远端导航/查询成果。见 [逐项记录](operations/ui-audit-remediation-2026-10-19.md) |
| 有效内容展示面积第二轮 | Codex | `codex/study-content-space-round2` | 基于b131cc9补齐阅读器信息合行、紧凑输入设置、练习开始动作置顶、资料行密度与确认空队列后收起；190项相关回归、最终14项重检、Web类型/lint/边界通过；Web生产构建通过。原31条历史保持，浏览器复验未执行，见同一[整改记录](operations/ui-audit-remediation-2026-10-19.md) |
| Study 助理升级最终计划 | Codex + GPT-6.1 Sol high 子代理 | `codex/study-upgrade-20261019` · [#71](https://github.com/Xhhemoing/study-assistant-opening/pull/71) | 全部可实现板块已分部分本地提交并独立复核：0075–0081、锚点/交付、父预算、精确span三模式、状态/Decision/影子比较、意图、Composer/13读工具/6提案、39表恢复及检索评测。662文件5059单元/契约、类型、lint、边界及Web/worker构建通过。最新源码推送被自动审批拒绝，待明确授权；#71仍非完整实现，真实PG/handler完整CI未完成。未合并、未部署；浏览器与真实学习效果待验收，见 [计划](plans/2026-10-19-study-assistant-upgrade.md) |
| 2026-10-19 FACDA 恢复分析与等待体验优化 | Codex | `codex/latest-code-analysis-20261019` | 基于本地6c4a4ea8优化登录成功后的防重复提交/跳转状态与普通链接恢复、Today鉴权后并行读取及加载提示。52项定向回归通过（既有时区测试首次动态导入触及5s，单次15s超时复查3项通过，未改默认配置）；Web/改动测试类型、改动lint通过。附件facda242b仅证实认证与2243.9s冷编译完成，页面/自动查询GUI/ST001–004仍待用户验收，未认定OOM或完成同版本复现。复验步骤见[发布操作](operations/opening-release.md#facda-恢复材料的结论与复验2026-10-19)。Graphify已执行AST更新，但图谱重建未完成已停止，缺SQL解析器；本轮改动随本次本地提交保存；未push/部署 |
| Study 独立回归修复 ST-001–004 | Codex | [#68](https://github.com/Xhhemoing/study-assistant-opening/pull/68) | c283e78 经完整 CI 39206856601 和主线程独立复核后，已合入 feat/opening-release（b140d548）；四项独立缺陷修复不等于新架构验收。dc792e0/ce4de2a 尚未从合法可见仓库/refs/制品取得，不宣称源码丢失。未部署 |
| Study 自动受限读取 | Codex | [#73](https://github.com/Xhhemoing/study-assistant-opening/pull/73) · `codex/automatic-records-refinement-20261019`，基于 fe24bd8 | 原补丁及4228253已按完全相同源码树同步为0964837。继续优化每轮工具最小化、历史失效续问澄清、决策ID约束、课程标题与日期分离、完整日期token及跨月/闰年边界，修正集成夹具写死“明天”。246项相关单元通过；本轮AI/Worker/Web类型与改动lint通过。新增真实PG回归交现有CI执行，完整CI以PR当前head为准；本地无数据库服务，真实模型/用户浏览器未验收。未合并/部署，开关默认0不变。[查询架构](architecture/STUDY_SYSTEM_QUERY.md) |
| Study 系统只读查询 | Codex | [#69](https://github.com/Xhhemoing/study-assistant-opening/pull/69)；[#70](https://github.com/Xhhemoing/study-assistant-opening/pull/70) | #69 fa322b89修复五项P2及请求/结果工具配对，完整CI39216797557成功。后续接保存/临时聊天与显式开关（默认0），绑定用途/owner grant、核验完整祖先来源；只查元数据，不发起模型请求。含0074与临时24h来源元数据，回滚先停/取消遗留查询再启旧worker并保留DDL。相关222单元及补跑35项、60真实PG（含10聊天/竞态）、4HTTP、七包类型和改动lint通过；#70初轮CI两项旧workspace mock已补，terminal15项回归通过；独立review/新head完整CI待收口；[边界与用户验收步骤](architecture/STUDY_SYSTEM_QUERY.md)。不等于26项新架构或单元三模式完成；原生模型C1/C2、release/ack、M4试验与用户浏览器待完成，无生产操作 |
| Study 系统只读查询 | Codex | [#69](https://github.com/Xhhemoing/study-assistant-opening/pull/69)；[#70](https://github.com/Xhhemoing/study-assistant-opening/pull/70) | #69 fa322b89完整CI39216797557成功。#70 d5c4746b完整CI39228165671成功，F1/F2/F3获主侧独审；真实Web+Worker隔离进程三配置28项HTTP断言通过，无真实模型调用。主侧新构建浏览器已验保存恢复/临时消失/临时存笔记制卡禁用、日期与对象消歧和adaptive0/1、query0矩阵，发现证据链接不可点击；本轮修复保留服务端回执证据，仅确切授权的已知应用只读入口可链接，chatProse=0/1均提供入口，100相关单元、Web类型与改动lint通过，增量CI及主侧真实浏览器复验待收口。含0074与临时24h来源元数据，回滚先停/取消查询再启旧worker并保留DDL。[边界与验收步骤](architecture/STUDY_SYSTEM_QUERY.md)。默认有限规则查询，不等于26项新架构完成；真实gateway/C1/C2、release/ack、M4受控试用仍待，MinIO本地镜像拉取unauthorized未绕过，无生产操作 |
| 专注学习界面改版 P0–P2 | Codex + 独立交叉审查 | [#67](https://github.com/Xhhemoing/study-assistant-opening/pull/67) · `codex/focused-learning-ui` | 编码已补齐：课程断点、固定版本资料阅读、练习草稿保留/另开/切回、完整教学单元与统一工具、关联真实作答的提问/笔记、矩阵平面概念课及真实迁移题。102 文件 847 项整合单元、最终 126 项定向回归、Web/34 份测试/E2E 类型、94 文件 lint、边界检查及 worker/Web 生产构建通过；无新迁移或依赖。已维护旧 E2E；最新 CI 暴露的 Today C5 旧断言已按默认收起工具语义修正，37 项最近回归通过。用户已授权合并，完整 CI 与合并状态见 #67；未部署，用户交互与真实学习效果待验收 |
| 深度审计按板块复核与修复 | Codex + 独立交叉审查 | [#66](https://github.com/Xhhemoing/study-assistant-opening/pull/66) · `codex/audit-hardening` | 已同步实际合并的#65/#64；0073保留0070–0072，公开原文接入统一配额，迁移前停旧worker并取消待重启；跨协议回退legacy持久暂停worker，返回降级，部署/身份故障注入检查通过。整合真实PG已通过；队列spike监听竞态已修并通过隔离真实Redis。最终提交完整CI须以#66当前检查为准，不能用旧head代替。生产部署、可信代理、分支保护及用户验收未完成，详见[审议与欠项](operations/audit-remediation.md) |
| Math I 考前冲刺与课程证据集成 | Codex + 独立身份/存储复核 | [#64](https://github.com/Xhhemoing/study-assistant-opening/pull/64) · `codex/exam-sprint` | 已在#65后合入40a4be7；head5cbfa7d的[完整CI](https://github.com/Xhhemoing/study-assistant-opening/actions/runs/39050725855)通过，含真实PG、handler、浏览器及构建。稳定技能UUID、退役保护、引用CAS、实时资格/摘要/BKT/导师flags及显式重关联通过独审和回归，保留0070–0072。公开原文配额随#66整合。尚未部署或用户验收；见[统一数据关联](product/exam-sprint.md#统一数据关联) |
| 目标驱动框架与首批规划/教学改进 | Codex + 独立交叉审查 | [#65](https://github.com/Xhhemoing/study-assistant-opening/pull/65) · `codex/goal-driven-learning` | 已合入b70ae56；headf12c5df的[完整CI](https://github.com/Xhhemoing/study-assistant-opening/actions/runs/39050710975)通过，含真实PG、handler、浏览器及构建。目标策略/编译接线、答案自身引用、self_report/v3资格与曝光保留已实现，无DDL。可信同label跨requirement已有domain回归，生产模板尚无可信PG正例；不伪造权威记录。尚未部署或用户验收 |
| BKT 算法与真实使用测试插件 | Codex + Astra 独立评审 | [#61](https://github.com/Xhhemoing/study-assistant-opening/pull/61) · `codex/bkt-real-use-evaluation` | 以主干 `9c7c86e` 整合并保留 S1–S7 与 0066–0069；Astra 数学复核通过，修复迟到复测 72h 间隔与归档只读入口，补真实 pg_dump 恢复验收。109 项定向单元、4 包类型和相关 lint 通过；完整 CI/合并结果见 #61。默认未报名，部署、用户浏览器与真实学习效果待验收 |
| 自适应进化 v3：要求身份与版本资格 | Codex + 隔离子代理 | [#59](https://github.com/Xhhemoing/study-assistant-opening/pull/59) | 已与 #60 整合并合入 `cb5a68c`，完整主干 CI 38911719890 成功。按要求隔离快照/建议/任务/教学，保留已交付帮助与卡片入口，含0065可空列迁移；尚未部署。稳定节点身份、分项评分与BKT属后续 |
| 评审修复 R1–R8 | Claude | `claude/keen-carson-ls19ie` | 已合入主干（`544304e`）；R10 技能名部分由 G3 解决、`firstAttempt` 留到 I2；R9 拆为 Grok G10 + Claude R9b。详见 `docs/plans/2026-10-15-review-and-next-steps.md` |
| 统一模型调度 + 证据闭环（M1–M6、E1–E5） | Claude → GPT | `feat/opening-release` | 已实现；Claude 复核：全量类型/lint 通过，单元仅环境类 PDF 失败，集成有 1 个真实过期测试（R7）；E2 暂缓；浏览器与真实供应商待用户 |
| 自适应副驾驶闭环批次 A | Codex 主对话接 Claude；子代理接 Grok | [#57](https://github.com/Xhhemoing/study-assistant-opening/pull/57) | 已合入；最终提交 `293d6d2` 完整 CI 成功，覆盖数据库/handler/既有浏览器/构建。G1/G5–G9、C2/C3/C4 已实现；待 Hermes 部署与用户浏览器验收，目标开关为 0。#46 仅移植同日去重实现，原 PR 未变动 |
| 主干 CI（C0）与转写恢复 R9b | Codex 主对话 | C0 随 #52 已合；R9b [#56](https://github.com/Xhhemoing/study-assistant-opening/pull/56) | 已合入；最终提交 `3d6d04f` 完整 CI 成功。持久化分段回执，跨手动重试复用、补结算、阻止未知结果重发；免费模型 TTL 回执可恢复。无新增迁移 |
| Hermes 发布 | Codex 主对话 | [#58](https://github.com/Xhhemoing/study-assistant-opening/pull/58) | 用户已授权部署；当前环境连接 `23.251.32.22:22` 返回 Network is unreachable，且无 SSH 密钥。发布脚本补齐 worker 重启、启动后崩溃检测、失败传播与成功 SHA 记录；模拟回归通过。线上未操作，待可用部署连接 |
| 学习闭环与整体复核 | Codex 主对话 + 两个独立子代理 | [#60](https://github.com/Xhhemoing/study-assistant-opening/pull/60) | 7类闭环/恢复缺陷已修并合入 `e7a693b`；与 #59 整合后的主干完整 CI 38911719890 成功。Hermes与实际使用验收未完成 |
| 学习闭环剩余计划 S1–S7 | Astra 研究/独立评审，Codex 与隔离子代理编写 | [#62](https://github.com/Xhhemoing/study-assistant-opening/pull/62) / `codex/learning-feedback-loop` | 七个编码切片已实现并完成独立review修复；含0067–0069及原样保留0066。首批CI单元3886/数据库807通过，1个旧backup空表断言已修。整合提交CI与合并状态以#62检查记录为准；用户浏览器/部署/真实学习收益未验收 |

## 下一步（按顺序）

1. 完成 #76 与最新发布主干整合，待其完整 CI 成功后合并；发布前再核实合并 SHA 的 push CI。历史实现行保留原时点记录，不能据旧“待合并/保护未启用”重复开发。
2. Hermes 发布：使用已有独立 /www 磁盘，核对实际制品、可信代理及真实 IP 限流（隔离备份恢复已完成）；保留当前应用、可回退版本和备份。按既有受管流程部署 0075–0081，不改变自适应/查询等功能开关，不降低门禁。0081 旧代码不兼容时，先停新 worker 与学习写入，保留 DDL 和学习数据；详见 Study 升级计划。
3. 用户浏览器与真实学习验收：/onboarding → /opening/today → 同一活动的学习/作答/小结 → 至少72h后独立复测。记录生成成功率、待核对原因、实际费用、等待时间和断点恢复；未验收不标通过。
4. 按实测等待时间选择性能切片；目标驱动首启已有 #76，不另开重复实现。规划 Agent、多步写工具与扩展自动判分等实际自用反馈后再决定。
## 负责人已定（2026-10-13）

- 0060 migration 随 #21 合入：有重复键时迁移报错并列出 job，不删数据；回滚 `DROP INDEX opening_jobs_retest_accept_key_uidx`。
- #20：生产环境已重定向的旧页面，其 e2e 退役；仍可访问的页面照常修测试。
- 5 个未推送的旧 worktree 已备份为远端 `backup/wt-*` 分支，可随时删除本地目录。
- 笔记 + 表达与 AI 主讲两条线并行；AI 主讲先试跑已有代码，不新开任务。

## 等用户决定

- 本次模型/证据交接已快进推送到 `feat/opening-release`；已删除远端 `claude/keen-carson-ls19ie`、`feat/adaptive-loop-v2` 与内容已被目标分支覆盖的 `feat/course-seed-today-plan`。其余分支仍含独有提交，未删除。
- 合并与删除 worktree 会被 Claude 的权限拦截：需用户/Shipper 合并 PR，或在设置里放行 `gh pr merge` / `git worktree remove`。
- 本地 worktree 过多（超过 3 个上限）：已合 PR 的 `sao-fix-shell-review-badge-error`、`sao-docs-hermes-self-use-flags`、`sao-test-real-use-ac-03` 可删。

已解决（2026-10-14）：Hermes SSH reset 是后量子 KEX 握手在本机网络被掐断，`~/.ssh/config` 加 `KexAlgorithms curve25519-sha256`；Grok 改由 bot 团队按卡执行。

## 使用反馈

自用中发现的问题记在这里，一行一条：`日期 · 页面 · 现象`。优先级高于“下一步”。

- （暂无）
