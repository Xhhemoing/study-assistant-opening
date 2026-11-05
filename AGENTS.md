# Repository Guidelines

AIstudy is an npm workspaces monorepo for a lifelong-learning platform. Keep changes focused on the package or app that owns the behavior. When a package has its own `AGENTS.md`, it takes precedence for that package's conventions and verification commands.

## Project Structure

- `apps/web`: Next.js App Router UI, route handlers, and feature modules under `src/features`.
- `apps/worker`: background worker entry point and tests.
- `packages/*`: shared domain, contracts, database, AI, config, and UI packages.
- `tests/integration` and `tests/e2e`: repository/API integration tests and Playwright browser flows.
- `scripts`: repo tooling (e.g. `scripts/notion-meeting-pipeline`); `spikes`: isolated technology experiments; `docs`: product, architecture, decisions, and plans.

## Build, Test, and Development

Use Node.js 20+ and npm. Copy `.env.example` to `.env`, then run `npm install`.

- `npm run dev`: start the web app on port 3000.
- `npm test`: run the Vitest suite; use `npm run test:integration`, `npm run test:handler`, or `npm run test:browser` for focused suites.
- `npm run lint` and `npm run typecheck`: run ESLint and all TypeScript checks.
- `npm run build`: build the worker and web app.
- `npm run compose:up` and `npm run db:migrate`: start local services and apply migrations.

## Coding and UI Style

Use TypeScript and React 18-compatible syntax. Components are `PascalCase`, variables and functions are `camelCase`, and existing file names use `kebab-case`. Keep modules cohesive; around 200 lines is a prompt to review responsibilities, not a reason to split a cohesive implementation mechanically. New or changed UI must use Tailwind CSS utilities only: no native CSS files or inline `style` props; treat the existing `globals.css` as legacy. Use `lucide-react` for icons and keep accessibility states intact.

For UI work, consult the relevant sections of `docs/product/UX_AND_AI_POLICY.md` and `docs/product/PRD.md`. Load skills only when the task needs them: `classic-design` for sample selection, `impeccable` for design/audit/polish, Graphify for unfamiliar cross-file context. Small fixes do not need a chain of design, planning, review, and acceptance skills. Prefer the smallest necessary implementation and preserve validation, security, and error handling.

## 日常开发默认路径

- 先定位相关模块，简述实现选择后直接推进。需求明确的小改动无需额外审批、独立设计/计划文件或逐项验收报告；只有影响产品方向、数据迁移或跨包 API 的关键歧义才先澄清。
- 一次交付一个完整可用结果，其下组件、文件和实现任务可连续推进，不逐个插入独立 review、PR 或全量检查。实现者自查不替代正式审查：每个 PR（包括低风险文档和集成提升）均须指定 Claude Opus 5.5 high 批准与精确最新 head 的 required CI。高风险边界提前定向核对，授权、隐私、事务、迁移和数据正确性改动另走独立主线 PR 与用户明确批准，具体节奏见多工具工作流。
- 只加载当前任务需要的技能和文件；子 Agent 用于有独立收益的调查、实现或评审，不为每个小板块固定唤醒一组角色。已有页面的小修复沿用现有设计，不自动触发新界面设计流程。
- 日常只运行最接近改动的测试；TypeScript 变更补所属包类型检查，跨包公开类型变化再扩到受影响消费方。文档/注释变更检查 diff 即可，不启动服务或全套测试。
- 单元测试指定 `--project unit` 和相关文件；集成/handler 测试按改动选择。不要先跑包含所有项目的 `npm test`，又单独重复跑 integration/handler。
- CI/runner 相关改动才考虑 `verify:ci`。完整 lint/typecheck/test/build 留给现有 CI 或明确请求的完整检查；没有新修改、新失败或未解决疑点不重复执行。
- 失败处理（failure → cause → fix → recheck）：根据已有失败给出根因假设，信息不足才追加最小复现，最小修复后重跑失败命令；禁止仅重试侥幸通过，同一失败已有足够诊断信息时不为“复现”再跑。只对实际遇到的失败简述原因、修复与复查结果。
- 与当前改动无关的历史失败简述记录，不冒充通过，也不扩成无关修复。当前功能的数据丢失、越权、依赖不可用等问题必须处理；合并/发布仍遵守现有 CI，不降低门禁。
- 交付说明保持简短：改了什么、实际检查结果、验收方式（PR/CI/手动验证）和必要的后续操作。涉及数据库 migration 或破坏性变更必须记录回滚方案。本地测试通过加口头完成不是交付证据。普通开发不新建 evidence/baseline/contract 文件；发布证据仅在合并/发布阶段按现有位置记录。

## 多工具协作

主控 PM 负责目标、Kanban 调度、验收与交接，不写业务代码、不计编码车道；实现与测试由已授权 worker 执行，集成由唯一集成者执行。先读原卡目标、允许路径、parents、接口决定和最近断点；按需只读 STATUS，写入由集成者独占。分工和门禁见 [多工具开发分工](docs/operations/agent-workflow.md)，取代旧角色与派单流程；分工本身不授予提交、推送、合并或发布权限。

- 以文件、接口和资源隔离规划八条编码流，并配置独立评审与集成能力；这是目标容量，不是已运行数量或配额豁免。实际启动必须服从平台及当前上层有效配额（包括仍有效的两名实现者限制），名额不足则按依赖排队，不绕过或虚报并行。
- 项目不再以固定 3 个 Agent／3 棵 worktree 作为上限。worktree 按隔离需要和有效配额、资源及所有权准入；注册旧树不等于活跃写者，不为凑车道新建树或删除未知成果。
- 持久 Kanban 是任务执行与交回入口，workspace=worktree；优先续接原卡、原 owner 和原会话，不重复建卡、实现或 dispatcher。目标、允许路径、parents、接口决定、限定 unit／包 types、风险与结果 metadata 必填；投递不等于接受或执行。
- 同文件单 writer。共享契约、锁文件、迁移编号、schema、STATUS 及跨接口决定由唯一集成者独占协调；worker 不自行扩大 allowlist。接管须先核原 owner 已停止写入且明确交回，不能停他人任务抢权。
- 共享环境中的重验证经现有 run-heavy 串行；真正隔离运行资源且获准的 worker 才可并行验证，worktree 本身不隔离数据库、Redis、端口或锁。低资源时先限制新准入，不以本地全套测试阻塞已授权轻量实施，完整门禁交精确 CI。
- 默认实现模型沿当前获准配置，委派支持时显式写模型与强度，不静默换模型；开发成本原则上不作为限流理由，但不解除执行配额、资源与安全门禁，也不改变产品计费、预算或费用策略。

## 防御逻辑的边界

- 在真正的信任边界验证：HTTP 输入、环境配置、数据库非结构化字段、外部进程/模型返回值、持久化草稿和导入文件。内部已验证并类型化的数据直接传递；只有新的信任边界或业务不变量才增加校验。
- 每项规则保留一个明确的所有者。可合并经证实等价的重复校验，但不可仅凭 TypeScript 类型删除授权、并发控制、事务、唯一约束或业务不变量；安全保护不可为简化而移除。
- `catch` 只用于恢复、清理或在边界转换错误；不吞错返回伪成功，不做没有故障依据的重试/兜底，不为假想扩展增加通用框架。
- 默认不新增 hash、冻结 contract、baseline 或 gate。只有能描述具体失败场景，并逐项说明 Git、版本号、主键、事务、唯一约束、类型和普通测试为什么不足时才加入。gate 只设在不可逆操作、跨系统交互、安全边界或正式发布边界。前置检查不得替代真正的执行、模拟或测量；结论以实际执行所得证据为主。

## Testing

Name unit and integration tests `*.test.ts`/`*.test.tsx`; name browser tests `*.spec.ts`. Add or update the closest test for behavior changes when existing tests do not cover them. Reuse existing regression tests for behavior-preserving refactors; do not add tests that merely freeze source text, documentation wording, or implementation structure. No numeric coverage threshold is configured, so rely on meaningful branch and failure-path coverage.

### 浏览器验收分工（用户约定）

- 本地浏览器验收（页面交互、视觉/响应式、真机、浏览器 E2E）全部由用户负责；Agent 不自行或委派运行本地 Playwright、浏览器自动化、截图或真机验收。现有远端 CI 浏览器检查保持启用，不与本地分工混淆。
- Agent 实现功能、维护测试并执行非浏览器检查（单元/契约、接口/数据库、类型检查、lint、构建）。浏览器验收待完成或既有浏览器测试失败不阻塞后续开发；已确认的数据丢失、越权或依赖不可用仍须处理。
- UI 交付提供页面入口、环境/数据前提、操作步骤、预期结果和已知问题。没有用户反馈时标记“待用户浏览器验收”，不得声称浏览器通过或伪造截图证据。用户反馈问题后，Agent 定位修复并完成非浏览器回归，再交用户复验。
- 本约定优先于既有计划和技能流程中的 Agent 浏览器验收要求；不修改或禁用现有 CI 浏览器检查，不抹去历史失败，不把待验收记为通过。

## 公开仓库信息边界

- 公开文档不记录本机绝对路径、主机/IP、生产拓扑、release symlink 命名、服务启动时间、进程/PID 或重启次数等运维快照；使用不含主机信息的行为描述。原始日志、真实学习资料、账号信息和部署快照留在私有位置。
- 可公开的验证证据以精确提交、CI 链接和脱敏测试结论为主；历史快照必须标明时点，不能当作当前状态。

## Commits and Pull Requests

Use Conventional Commit prefixes such as `feat:`, `fix:`, `docs:`, and `test:`, and follow `.agents/skills/aistudy-git-workflow/SKILL.md` for safe Git operations. Push only to the authorized formal remote `study-assistant-opening`, not the legacy `origin`. PRs describe the full base-to-head diff, verification and unverified boundaries. Low-risk PRs target `integration/opening`; each needs designated Claude Opus 5.5 high approval and exact-head required CI before integration. The sole integrator promotes eligible results serially to `feat/opening-release` as soon as promotion gates pass, not on a twice-daily schedule; promotion PRs retain the same review/CI gates. High-risk authorization, privacy, transaction, migration or data-correctness changes use independent PRs to `feat/opening-release`, designated cross-family review and `needs_input` pending explicit user approval. A standing user authorization recorded in `docs/operations/agent-workflow.md` counts as explicit approval only within its stated conditions. No workflow text grants automatic deployment, migration execution, production configuration, real-data operations, destructive migrations or final sample/design sign-off. UI browser verification remains with the user; do not fabricate screenshots.

## graphify

The knowledge graph lives in `graphify-out/` (ignored; never commit it). When the user types `/graphify`, use the installed graphify skill first.

- For codebase questions, run `graphify query "<question>"` when `graphify-out/graph.json` exists; use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. Use `graphify-out/wiki/index.md` for broad navigation and read `GRAPH_REPORT.md` only for architecture review or when queries are not enough.
- Dirty `graphify-out/` files are expected and are not a reason to skip graphify, unless the task is about stale graph output or the user says not to use it.
- Graph maintenance is on demand, not a routine completion gate. After source changes, mark an existing graph stale using its `graphify-out/needs_update` flag; skip documentation/comment-only changes. Check the flag before queries: stale graphs are navigation only, and current relationships require reading current source or a requested `graphify update .`. Do not auto-refresh per task, commit, status reply or batch; do not start silent background updates. See `docs/operations/agent-workflow.md` for maintenance and output boundaries.
