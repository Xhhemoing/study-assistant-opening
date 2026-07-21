# 系统架构

## 1. 架构目标

首发为连接官方服务端的云端 Web 应用。架构优先保证：

- 快速交付备考闭环；
- 预测和策略可替换、可重算；
- 共享内容与个人状态严格分离；
- 异步 AI 和文档处理失败不阻塞核心练习；
- 后期能够开放自托管和派生轻量客户端；
- 不在数据不足时过早拆微服务。

## 2. 推荐技术基线

版本必须在 Milestone 0 通过官方文档和最小验证锁定。

| 层 | 推荐选择 | 理由 |
|---|---|---|
| Web | Next.js App Router + TypeScript | 服务端渲染、路由和 API 边界统一，适合单体优先 |
| UI | React + 项目内设计令牌 + 无障碍组件基础 | 支持渐进式信息展示和响应式任务界面 |
| 数据访问 | Drizzle ORM 或等价类型安全方案 | Schema 可审查、迁移可版本化，避免运行时魔法 |
| 主数据库 | PostgreSQL | 关系、事务、JSONB、全文和后续行级策略均适合 |
| 向量 | pgvector，若验证通过 | 减少 MVP 的独立基础设施 |
| 队列 | Redis + BullMQ | 解析、AI、索引和批量重算异步化 |
| 对象存储 | S3 兼容 | 原始文件、快照、导出包和派生文件 |
| 身份 | 成熟会话认证库，HttpOnly Cookie | Web 首发，避免自行实现密码与会话协议 |
| 校验 | Zod 或等价 Schema | API、任务载荷、配置和 AI 结构化输出统一校验 |
| 测试 | Vitest + Playwright + 契约测试 | 覆盖纯逻辑、API和核心浏览器流程 |
| 部署 | 容器镜像 + 托管 PostgreSQL/Redis/S3 | 官方云先行；后续可组合为 Docker Compose |

## 3. 单体优先的部署拓扑

```text
Browser
   |
   v
Web Application
- UI and server routes
- Auth and permissions
- Study planning API
- Resource marketplace API
- Export API
   |
   +--> PostgreSQL
   +--> S3-compatible storage
   +--> Redis/BullMQ
              |
              v
         Worker Process
         - document parsing
         - AI generation
         - embedding/indexing
         - status recomputation
         - export packaging
```

Web 与 Worker 来自同一仓库、共享领域包和 Schema，但使用不同启动入口。只有当负载和组织边界得到证据支持后才拆服务。

## 4. 建议仓库结构

```text
apps/
  web/                  Next.js Web 应用
  worker/               BullMQ Worker 入口
packages/
  domain/               领域类型、规则、状态计算、策略模板
  database/             PostgreSQL Schema、迁移、Repository
  contracts/            API、任务、导入导出 Schema
  ai/                   Provider 接口、Prompt、结构化审核
  config/               环境和功能开关
  ui/                   设计令牌和共享组件
docs/                   产品、架构、决策和运行文档
infra/
  docker/                本地与自托管容器定义
  migrations/            部署相关迁移脚本
tests/
  contract/              Schema 和 API 契约测试
  integration/           DB/Queue/Object storage 集成测试
  e2e/                   Playwright 核心流程
```

## 5. 领域模块边界

### Identity

账户、会话、组织和权限。不包含学习预测逻辑。

### Goals and Strategy

考试目标、场景模板、模板继承、用户覆盖和策略版本。

### Content

来源、快照、资源包、考纲、考点、题目、题解和内容版本。

### Learning Events

作答、提示、用时、信心、错因、复习和模考事件。事件追加写，不原地重写历史。

### Assessment

能力切片、状态、原因、建议和证据快照。全部是派生结果，可按模型版本重算。

### Planning

今日任务、时间预算、任务队列和完成状态。策略输出不得直接修改历史事件。

### AI Orchestration

模型提供商、结构化生成、成本、重试、审核和 provenance。不能直接写入正式共享内容，必须走候选/审核流程。

### Marketplace

资源包发布、版本、Fork、审核、评价、举报、授权和下载。

### Export and Portability

原生完整备份、开放协议包、CSV/Anki/Markdown 投影及损失报告。

## 6. API 约束

- 外部和内部 API 使用版本化契约；
- 所有输入在边界处校验；
- 错误统一为机器码、用户信息和可选细节；
- 列表必须分页；
- 创建和异步任务提交支持幂等键；
- 更新共享内容使用乐观并发版本；
- 学习事件默认只追加；修正通过追加更正事件完成；
- 派生评估必须返回 `strategy_version`、`model_version` 和 `evidence_snapshot_id`；
- AI Provider 只能返回经过 Schema 校验的候选数据。

## 7. 关键事件流

### 作答到下一步

```text
Submit Attempt
→ validate and append LearningEvent
→ enqueue assessment recompute
→ derive AbilitySlices and SummaryStatus
→ planner reads strategy + new assessment
→ update future TaskQueue
→ UI receives concise result
```

核心作答写入成功后即向用户返回；若派生计算延迟，显示“正在更新”，不能让用户丢失答案。

### 资源包更新

```text
Publisher releases PackageVersion N+1
→ subscriber receives diff
→ choose follow / pin / fork
→ new tasks reference N+1
→ historical attempts continue referencing old content version
```

禁止用新内容覆盖旧作答所引用的题目版本。

### AI 生成内容

```text
User requests candidate
→ create AIJob with inputs and policy
→ worker calls provider
→ validate structured output
→ run source/support checks
→ save CandidateArtifact
→ user/reviewer approves
→ create formal content version
```

## 8. 可用性与降级

- AI 服务不可用：练习、复习和规则计划仍可使用；
- 队列不可用：学习事件先写数据库，任务进入 outbox 后重试；
- 向量检索不可用：降级为元数据和全文检索；
- 对象存储不可用：禁止宣称上传成功，保留可重试状态；
- 预测失败：使用最近已知结果或简单规则，不生成虚假状态；
- 资源更新冲突：固定旧版本并要求显式解决。

## 9. 安全与运营最低线

当前不把未成年人专项合规纳入首期范围，但仍必须具备：

- HTTPS、HttpOnly/SameSite Cookie；
- 密码和会话使用成熟库；
- 文件类型、大小和解析隔离；
- 服务端权限校验，不能只依赖 UI；
- 对象存储使用短期签名 URL；
- AI Provider 不自动获得全部用户数据；
- 审计资源发布、内容修改和管理员操作；
- 密钥不进入代码库或客户端；
- 备份恢复演练和数据库迁移回滚方案。

## 10. 后期开源与客户端演进

### 自托管

官方发布：

- 版本化容器镜像；
- Docker Compose 参考部署；
- 数据库迁移工具；
- S3/Redis/PostgreSQL 配置说明；
- 兼容性和升级矩阵。

### 客户端

后期客户端不复制全部服务端逻辑。首批本地能力：

- 下载今日任务和指定资源；
- 离线完成练习；
- 追加本地学习事件；
- 联网后幂等同步；
- 查看最近结果；
- 不在第一版客户端做完整本地 AI、资源市场和复杂合并。

## 11. 架构决策门

以下决策在实施前必须通过 Spike：

1. Next.js 认证方案及自托管兼容性；
2. Drizzle 对事务、迁移和测试数据库的适用性；
3. pgvector 对预期资料规模的检索质量和运维成本；
4. BullMQ 幂等、重试和 outbox 集成；
5. PDF 文本/页码锚点的受控范围；
6. 完整备份包恢复与版本迁移；
7. 后期桌面壳采用 PWA、Tauri 或其他方案。
