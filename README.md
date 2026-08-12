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
- [当前实施计划：终身学习平台](docs/plans/2026-07-21-lifelong-learning-implementation.md)
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

当前仓库处于 `Phase 1 / Workspace Authorization`：

- Phase 0 完成：栈、monorepo、infra、CI
- Task 5 完成：Workspace 与统一资产契约
- Task 6 完成：Document/Block/Revision/Relation/Property 持久化
- Task 7 完成：跨课程稳定资产身份（Course + AssetMembership）
- Task 8 完成：认证、可吊销会话、Workspace 级服务端授权
- Task 9 完成：三入口应用壳、workspace 级服务端默认入口偏好与真实浏览器验收
- Task 10 核心完成：版本化 block 编辑器、追加式 revision、workspace 隔离、乐观 revision 冲突保护与本地草稿恢复；PostgreSQL 集成门禁待在具备数据库的环境中执行
- Task 11A 核心完成：真实、workspace 授权的 document/block links API；wiki-link 索引、backlink、block reference 与 soft-delete broken-link 降级均已接入编辑器；PostgreSQL integration/handler/browser 门禁待执行
- Task 11B1 核心完成：编辑器 tags 已迁移到 workspace 授权的 `library_properties` API，支持 Unicode 归一化、去重、持久化清空和失败恢复；PostgreSQL handler/browser 门禁待执行
- Task 11B2 核心完成：编辑器可创建、重设类型和删除当前笔记发出的 typed relation，并只读展示 document/block properties；关系 source/workspace 授权、冲突及 Task 11A backlink 兼容已覆盖，PostgreSQL integration/handler/browser 门禁待执行
- Task 13 核心完成：exploration、root/child branch 与 scratch/hypothesis/open-question block 已接入 `0008_explorations.sql`、workspace-bound repository、authenticated API 和真实 Explore UI；contracts/type/lint 与非数据库测试已验证，PostgreSQL integration/handler/browser 门禁待在具备 `DATABASE_URL`、`flock` 和 live browser server 的环境中执行
- Task 14 核心完成：八类 AI role policy、provider-neutral exploration-chat job、Zod 输出校验与 candidate-only 结果已接入 worker；无权检索角色不会接收 source IDs，silent role 不调用 provider，provenance 明确区分未调用与缺失 provider 元数据。10 项 focused tests、contracts/AI/worker typecheck、目标 ESLint 和 diff 检查已通过；完整 npm 门禁仍需具备 `flock` 的 Bash/WSL 环境执行。
- Task 15 核心完成：探索候选可被独立接受或拒绝；接受 note 会原子化生成 confirmed、可编辑的 library document，card/question/task 保持 typed target 与来源信息。文档可加入两门课程而不复制，并可返回来源探索。contracts/database/web TypeScript、编辑器 focused Vitest（6 项）、Playwright 用例发现与 `git diff --check` 已通过；promotion repository/handler 和完整浏览器用例仍待 `DATABASE_URL` 与 PostgreSQL `127.0.0.1:5432` 可用后执行。
- Task 17 核心完成：六类课程需求画像（memory / mathematical-procedural / language / research-writing / programming-project / free-exploration）以 Zod 契约 + 领域预设落地，每类预设带六维能力权重（识别 / 无提示回忆 / 程序执行 / 迁移应用 / 表达输出 / 限时稳定，总和 100），支持 basic/disabled 评估模式、默认值解析、权重归一化与校验；简化设置 UI（预设卡片选择 + 禁用评估开关 + 开发者设置折叠展示权重）已就绪。domain focused Vitest（17 项）、web model Vitest（5 项）、contracts/domain/web typecheck、目标 ESLint 与 `git diff --check` 已通过；本任务无数据库改动，profile 持久化与页面挂载待后续任务。
- Task 18 核心完成：一门课程可承载多个 goal（final-exam / entrance-exam / interest / maintenance / custom），`course_goals` 与 `goal_time_windows` 表（migration `0011_goals.sql`）落地，含 workspace guard、kind/phase CHECK、时间窗口排序约束与每课程每 kind 唯一约束；domain 实现确定性合并顺序（course baseline → active goal requirements → current time-window modifier → user override → 归一化到 100）。domain focused Vitest（12 项）、domain/database typecheck、目标 ESLint 与 `git diff --check` 已通过；PostgreSQL integration（`tests/integration/multi-goal-course.test.ts`）待 `DATABASE_URL` 可用后执行。
- Task 19 核心完成：free / advisory / coach 三种自主性指导模式以领域策略（`guidance-1`）落地：free 无自动计划且不锁定功能，advisory 建议需确认，coach 可在预算内重排未来任务但锁定历史与已确认知识修改；受保护探索时段（重叠检测、调度判断、时序追加）与设置 UI（模式卡片选择 + 预留探索时间管理）已就绪并挂载到设置页。domain focused Vitest（12 项）、web model Vitest（5 项）、domain/web/e2e typecheck、目标 ESLint 与 `git diff --check` 已通过；E2E 用例（`tests/e2e/guidance-modes.spec.ts`）待 live browser server 执行。

```bash
cp .env.example .env
npm run compose:up    # 需要 Docker
npm run db:migrate
npm run test:integration
npm run test:handler
npm run test:browser
npm run lint && npm run typecheck && npm test && npm run build
```

执行状态（2026-08-05，Task 16 review 修复）：revision proposal 接受流程现在在 full/partial/preserve-both 进入 append-only revision 前集中拒绝零 blocks，返回 `RevisionProposalRepositoryError("VALIDATION", "Document requires at least one block")`，因此 validation 失败不会删除 projection 或终结 proposal；partial acceptance 仍保留有其他 blocks 时的 selected removal 行为。领域/contracts/review-panel focused tests 13 项通过，domain/contracts/database typecheck、web/e2e TypeScript、目标 ESLint、`git diff --check` 与 `graphify update .` 已完成。PostgreSQL repository/handler 集成测试因未设置 `DATABASE_URL` 阻塞，未宣称 integration 通过；web wrapper typecheck 仍受 Windows 缺少 `flock` 影响；E2E 实际运行仍需 PostgreSQL/web 服务。下一功能实现项为 Task 20。

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
