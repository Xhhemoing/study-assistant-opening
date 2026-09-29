# Repository Guidelines

AIstudy is an npm workspaces monorepo for a lifelong-learning platform. Keep changes focused on the package or app that owns the behavior.

## Project Structure

- `apps/web`: Next.js App Router UI, route handlers, and feature modules under `src/features`.
- `apps/worker`: background worker entry point and tests.
- `packages/*`: shared domain, contracts, database, AI, config, and UI packages.
- `tests/integration` and `tests/e2e`: repository/API integration tests and Playwright browser flows.
- `spikes`: isolated technology experiments; `docs`: product, architecture, decisions, and plans.

## Build, Test, and Development

Use Node.js 20+ and npm. Copy `.env.example` to `.env`, then run `npm install`.

- `npm run dev`: start the web app on port 3000.
- `npm test`: run the Vitest suite; use `npm run test:integration`, `npm run test:handler`, or `npm run test:browser` for focused suites.
- `npm run lint` and `npm run typecheck`: run ESLint and all TypeScript checks.
- `npm run build`: build the worker and web app.
- `npm run compose:up` and `npm run db:migrate`: start local services and apply migrations.

## Coding and UI Style

Use TypeScript and React 18-compatible syntax. Components are `PascalCase`, variables and functions are `camelCase`, and existing file names use `kebab-case`. Keep modules cohesive; around 200 lines is a prompt to review responsibilities, not a reason to split a cohesive implementation mechanically. New or changed UI must use Tailwind CSS utilities only: do not add native CSS files or inline `style` props; treat the existing `globals.css` as legacy. Use `lucide-react` for icons and keep accessibility states intact.

For UI work, consult the relevant sections of `docs/product/UX_AND_AI_POLICY.md` and `docs/product/PRD.md`. Load skills only for the task: `classic-design` for sample selection, `impeccable` for design/audit/polish, Graphify for unfamiliar cross-file context. Small fixes do not require a chain of design, planning, review, and acceptance skills. Keep generated graph output out of commits. Prefer the smallest necessary implementation and preserve validation, security, and error handling.

## 日常开发默认路径

- 先定位相关模块，简述实现选择后直接推进。需求明确的小改动无需额外审批、独立设计/计划文件或逐项验收报告；只有影响产品方向、数据迁移或跨包 API 的关键歧义才先澄清。
- 一次交付一个可用切片。只加载当前任务需要的技能和文件；子 Agent 用于互不冲突的独立任务，避免重复读取、实现和检查。
- 日常只运行最接近改动的测试；TypeScript 变更补所属包类型检查，跨包公开类型变化再扩到受影响消费方。文档/注释变更检查 diff 即可，不启动服务或全套测试。
- 单元测试指定 `--project unit` 和相关文件；集成/handler 测试按改动选择。不要先跑包含所有项目的 `npm test`，又单独重复跑 integration/handler。
- CI/runner 相关改动才考虑 `verify:ci`。完整 lint/typecheck/test/build 留给现有 CI 或明确请求的完整检查；没有新修改、新失败或未解决疑点不重复执行。同一失败已有足够诊断信息时不为“复现”再跑一次，修复后重跑失败命令。
- 与当前改动无关的历史失败简述记录，不冒充通过，也不扩成无关修复。当前功能的数据丢失、越权、依赖不可用等问题必须处理；合并/发布仍遵守现有 CI，不降低门禁。
- 交付说明保持简短：改了什么、实际检查结果、必要的后续操作。普通开发不新建 evidence/baseline/contract 文件；发布证据仅在合并/发布阶段按现有位置记录。

## Codex 角色协作

当前项目由负责人对接用户，独立对话分别承担方案定位、功能实现、代码审查和集成交付。角色配置、派单与权限见 [Codex 开发协作](docs/operations/codex-team.md)。该约定优先于旧计划中的协作流程；按需调用角色，负责人按依赖与明确文件所有权安排并行实现，同一文件只允许一个写入者，浏览器与最终实际使用检验归用户。角色初始化不授权自动开发整个 backlog 或发布。

## 防御逻辑的边界

- 在真正的信任边界验证：HTTP 输入、环境配置、数据库非结构化字段、外部进程/模型返回值、持久化草稿和导入文件。内部已经验证并类型化的数据直接传递；只有新的信任边界或业务不变量才增加校验。
- 每项规则保留一个明确的所有者。可合并经证实等价的重复校验，但不可仅凭 TypeScript 类型删除授权、并发控制、事务、唯一约束或业务不变量；安全保护不可为简化而移除。
- `catch` 只用于恢复、清理或在边界转换错误；不吞错返回伪成功，不做没有故障依据的重试/兜底，不为假想扩展增加通用框架。
- 默认不新增 hash、冻结 contract、baseline 或 gate。只有能明确描述一个具体失败场景，并逐项说明 Git、版本号、主键、事务、唯一约束、类型和普通测试为什么不足时，才允许加入；不得以简化为由删除已有安全措施。gate 只设置在不可逆操作、跨系统交互、安全边界或正式发布边界。前置检查不得替代或挤占真正的代码执行、模拟或测量；结论应以实际执行、模拟或测量所得证据为主。

## Testing

Name unit and integration tests `*.test.ts`/`*.test.tsx`; name browser tests `*.spec.ts`. Add or update the closest test for behavior changes when existing tests do not cover the changed behavior. Reuse existing regression tests for behavior-preserving refactors; do not add tests that merely freeze source text, documentation wording, or implementation structure. No numeric coverage threshold is configured, so rely on meaningful branch and failure-path coverage.

### 浏览器验收分工（用户约定）

- 后续所有浏览器验收由用户负责，包括页面交互、视觉/响应式检查、真机检查和浏览器 E2E。除非用户后续明确授权，Agent 不自行或委派运行 Playwright、浏览器自动化、截图或真机验收。
- Agent 继续实现功能、维护相关测试，并执行必要的非浏览器检查（单元/契约测试、接口/数据库测试、类型检查、lint、构建）；浏览器验收待完成或既有浏览器测试失败，不作为整个项目继续开发的前置阻塞。已确认影响当前功能的数据丢失、越权或依赖不可用等问题仍须处理。
- 涉及 UI 的交付提供页面入口、环境/数据前提、操作步骤、预期结果和已知问题，供用户验收。没有用户反馈时明确标记“待用户浏览器验收”，不得声称浏览器通过、完整验收完成或伪造截图证据。
- 用户反馈浏览器问题后，Agent 负责定位、修复并完成非浏览器回归，再交用户复验；无需为满足既有复现/复查纪律而擅自运行浏览器。
- 本约定优先于项目既有计划、技能流程中的 Agent 浏览器验收要求及以其为前置的开发顺序；不自动修改或禁用现有 CI 浏览器检查，不抹去历史失败，不把待验收记为通过。

## Commits and Pull Requests

Use Conventional Commit prefixes such as `feat:`, `fix:`, `docs:`, and `test:`. PRs should explain the behavior change, link an issue when applicable, list verification commands, call out migrations or configuration changes, and include screenshots for UI changes.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After completing a coherent task or implementation slice, run `graphify update .` once to keep the graph current (AST-only, no API cost). Do not sync after every individual edit.

## Repair and Delivery Discipline

- **验证纪律 (failure → cause → fix → recheck):** 测试/类型/构建检查失败时,根据已有失败给出根因假设,信息不足才追加最小复现,实施最小修复后重跑失败检查;禁止仅重试而侥幸通过。仅对实际遇到的失败简述原因、修复与复查结果,不要求另建证据文档。
- **交付纪律:** 面向用户的改动合入前说明验收方式(PR/CI/手动验证);涉及数据库 migration 或破坏性变更必须记录回滚方案。本地测试通过 + agent 口头完成不是交付证据。
- **嵌套指令:** 每个 package/模块有自己的 AGENTS.md 时,以嵌套文件为准(它拥有该包级约定与验证命令)。
- **提交规范:** 使用 Conventional Commit 前缀;提交前按 `.agents/skills/aistudy-git-workflow/SKILL.md` 执行安全 Git 流程。
