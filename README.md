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

- [已批准：终身学习平台调整设计](docs/plans/2026-07-21-lifelong-learning-design.md)
- [当前实施计划：终身学习平台](docs/plans/2026-07-21-lifelong-learning-implementation.md)
- [已批准：系统实现架构重审](docs/plans/2026-07-22-system-architecture-rethink-design.md)
- [ADR-001：技术栈锁定](docs/decisions/ADR-001-stack.md)
- [CI 说明](docs/operations/ci.md)
- [项目章程与产品规格](docs/product/PRD.md)
- [场景预设与学习策略](docs/product/SCENARIOS.md)
- [界面信息层级与 AI 交互规则](docs/product/UX_AND_AI_POLICY.md)
- [系统架构](docs/architecture/ARCHITECTURE.md)
- [核心数据模型与预测系统](docs/architecture/DATA_MODEL_AND_PREDICTION.md)
- [资源平台、开源与商业化](docs/business/OPEN_SOURCE_AND_MARKETPLACE.md)
- [旧版备考中心实施计划，仅作历史参考](docs/roadmap/EXECUTION_PLAN.md)
- [Hermes 执行计划](.hermes/plans/2026-07-21_191637-aistudy-project-plan.md)

## 当前阶段

当前仓库处于 `Phase 1 / Library Persistence`：

- Phase 0 完成：栈、monorepo、infra、CI
- Task 5 完成：Workspace 与统一资产契约
- Task 6 完成：Document/Block/Revision/Relation/Property 持久化与仓储

```bash
cp .env.example .env
npm run compose:up    # 需要 Docker
npm run db:migrate
npm run test:integration
npm run lint && npm run typecheck && npm test && npm run build
```

下一步：Task 7 — 跨课程稳定资产身份（Course + AssetMembership）。

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
