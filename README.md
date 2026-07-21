# AIstudy

AIstudy 是一个面向备考学习者的云端优先学习决策平台。它不追求把所有知识强制拆成卡片，而是围绕具体考试目标，将资料、考点、练习、错因、复习和模考连接为可调整的学习闭环。

## 产品原则

- 默认界面只显示少量结果：状态、关键数据、下一步行动。
- 点击结果可展开原因、证据和解决路径；完整参数仅在开发者设置中显示。
- 期末考试、高考、考研和自定义目标使用版本化场景预设，用户可覆盖预设。
- 首发为连接云端服务器的 Web 应用；后续开放自托管，并提供具备少量离线能力的客户端。
- 共享学习内容、个人学习状态和班级协作状态从数据层分离。
- AI 负责降低机械成本和提出建议；关键知识判断、正式作答和高影响变更由用户确认。

## 文档入口

- [项目章程与产品规格](docs/product/PRD.md)
- [场景预设与学习策略](docs/product/SCENARIOS.md)
- [界面信息层级与 AI 交互规则](docs/product/UX_AND_AI_POLICY.md)
- [系统架构](docs/architecture/ARCHITECTURE.md)
- [核心数据模型与预测系统](docs/architecture/DATA_MODEL_AND_PREDICTION.md)
- [资源平台、开源与商业化](docs/business/OPEN_SOURCE_AND_MARKETPLACE.md)
- [可执行实施计划](docs/roadmap/EXECUTION_PLAN.md)
- [Hermes 执行计划](.hermes/plans/2026-07-21_191637-aistudy-project-plan.md)

## 当前阶段

当前仓库处于 `Specification Baseline` 阶段：产品边界、核心架构、数据契约和实施顺序已经建立，尚未创建应用代码和生产基础设施。

下一步执行 `docs/roadmap/EXECUTION_PLAN.md` 的 Milestone 0，完成技术验证和项目脚手架。

## 预定技术方向

- Web：TypeScript + Next.js App Router
- 数据库：PostgreSQL；向量检索首选 `pgvector`
- 异步任务：Redis + BullMQ
- 对象存储：S3 兼容接口
- 部署：容器化云部署；后期提供 Docker Compose 自托管
- 测试：Vitest + Playwright + API/Schema 契约测试

具体版本在 Milestone 0 通过官方文档和最小技术验证锁定，不在规格阶段凭空固定。

## 本地项目同步

- 同步根路径：`/home/ubuntu/work/AIstudy`
- 同步工具：`/home/ubuntu/work/sync`

```bash
pc-sync.sh push AIstudy
pc-sync.sh pull AIstudy
```
