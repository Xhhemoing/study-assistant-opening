# AIstudy

AIstudy 是面向长期学习与短期备考的学习平台。目标学习、自由探索、笔记与知识库共享资料、练习和学习记录；课程作为可选容器连接长期目标与阶段任务。

## 产品原则

- 界面优先展示当前状态、关键数据和下一步行动，原因与证据按需展开。
- 用户可以从学习目标、材料、自由探索或笔记开始，无需先创建课程。
- 课程可以承载多个阶段目标；学习安排兼顾时间窗口、用户偏好和能力要求。
- AI 负责减少机械工作、解释和提出建议；正式作答、知识确认与高影响变更由用户决定。
- 共享内容、个人学习状态和协作状态在数据层分离。

## 当前状态与文档

当前开发主线为 `feat/opening-release`。已合入内容、进行中的切片、部署情况和验收限制统一记录在 [项目状态看板](docs/STATUS.md)；历史计划和局部测试记录不代表当前版本已部署或完成产品验收。

- [产品规格](docs/product/PRD.md) · [场景预设与学习策略](docs/product/SCENARIOS.md)
- [界面信息层级与 AI 交互规则](docs/product/UX_AND_AI_POLICY.md)
- [系统架构](docs/architecture/ARCHITECTURE.md) · [数据模型与预测系统](docs/architecture/DATA_MODEL_AND_PREDICTION.md)
- [技术栈决策](docs/decisions/ADR-001-stack.md)
- [CI 与测试说明](docs/operations/ci.md) · [部署说明](docs/operations/hermes-deployment.md)
- [研究与算法候选库](docs/brainstorm/README.md)
- [开发协作约定](AGENTS.md)

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

## 仓库结构

| 路径 | 职责 |
|---|---|
| `apps/web` | Next.js 页面、路由与应用服务 |
| `apps/worker` | 后台任务处理 |
| `packages` | 契约、领域逻辑、数据库、AI、配置和 UI |
| `services/parser` | Python 资料解析 |
| `tests` | 集成、契约、工具与浏览器测试 |
| `infra` | 本地服务与部署配置 |
| `docs` | 产品、架构、决策与运维文档 |

## 许可证

本项目代码以 [GNU AGPL-3.0](./LICENSE) 发布。以网络服务形式对外提供本项目的衍生版本时，须按许可证第 13 节向远程用户提供对应源代码。
