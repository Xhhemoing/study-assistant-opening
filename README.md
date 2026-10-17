# AIstudy

AIstudy 是一个云端优先、面向终身使用的学习平台。它以目标学习、自由探索、笔记与知识库为三个平等入口，通过长期课程、多个阶段目标和统一资产层连接资料、思考、创作、练习、记忆与考试。

当前主线是把一次学习接到下一次行动：开始学习 → 主讲或练习 → 作答与核对 → 有来源的学习证据 → 可解释的计划草案 → 确认执行 → 反馈、复测与调整。

## 从这里开始

| 要了解什么 | 入口 |
|---|---|
| 当前进度、主干、阻塞与下一步 | [项目状态看板](docs/STATUS.md) |
| 系统如何组成、代码改在哪里 | [系统架构与学习闭环数据流](docs/architecture/ARCHITECTURE.md) |
| 本轮闭环切片、整合状态与回滚 | [学习闭环剩余实施计划](docs/plans/2026-10-16-learning-loop-remaining-plan.md) |
| 用户如何验收学习测量与请求恢复 | [学习测量插件说明](docs/quality/learning-measurement-plugin.md) |
| 如何开发、分工和验证 | [仓库开发约定](AGENTS.md)、[多工具协作](docs/operations/agent-workflow.md)、[CI 说明](docs/operations/ci.md) |
| 如何部署与自用验收 | [云端部署](docs/operations/cloud-deployment.md)、[自适应副驾驶发布清单](docs/operations/adaptive-copilot-release-checklist.md) |

## 当前阶段

开发主干是 `study-assistant-opening` 远端的 `feat/opening-release`。截至 2026-10-17，学习闭环 S1–S7（任务/建议反馈、局部重排、诊断、矩阵窄题评价、阶段成果、教练控制、对话转计划）与 BKT 真实使用测量插件均已合入；当前主干基线、PR 与完整 CI 结果统一记录在 [STATUS](docs/STATUS.md)，不再以早期任务账本推断当前进度。

仓库已落盘迁移为 `0001`–`0069`，位置是 `packages/database/src/migrations`。文件存在和主干 CI 成功不代表 Hermes 已部署或数据库已迁移；现场 SHA、实际迁移、开关、Worker/Parser 与恢复情况仍须按发布清单核实。浏览器交互、真实模型表现与学习收益分别验收；没有反馈的项保持待验收。

当前系统采用模块化单体：Next.js Web 承载页面/API 与应用服务，独立 BullMQ Worker 承载长任务，PostgreSQL 保存业务事实，Redis 负责投递，S3 保存对象，Python CLI 执行受控解析。contracts/domain/database/ai/config/jingwei/ui 的职责、实际依赖及一个完整闭环见 [架构文档](docs/architecture/ARCHITECTURE.md)。

## 产品原则

- 默认界面只显示少量结果：状态、关键数据、下一步行动；原因、证据与解决路径按需展开，完整参数放在开发者设置。
- 用户无需创建课程或考试目标即可开始自由探索、笔记和知识整理。课程是可选的长期容器，可承载多个目标、时间窗口和能力要求。
- 期末考试、高考、考研和自定义目标使用版本化场景预设，用户可覆盖预设。
- 探索内容默认保留为草稿，由用户选择性沉淀为笔记、关系、卡片、题目或课程任务；同一资产可跨课程与目标复用。
- 原生建设强笔记、探索、练习和 SRS；深度阅读、数据库视图和白板分阶段增强。
- AI 降低机械成本并提出建议；作答事实、核对、推导与候选分开。学习完成不直接等于掌握，正式内容和高影响变更保留确认边界。
- 共享学习内容、个人学习状态和班级协作状态从数据层分离。
- 首发为连接云端服务器的 Web 应用；后续开放自托管，并提供具备少量离线能力的客户端。

## 本地开发与验证

使用 Node.js 20+ 与 npm。复制 `.env.example` 为 `.env` 后安装依赖；启动后台作业前按 [Parser 说明](services/parser/README.md) 准备 Python 依赖与本地模型缓存。

```bash
npm ci
npm run compose:up
npm run db:migrate
npm run dev
```

Web 默认端口为 3000；Worker 在另一个终端运行 `npm run worker:dev`。环境变量与密钥填写见 [环境示例](.env.example)，服务端开关与客户端能力协议见架构文档；不要把服务端凭据放进客户端配置。

日常只运行最近的相关测试与受影响包类型检查，按需检查改动文件的 lint。例如编辑器草稿改动：

```bash
npx vitest run --project unit apps/web/src/features/editor/local-draft.test.ts
npm run typecheck -w @aistudy/web
```

纯文档改动检查内容、链接与 diff。`npm run verify:ci` 用于 CI/runner 变更或排查；完整检查按现有 CI 执行，不重复作为每次开发的前置，命令见 [CI 说明](docs/operations/ci.md)。没有新改动或失败，不重复已通过的检查。

集成测试须使用独立测试数据库与 `OPENING_TEST_DB=1`，不能对用户数据库执行测试。浏览器验收由用户负责，Agent 未获明确授权不自行或委派运行；尚未验收标记“待用户浏览器验收”。现有 CI 浏览器检查保持不变，合并与发布仍须通过当前提交的 `quality` 门禁，本地结果不能替代它。

## 产品、设计与研究资料

| 类别 | 文档 |
|---|---|
| 产品与交互 | [产品规格](docs/product/PRD.md)、[场景预设与学习策略](docs/product/SCENARIOS.md)、[界面信息层级与 AI 规则](docs/product/UX_AND_AI_POLICY.md) |
| 平台方向 | [终身学习平台调整设计](docs/plans/2026-07-21-lifelong-learning-design.md)、[长期实施计划](docs/plans/2026-07-21-lifelong-learning-implementation.md) |
| 架构背景 | [系统实现架构重审](docs/plans/2026-07-22-system-architecture-rethink-design.md)、[ADR-001：技术栈锁定](docs/decisions/ADR-001-stack.md)、[核心数据模型与预测系统](docs/architecture/DATA_MODEL_AND_PREDICTION.md) |
| 研究候选 | [Brainstorm 说明](docs/brainstorm/README.md)、[研究索引](docs/brainstorm/INDEX.md)、[算法与工程做法地图](docs/brainstorm/ALGORITHM_MAP.md) |
| 长期扩展 | [资源平台、开源与商业化](docs/business/OPEN_SOURCE_AND_MARKETPLACE.md) |
| 附属工具 | [智学课 → Notion AI Meeting 转写流水线](scripts/notion-meeting-pipeline/README.md) |

研究候选与早期设计用于解释方向；具体实现和当前缺口以架构、STATUS、当前切片计划与代码为准。资源市场、教师/班级、离线客户端、插件 SDK、pgvector 和高级自适应模型不作为当前主闭环已发布能力。

## 历史资料

以下入口保留历史决策与验收背景，不代表当前工作区、工具或部署状态：

- [Phase 1 修复基线](docs/releases/phase-1-repair-baseline.md) 与 [2026-08-15 学习闭环问题总账](docs/quality/2026-08-15-learning-loop-issue-register.md)：早期内容、学习事件、练习、备份等基础；其中 Mock 主读、未接通 Worker、0015/0016 迁移及当时工具缺失仅是历史快照。
- [开学版及能力扩展计划](docs/superpowers/plans/2026-09-12-opening-release-implementation.md) 与 [历史任务账本](docs/superpowers/plans/opening-release/tasks.json)。
- [质量修复与双 Agent 计划](docs/plans/2026-09-18-quality-dual-agent.md)、[2026-09-21 审查综合](docs/plans/2026-09-21-review-synthesis.md)、[T02/T03 材料证据](docs/superpowers/evidence/2026-09-18-opening-release/t02-t03-tutor-verified.md)。
- [旧版备考中心路线](docs/roadmap/EXECUTION_PLAN.md)。

原个人同步环境使用 `/home/ubuntu/work/AIstudy` 与 `/home/ubuntu/work/sync`，相应命令为 `pc-sync.sh push AIstudy` / `pc-sync.sh pull AIstudy`；这些路径不是所有开发环境的默认前提。

## 许可证

本项目代码以 [GNU AGPL-3.0](./LICENSE) 发布。以网络服务形式对外提供本项目的衍生版本时，须按许可证第 13 节向远程用户提供对应源代码。
