# AIstudy

AIstudy 是面向所有人的 AI 终身学习空间——目标学习、自由探索、笔记与知识库三个入口平等、共享资料、练习与学习记录；课程作为可选容器连接长期目标与阶段任务。

## 产品原则

- **三入口平等：** 用户可以从目标学习、自由探索或笔记与知识库任一入口开始，无需先创建课程、目标或计划。
- **证据与连续性：** 区分“受助做对”与“独立做对”；帮助随时可用，在学习者选择验证时撤掉帮助，并用延迟后的同类未见题证明掌握。
- **结果优先：** 界面优先展示当前状态、关键数据和下一步行动，原因与证据按需展开。
- **AI 是安静的伙伴：** AI 负责减少机械工作、解释与提出候选；证据资格、正式作答、知识确认与高影响变更由确定性程序和用户决定。
- **知识资产主权：** 共享内容、个人状态与协作状态分离；笔记、作品与作答史支持完整导出。

## 当前状态与文档

当前开发主线为 `feat/opening-release`。实时交付进度、待审批事项与浏览器验收清单记录在 [项目状态看板](docs/STATUS.md)；历史计划和局部测试记录不代表当前版本已部署或完成产品验收。

- **理念唯一真源：** [AI + 学习论（最终版）](docs/product/LEARNING_THEORY.md)
- **产品规格：** [PRD v1.0](docs/product/PRD.md) · [场景预设与学习策略](docs/product/SCENARIOS.md) · [界面信息层级与 AI 交互规则](docs/product/UX_AND_AI_POLICY.md)
- **项目现状与开发计划：** [易懂版总览](docs/roadmap/OVERVIEW.md) · [架构开发计划](docs/roadmap/ARCHITECTURE_PLAN.md) · [算法开发计划](docs/roadmap/ALGORITHM_PLAN.md)
- **决策与架构：** [决策登记与测量口径](docs/decisions/DECISIONS.md) · [系统架构](docs/architecture/ARCHITECTURE.md) · [数据模型与预测系统](docs/architecture/DATA_MODEL_AND_PREDICTION.md) · [技术栈决策](docs/decisions/ADR-001-stack.md)
- **开发与运维：** [文档总导航](docs/README.md) · [CI 与测试说明](docs/operations/ci.md) · [部署说明](docs/operations/hermes-deployment.md) · [开发协作约定](AGENTS.md)

数据库迁移保存在 `packages/database/src/migrations/`，以代码中的迁移文件和数据库已应用记录为准；README 不维护易失效的迁移编号或任务数量。

## 本地启动

需要 Node.js 20+、npm 和 Docker Compose；CI 使用 Node.js 22。已有环境文件应保留，仅在首次配置时将 `.env.example` 复制为 `.env`，按需填写配置。

```bash
npm ci
npm run compose:up
npm run db:migrate
npm run dev
```

Web 默认在 `http://localhost:3000`。需要处理后台任务时，在另一终端运行：

```bash
npm run worker:dev
```

资料解析还需要 Python 解析服务的依赖与离线模型，具体安装步骤见 [parser README](services/parser/README.md)。外部模型和导入连接按环境配置启用，勿将真实密钥提交到仓库。

## 开发验证

日常修改优先运行对应测试与所属包的类型检查，例如：

```bash
npx vitest run --project unit packages/ui/src/workspace-navigation.test.tsx
npm run typecheck -w @aistudy/ui
```

集成和路由测试必须使用隔离测试数据库，并设置 `OPENING_TEST_DB=1` 与 `OPENING_TEST_DATABASE_URL`；启动和安全限制见 [CI 说明](docs/operations/ci.md#opening-parser-and-isolated-test-bootstrap)。浏览器 E2E 使用独立的 `_e2e` 数据库。

CI 保留 lint、类型检查、工具脚本、单元与契约、数据库集成、路由、浏览器和构建检查。合并与发布以对应提交的 CI 结果为准。`HERMES_HEAVY_ENABLED=0` 可在隔离环境跳过共享开发主机的本地锁和 CPU/IO 调度限制；默认保留这些保护。
