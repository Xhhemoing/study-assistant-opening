# 项目状态

更新：2026-11-18。本页只放当前状态，保持一屏；每个结果一行，仅由唯一集成者更新；worker 收工在原 Kanban 卡交回。历史记录见 [2026-11-03 收敛前完整状态](status-archive/2026-11-03-full-status.md)。

| 项目 | 当前状态 |
| --- | --- |
| 开发主干 | `feat/opening-release` 与 `integration/opening` 均对齐 `86d4cb673aa2dcadb308f8c3f21ae23dc79317c2`（含 Wave 1–6 `#374`–`#436`、资产图一期 `#437`–`#441` 及 `#442`–`#446` 全部已合 PR，零新增迁移；本次状态同步 PR 自身在合入前不计为已合入）。22 个历史清理 worktree 已全部分析/备份后移除（当前仅保留主工作区），并已清理 186+ 历史远端已合分支 |
| 线上版本 | 最近发布交接基线 `7ff0ee5a`（迁移停在 `0107`，未在本次文档步骤现场回读）；主线已并入 `#230` 及迁移 `0108`–`0111`，均尚未部署。含迁移部署、迁移执行及恢复演练须用户 U 级逐次批准，并先完成 `docs/operations/database-migrations.md` §2/§7–§9 只读核对与空隔离库恢复演练 |
| 开放 PR | `#230`、`#264` 及 `#442`–`#446` 已并入主线；本次状态同步 PR（`docs/status-wave7-sync-20261118`）指向 `feat/opening-release`（合入前不计为已合入）；其余开放 PR 以 GitHub 实时列表为准 |
| M0 发布 | 主干已含 Wave 1–6 缺陷修复（`#374`–`#435`）、`#389` 示例变式及 `#437`–`#446`（零新增迁移），尚未部署；发布前须获用户 U 级批准并核验 `0108`–`0111` 备份与隔离恢复证据；上线后待核：Worker 队列消费、稳定窗口、合成 PDF 上传解析写回、真实文本/视觉调用（视觉模型配置待确认）与用户浏览器验收，验收后清理合成对象 |
| M1 批改与导师 | 主干已补齐 `0111` 显式二次 AI 批改确认与费率/只读上下文对齐（`#381`/`#425`/`#430`）、示例题异步变式（`#389`）及 `M4-1b` 异家族盲解（`teaching-blind-solve.ts`，密钥与日额度按私有环境配置）；批改 `calibrated=false`，L0 为规则回归快照（#205/#217/#225/#233/#234），已在 #434 重跑离线 L0 基线通过（`tutor-l0-offline-1`，76/76，`rulePassRatio=1`），待人工校准样本（D7） |
| M2 学习会话 V2 | 在 `studySessionV2` 开关后，默认关，账号白名单。D4 两次纠偏换方式、D5、D6、first-learning、M2-B 自动复测撤销及终态复测恢复修复（`#419`）、Today 恢复缩短与助理链接保留（`#426`）、E5b 结构化对话流与单按钮后继卡、E5c 通用学习工作区对话伴随与断点恢复收敛（`#429`）、`V2 PhotoPractice` 照片拒绝同页恢复（`#425`）、学习工作区实时 `LearningResume` 同步与课程路线 stale-CAS 边界加固（`#433`）、Today/课程页/服务端多活动选择统一与议程确定性时钟（`#435`）及无课程多稿写作工作区 `writing-workspace-v1` 与跨活动/Today 恢复（`#444`，仅产 `MASTERY_NOT_ESTABLISHED` 不写掌握观察）均已合入主干；全部前端交互与恢复流程待用户浏览器验收 |
| 决策一致性 | 规范 builder 已覆盖 agenda、span 恢复、Web 焦点、课程路线、编译焦点/系统推荐及 D5/D6/first-learning/课程隔离 flags；`收尾-1`（`createRetestCloseHandler`、`nextTutorKindAfterRetestClose`）已在主干清除（`#280`）；`nextLearningStep` 的 legacy `adaptive`/`thin` 重载已在 `#434` 清除（`buildTutorActions` 保留为基于规范 `buildDecisionInput` + `nextLearningStep` 的路由薄封装） |
| M3 画像与数据集 | 规则画像（#167、#168）与去标识数据集及同意（#169，迁移 0107）已在主干；按 D9 以这两片收口，离线模型比较移到 M6 之后或有多名真实用户之后 |
| 资料解析 | PDF 部分失败保留已发布页与引用（#199），重试期间已发布页仍可读（#214）；`#424` 与 `#432` 已补齐 `PARSE_PARTIAL` 局部重试可见入口、上传/下载错误中文化、直传租约过期文案区分、完成确认防重守卫与队列恢复；`#446` 已接入解析完成、课程成员增改删（含 `replacesSourceId` 替换）及排除/删除触发的课程知识图同步；待用户浏览器验收 |
| 课程包 M4 | 主干已合入 `#230`（`0108` 知识节点人工确认）、`M4-1`（确定性判分与兼容桥）、`M4-1b`（`teaching-blind-solve.ts` 异家族盲解与编译接线）、`M4-2f`（标签页 `#course-goals`/`#course-settings-heading` 锚点及 `#427` 新鲜度/stale-CAS 修复）、`M4-3`/`M4-4`（服务端验证、节点身份与批准时间边界、`#430` 只读与 `exam-only` 提示过滤）、`M4-5`（`0110` 资料用途 `teaching`/`practice`/`mock_exam`/`reference`）、`0109` 私有保留题与曝光历史触发器，以及 `#422`/`#428`/`#432` 期中冲刺、模拟卷守卫、课程考试 `"unknown"` 冲突提示与冲刺页切课过渡态重置守卫；`#443`/`#445`/`#446` 已补齐 Wave 2 契约、资产图二期跨课共享技能证据投影（`sharedAttribution` / `scopeFingerprint` 游标失效，跨课同名节点保持独立）及课程资料变更合并知识图重建（`coveredSourceVersions` / `lastBuiltVersion` / `getWithSync` / 并发 `confirmNode` 冲突一次性 CAS 重试）。抽样门槛仍为点估计 ≤2% 且报告上界，整课高数验收与真资料定样未执行 |
| CI | 并行 job + `quality`（`lint-typecheck-test-build`）与 `worker-gate`（`real-worker-pdf-browser-flow`）；`scripts/ci/checks.py` 将 `docs/STATUS.md` 与 `.agents/` 纳入双必选门禁；`#420`/`#421` 已补齐本地重锁恢复单测与可选看板辅助脚本；`#443`–`#446` 均已通过精确 `headRefOid` 远端双必选 CI 与 `3.2` 双只读 Subagent 技术审查（仅作会话内技术把关，不替代外部指定 `Claude Opus 5.5 high` / 独立 `GPT` 签批），本地 Playwright 与真实用户浏览器交互由用户验收 |
| 安全 | 公开文档已移除生产主机地址（#208）与本机绝对路径（#254/#272），不改写 Git 历史；D10 服务器加固仍由用户执行或逐项授权，沙箱目录路径与外部 CDN 域名保留问题待仓库所有者决定 |

## 11-08 至 11-18 合入（按主题）
- `6dff1a1f` #374：integration 批量提升合入主线（汇入 11-08–11-12 已审底座：#230/`0108`、`0109` 私有保留题、`0110` 资料用途、`0111` 显式二次批改、M4-1b 异家族盲解、D4/D5/D6/first-learning、E5b、G2f 与 M5 考试集成等）。
- 测试、文档与本地工具链：`5c8bbd9b` #411（材料来源面板合成输入单测）、`1f13971a` #420（本地重锁过期恢复与无效复测关联测试）、`1feaf734` #421（可选本地看板调度/监听/Worker 辅助脚本 `scripts/local-dev-{flow,watch,worker}.mjs`）、`000f324e` #423（`aistudy-autopilot` 技能、`docs/README.md` 索引与旧计划归档）、`b3beb454` `#431`（迁移 `0109`–`0111` 运维登记、文档整理与状态表同步）、`b228a32a` `#442`（资产图一期晋升文档、`STATUS` 同步与 Autopilot 规则加固）、`d066743b` `#443`（Wave 2 共享证据、知识同步与写作工作区统一契约，零数据库迁移）。
- 学习工作区、恢复与示例变式：`50294284` #389（高数示例题变式异步生成与进度恢复）、`575187a6` #419（学习恢复跳过终态复测与 `hasDecisionOnly` 议程门控对齐）、`528847da` #429（E5c 通用学习工作区 UX 收敛与恢复轮询）、`00054caa` #426（Today 恢复缩短保护、已结束考试活动关闭、选择器与助理链接保留）、`610a2941` `#433`（学习工作区实时 `LearningResume` 同步与课程路线 stale-CAS 边界加固）、`6d745359` `#435`（Today/课程页/服务端多活动选择统一与议程确定性时钟）。
- 期中测试版、课程与解析：`1b934254` #422（期中测试版快速开始、专题练习与冲刺教学修复）、`53b0126f` #424（`PARSE_PARTIAL` 重试可见入口与上传错误中文化）、`f498458c` #427（课程标签页新鲜度、stale-CAS 解锁与对话连续性）、`56f7dc47` #428（考前冲刺、课程考试与模拟卷守卫加固）、`04f9a724` `#432`（上传租约过期文案、完成确认防重守卫、课程考试 `"unknown"` 冲突提示与冲刺切课过渡态重置）。
- 导师决策、批改、照片与来源隔离：`5578f6b5` #425（`0111` 显式二次批改、`V2 PhotoPractice` 照片拒绝同页恢复与 `mock_exam` 提示守卫对齐）、`72644a8b` #430（提示与只读批改路径强制 `exam-only` 来源隔离）、`f894b251` `#434`（清除 `nextLearningStep` legacy `adaptive`/`thin` 重载并复核 L0 76/76 离线基线）。
- 个人知识资产图全链路：`161f9fe1` #437（研究文档与 20 条合成样例归档）、`6e5ea779` #438（`@aistudy/contracts` 知识资产图契约与安全跳转校验）、`ed4c1724` #439（Web 知识地图工作台、SVG 拓扑画布、20 条样例回放与导航联动）、`5881c6ce` #440（`@aistudy/database` 有界只读资产图投影、HMAC Keyset 游标与 PG 集成测试）、`9918fa01` #441（`POST /api/opening/asset-graph/query` 路由、`server-only` 服务适配层、课程页入口与 Handler 集成测试）、`909ea08a` `#445`（Track 1B / 二期：`course_requirement_evidence_links` 投影为带 `sharedAttribution` 的 `derived` `hasObservation` 边、跨课同名 `knowledge/<courseId>/<nodeId>` 保持分离、游标 `scopeFingerprint` 失效、Web 跨课徽章/来源课程跳转与 Case 21）。
- 知识同步与无课程写作工作区（Wave 2）：`ee100bc1` `#446`（Track 2B / 课程资料变更知识同步：`build-course-knowledge` 合并队列、并发 `confirmNode` 冲突一次性 CAS 重试、`coveredSourceVersions`/`lastBuiltVersion` 追踪、`getWithSync`/`CourseKnowledgeSync`、`POST /api/courses/[id]/memberships` 显式 `replacesSourceId`、解析/成员/排除/删除生命周期同步钩子及 `KnowledgeRebuildControl`/`CourseKnowledge` 同步提示）；`86d4cb67` `#444`（Track 2A / 无课程多稿写作工作区与恢复：`writing-workspace-v1` 与 `course_id = null` 活动、线性 `library_documents`/`revisions`/`relations`/`properties` 存储、四维批注与单句润色采纳及 `MASTERY_NOT_ESTABLISHED` 结局、跨课程与无课程 `selectCurrentWorkspaceActivity`/`readOpeningWorkspaceActivityRecovery` 段落定位恢复、`/api/opening/writing` 路由、`WritingVariantsPanel` 及 Today 继续写作入口）。

## 待用户决定
- **迁移 `0108`–`0111` 发布就绪与 U 级部署审批**：合入不等于执行或部署。部署含 `0108`–`0111` 的版本或执行迁移前，须用户按精确目标、SHA 与操作逐次批准，并完成 `docs/operations/database-migrations.md` §2/§7–§9 的只读核对、备份与空隔离库恢复演练；跨 `0108`–`0111` 回退需另行审批兼容 H 候选，严禁删表/删列/改 `schema_migrations`。
- **线上视觉与盲解模型配置**：M0 视觉/手写批改模型配置与验收预算上限，以及 `M4-1b` 异家族盲解在私有环境中的模型、密钥与日额度配置；如需修改生产配置/关闭编译 exact 开关须逐次批准。
- **校准与定样样本**：10 道文字题人工金标与手写照片校准样本（D7），及整课高数正式抽样/定样（U 级）。
- **运维、真数据与分支清理**：D10 服务器加固与失败部署残留目录/旧参照工作区清理由用户执行或逐项授权；破坏性迁移与真数据导出/改写逐次批准；已清理 22 个历史 worktree 与 186+ 已合远端分支，剩余含独有提交的历史分支去留待用户决定。

## 待用户验收（浏览器，自己账号开 V2）
- **M0 基线（部署后再核，待用户浏览器验收）**：核对账号菜单版本号；上传带唯一标记小 PDF 并核对解析后可搜索；助理问答正常；拍照手写解答并获点评；验收后清理合成对象。
- **建课、资料解析、知识图同步与课程路由（待用户浏览器验收）**：多来源上传并设置课程用途（`teaching`/`practice`/`mock_exam`/`reference`）；同名知识点人工确认（`#230`）；`PARSE_PARTIAL` 局部重试、上传中文错误/直传租约过期提示及待核对上传项防误删（`#424`/`#432`）；课程标签页跳转（`#course-goals`/`#course-settings-heading`）、新鲜度与路线 stale-CAS 恢复边界（`#427`/`#433`）；生成学习路线并开课；Track 2B（`#446`）课程新增/替换（`replacesSourceId`）/移除/排除或删除资料后，核对 `CourseKnowledge` 同步状态提示（解析中/后台整理中/需重新整理）及 `KnowledgeRebuildControl` 任务级进度与“已整理本批……新加入的资料仍在后台继续整理”提示。
- **学习工作区与 E5b/E5c 对话流（待用户浏览器验收）**：E5b 单按钮后继卡、折叠理由/预计时间/三档把握度；E5c 通用学习工作区对话伴随、断点恢复轮询与实时 `LearningResume` 同步（`#429`/`#433`）；异步示例变式（`#389`）；Today 恢复缩短、助理链接保留及 Today/课程页多活动选择与议程状态一致性（`#426`/`#435`）。
- **无课程多稿写作工作区与跨活动恢复（待用户浏览器验收）**：Track 2A（`#444`）：在无课程或有课程状态下进入 `/opening/library/[id]`，展开右栏「多稿写作与润色」创建「A 稿 / B 稿」变体、按「论点 / 语言 / 结构 / 论据」记录批注或句子润色并单句采纳生成新版本；从 `/opening/today` 验证主按钮「继续写作：<稿件标签>」直达上次稿件与段落（含段落已删改时提示定位失效），并确认不产生课程掌握记录。
- **纠错、照片拒绝与二次批改（待用户浏览器验收）**：错后“改这道题”→再交→同族新题；两次纠偏后换方式（D4）；`V2 PhotoPractice` 照片被拒同页恢复（G2f/`#425`）；显式二次 AI 批改确认与费用提示（`0111`/`#425`）。
- **考前冲刺、模拟卷与复测闭环（待用户浏览器验收）**：期中快速开始、专题练习、模拟卷转教学、`exam-only` 提示边界、课程考试 `"unknown"` 冲突提示与冲刺页切课过渡态重置（`#422`/`#428`/`#430`/`#432`）；E.5 五步 span 全链；自动/延迟复测撤销（刷新不重建、已开始不撤销、终态复测不恢复 `#419`）。
- **个人知识资产图一期与二期跨课证据（待用户浏览器验收）**：从 `/opening/library` 页头「知识地图」入口、课程详情页「知识地图」入口或 `/opening/map` 验证目标→要求→材料与作答下钻、全部个人资产无课程笔记沿入边回溯探索、保留中心切换 4 种视角、多中心展开与分页，及点击要求「开始/继续学习这项要求」跳转课程活动（`#438`–`#441`）；并核对 Track 1B（`#445`）存在有效跨课共享技能关系时，要求邻接 `derived` `hasObservation` 边展示「跨课共享证据」徽章与来源课程/要求/版本说明、点击「查看来源课程」跳转来源课程、跨课同名知识点保持独立节点，以及共享链接变更/失效后翻页触发游标失效并回首页重读。

## 使用反馈
（用户验收发现的问题记在这里，每条一行：日期、入口、现象、期望。）
