# AIstudy

AIstudy 是一个云端优先、面向终身使用的学习平台。它以目标学习、自由探索、笔记与知识库为三个平等入口，通过长期课程、多个阶段目标和统一资产层连接资料、思考、创作、练习、记忆与考试。

## 产品原则

- 默认界面只显示少量结果：状态、关键数据、下一步行动。
- 点击结果可展开原因、证据和解决路径；完整参数仅在开发者设置中显示。
- 用户无需创建课程或考试目标即可开始自由探索、笔记和知识整理。
- 课程是可选的长期容器，可同时承载多个目标、时间窗口和不同能力要求。
- 期末考试、高考、考研和自定义目标使用版本化场景预设，用户可覆盖预设。
- 探索内容默认保留为草稿，由用户选择性沉淀为笔记、关系、卡片、题目或课程任务。
- 原生建设强笔记、探索、练习和 SRS；深度阅读、数据库视图和白板分阶段增强。
- 首发为连接云端服务器的 Web 应用；后续开放自托管，并提供具备少量离线能力的客户端。
- 共享学习内容、个人学习状态和班级协作状态从数据层分离。
- AI 负责降低机械成本和提出建议；关键知识判断、正式作答和高影响变更由用户确认。

## 文档入口

- [Brainstorm 研究与算法候选库](docs/brainstorm/README.md)
- [Brainstorm 研究索引](docs/brainstorm/INDEX.md)
- [项目算法与工程做法地图](docs/brainstorm/ALGORITHM_MAP.md)
- [已批准：终身学习平台调整设计](docs/plans/2026-07-21-lifelong-learning-design.md)
- [当前实施计划：开学版及能力扩展](docs/superpowers/plans/2026-09-12-opening-release-implementation.md)
- [质量修复与双Agent协作计划](docs/plans/2026-09-18-quality-dual-agent.md)
- [任务状态与证据](docs/superpowers/plans/opening-release/tasks.json)
- [长期平台路线](docs/plans/2026-07-21-lifelong-learning-implementation.md)
- [已批准：系统实现架构重审](docs/plans/2026-07-22-system-architecture-rethink-design.md)
- [ADR-001：技术栈锁定](docs/decisions/ADR-001-stack.md)
- [CI 说明](docs/operations/ci.md)
- [云端部署说明](docs/operations/cloud-deployment.md)
- [项目章程与产品规格](docs/product/PRD.md)
- [场景预设与学习策略](docs/product/SCENARIOS.md)
- [界面信息层级与 AI 交互规则](docs/product/UX_AND_AI_POLICY.md)
- [系统架构](docs/architecture/ARCHITECTURE.md)
- [核心数据模型与预测系统](docs/architecture/DATA_MODEL_AND_PREDICTION.md)
- [资源平台、开源与商业化](docs/business/OPEN_SOURCE_AND_MARKETPLACE.md)
- [旧版备考中心实施计划，仅作历史参考](docs/roadmap/EXECUTION_PLAN.md)
- [Hermes 执行计划](.hermes/plans/2026-07-21_191637-aistudy-project-plan.md)

## 当前阶段

当前开发主线为 `feat/opening-release`，以开学版总计划、tasks.json及对应证据为准。已落盘迁移为0001–0021；后续编号由集成者统一分配。近期真实材料上传/解析记录见 [T02/T03证据](docs/superpowers/evidence/2026-09-18-opening-release/t02-t03-tutor-verified.md)。局部verified不等于完整产品验收：历史上下文传输、每日预算、真实模型语义、真机和恢复门禁仍需完成，具体工作顺序见质量修复计划。

以下保留2026-08-15 Phase 1历史快照，不代表当前工作区、工具可用性或远端CI状态。冻结基线见 [Phase 1 修复基线](docs/releases/phase-1-repair-baseline.md)；旧问题见 [学习闭环问题总账](docs/quality/2026-08-15-learning-loop-issue-register.md)。

### Phase 1历史：已提交且可追溯

- monorepo、CI 工作流、PostgreSQL/Redis/MinIO 基础设施定义。
- Workspace、统一资产契约、Document/Block/Revision/Relation/Property、Course/AssetMembership。
- 认证、可吊销会话和 Workspace 级服务端授权。
- 版本化 block 编辑、wiki link/backlink、typed relation、properties 和追加式 revision。
- Exploration、候选审核、接受候选生成资产，以及 provider-neutral 的 candidate-only AI job 契约。
- 课程需求画像、多个课程目标、指导模式和可选 onboarding 路径。
- HEAD 中已提交的数据库 migration 为 `0001` 至 `0015`。
- Learning Event、Cards、Practice content、Assessment replay、Attempts、Reviews。
- Native Backup export/restore 路由，以及 Markdown/Anki 导出投影。
- `/api/attempts` 已按 practice session + 内容版本做服务端判题；Learn/练习 UI 主读尚未切到服务端内容包。
- SRS 评分路径已有 `FOR UPDATE` 行锁，`tests/integration/card-concurrency.test.ts` 已在 HEAD。
- `0014_learning_event_delete_guard.sql` 已提交表级 no-delete trigger（无 session-variable 旁路）。
- 开发预览页：`/preview/notebook`、`/preview/notion-import`。

### Phase 1历史：工作区存在但尚未完整验证

- 工作区另有未提交的 `0016_goal_and_plan_state.sql` 与 `/api/goals` 草稿，属于 AIST-002 下一片，不视为已发布。
- 完整 PostgreSQL、handler、browser、build 和 CI 门禁未在干净环境通过。本地缺少 Docker CLI 与 PATH 中的 `bash`；GitHub Actions `main` 最新 run 在 Initialize containers 因 `bitnami/minio:2025.4.22` 镜像不存在而失败。
- “文件存在”“源码审查通过”或“当前工作区可运行”都不等于已发布能力。

### Phase 1历史：未接通 / 规划中

- Learn 主读仍是 `createMockProvider()` + localStorage；练习页仍从 Mock 取题。
- 账号级级联删除 / 合规删除流程未做（`0012` 仍对 workspace/user 使用 `ON DELETE CASCADE`）。
- Native Backup 完整 Workspace 恢复演练和权限门禁未作为 CI 证据。
- Transactional Outbox、真实 BullMQ Worker、受预算约束的 AI Provider。
- Marketplace、教师/班级、离线客户端、插件 SDK、pgvector 和高级自适应模型继续暂缓。

### 本地验证

```bash
cp .env.example .env
npm run verify:ci
npx vitest run --project unit

# 完整门禁需要 Docker 服务与 Playwright Chromium
npm run compose:up
npm run db:migrate
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run test:handler
npm run test:browser
npm run build
```

Unit通过不代表完整系统通过。集成测试须设置独立测试数据库与`OPENING_TEST_DB=1`，不能对用户数据库执行测试；browser、真实模型、恢复演练和远端CI需各自保留证据。本地结果不能替代当前提交的GitHub Actions `quality`门禁。详细前置条件见 [CI说明](docs/operations/ci.md)。

## 预定技术方向

- Web：TypeScript + Next.js App Router
- 数据库：PostgreSQL；向量检索首选 `pgvector`
- 异步任务：Redis + BullMQ
- 对象存储：S3 兼容接口
- 部署：容器化云部署；后期提供 Docker Compose 自托管
- 测试：Vitest + Playwright + API/Schema 契约测试

具体版本已在 Task 1 Spike 中锁定，见 `docs/decisions/ADR-001-stack.md`。

## 本地项目同步

- 同步根路径：`/home/ubuntu/work/AIstudy`
- 同步工具：`/home/ubuntu/work/sync`

```bash
pc-sync.sh push AIstudy
pc-sync.sh pull AIstudy
```

## GitHub 一键同步

首次登录 GitHub 后，在项目目录执行：

```bash
./sync.sh
```

也可以直接指定提交说明：

```bash
./sync.sh "docs: update project plan"
```

脚本会自动检查 GitHub 登录状态、提交当前变更并推送到 `origin` 的当前分支。它不保存 Token，认证由 GitHub CLI 管理。
