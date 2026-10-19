# 项目状态看板

每个工具（Claude Code、pi、Grok Bot）开工前读这一页，收工时只改自己负责的行。不超过一屏；详细内容放在 PR 和计划里。

**更新：** 2026-10-19
**目标（至 2026-11 初）：** 自己每天真实使用 → 按使用反馈迭代笔记与 AI 表达；同时试跑 AI 主讲首个单元。

## 主干

- 开发主干：`study-assistant-opening` 远端的 `feat/opening-release`。
- `AIstudy` 远端的 `main` 冻结，不再推送（PR #2 F01 已过时，待关闭）。
- 已合入：G1 #23、G2 #24、S1 #25、S2 #26、S2 评估 #27、S5 #28、#29、#31、#32、#33、jingwei PR1–3；2026-10-14 合入 Grok 小卡 #34–#38、#39、#42；2026-10-15 合入 #43 的 L0/L1（自适应排程数据层与规则）、模型调度与证据闭环 M1–M6/E1/E3–E5、S8、三轮 UX（`52d6f24..7fb4f85`，迁移 0061–0064）。
- 发布分支已按顺序合入 #65（`b70ae56`）及 #64（`40a4be7`），两者最新 head 的完整 CI 均通过，迁移末号0072；加固 #66 使用0073，最终整合提交仍须完整 CI。Hermes 当前部署 SHA、迁移与开关状态未现场核实。

## 进行中

| 切片 | 负责 | 分支 / PR | 状态 |
|---|---|---|---|
| UI 审计逐项整改 | Codex | `codex/study-ui-audit-fixes-20261019` | D01–D10、IL01–IL08 的上下文/资料意图/临时分支、阅读适宽与紧凑问答、入口与视觉层级已编码；392 项相关回归分批通过，Web 类型、改动 lint、边界及生产构建通过；未合并/部署，浏览器/窄屏/真实模型待用户复验。基于本地助理升级父提交；不覆盖另会话远端导航/查询成果。见 [逐项记录](operations/ui-audit-remediation-2026-10-19.md) |
| 有效内容展示面积第二轮 | Codex | `codex/study-content-space-round2` | 基于b131cc9补齐阅读器信息合行、紧凑输入设置、练习开始动作置顶、资料行密度与确认空队列后收起；190项相关回归、最终14项重检、Web类型/lint/边界通过；Web生产构建通过。原31条历史保持，浏览器复验未执行，见同一[整改记录](operations/ui-audit-remediation-2026-10-19.md) |
| Study 助理升级最终计划 | Codex + GPT-6.1 Sol high 子代理 | `codex/study-upgrade-20261019` · [#71](https://github.com/Xhhemoing/study-assistant-opening/pull/71) | 全部可实现板块已分部分本地提交并独立复核：0075–0081、锚点/交付、父预算、精确span三模式、状态/Decision/影子比较、意图、Composer/13读工具/6提案、39表恢复及检索评测。662文件5059单元/契约、类型、lint、边界及Web/worker构建通过。最新源码推送被自动审批拒绝，待明确授权；#71仍非完整实现，真实PG/handler完整CI未完成。未合并、未部署；浏览器与真实学习效果待验收，见 [计划](plans/2026-10-19-study-assistant-upgrade.md) |
| Study 独立回归修复 ST-001–004 | Codex | [#68](https://github.com/Xhhemoing/study-assistant-opening/pull/68) | c283e78 经完整 CI 39206856601 和主线程独立复核后，已合入 feat/opening-release（b140d548）；四项独立缺陷修复不等于新架构验收。dc792e0/ce4de2a 尚未从合法可见仓库/refs/制品取得，不宣称源码丢失。未部署 |
| Study 系统只读查询 | Codex | [#69](https://github.com/Xhhemoing/study-assistant-opening/pull/69)；[#70](https://github.com/Xhhemoing/study-assistant-opening/pull/70) | #69 fa322b89修复五项P2及请求/结果工具配对，完整CI39216797557成功。后续接保存/临时聊天与显式开关（默认0），绑定用途/owner grant、核验完整祖先来源；只查元数据，不发起模型请求。含0074与临时24h来源元数据，回滚先停/取消遗留查询再启旧worker并保留DDL。相关222单元及补跑35项、60真实PG（含10聊天/竞态）、4HTTP、七包类型和改动lint通过；#70初轮CI两项旧workspace mock已补，terminal15项回归通过；独立review/新head完整CI待收口；[边界与用户验收步骤](architecture/STUDY_SYSTEM_QUERY.md)。不等于26项新架构或单元三模式完成；原生模型C1/C2、release/ack、M4试验与用户浏览器待完成，无生产操作 |
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

1. #56–#60 已合入，最终主干 `cb5a68c`、完整CI 38911719890 成功。恢复 Hermes 部署连接后核实 SHA/迁移、备份；#59 含既有 0065 可空列迁移，运行新代码前先迁移。以 `OPENING_ADAPTIVE_PLANNING=0` 部署，用户决定何时开 1；当前尚未执行线上操作。回滚应用时保留 0065 可空列及已有要求归属。发布/验收见 `docs/operations/adaptive-copilot-release-checklist.md`。
2. 用户浏览器验收 + 3 天自用：一键配置 → 开始此项 → 主讲内容 → 试一试作答与核对 → 结束与小结 → 复测/卡片；记录编译成功率、「待核对」比例、花费，以及登录后“侧栏卡住”是否复现。
3. 按用户本轮授权，由Astra研究、Codex编写，执行 `docs/plans/2026-10-16-learning-loop-remaining-plan.md`。S1–S7已实现，完成当前整合提交真实PG/handler和完整CI后合并#62。I2/BKT共享字段由另一会话负责；合并前协调迁移编号，教练自动接受仍不启用。
4. 大问题方案：
   - A 规划 Agent（等两周自用数据）：模型看不到任务/计划/课表、没有工具和多步循环、排期纯规则 → 只读工具 + 只出草稿的写工具（复用 PlanDraft 接受/拒绝、`planDay` 排时段、`runBudgetedCall` 计预算）；聊天内显示计划卡；教练模式持久化并接 `canReorderTask`。
   - B 首次启动：正式版登录后不进 onboarding；onboarding 不收集意图；“开始学习”是固定摘要空记录；无 planning_settings 时没有计划草稿 → 空工作区对话式首启（学什么/何时考/有无材料），写入默认规划设置与场景预设生成首批任务，AI 不可用时降级到笔记/材料路径。
   - C 安全（小，可与第 3 步并行）：`/api/opening/health` 无鉴权现场探测待有部署连接时核实；发布脚本已移除 root 密码回退与 sshd 自动修改。
5. S3 内联 `jw:` 块：自用中出现“这里需要图”的实例再做。
6. 暂缓：E2 AI 判分、BKT 影子运行（先补技能身份与首次作答字段，见 R10）。

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
