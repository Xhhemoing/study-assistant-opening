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

Use TypeScript and React 18-compatible syntax. Components are `PascalCase`, variables and functions are `camelCase`, and existing file names use `kebab-case`. Split modules before any file exceeds 200 lines. New or changed UI must use Tailwind CSS utilities only: do not add native CSS files or inline `style` props; treat the existing `globals.css` as legacy. Use `lucide-react` for icons and keep accessibility states intact.

For UI work, consult `docs/product/UX_AND_AI_POLICY.md` and `docs/product/PRD.md`. Use `classic-design` for sample shortlists and `impeccable` for `/shape`, `/audit`, and `/polish`; use Superpowers for design/TDD checkpoints, Ponytail for YAGNI review, and Graphify for local code-context inspection. Keep generated graph output out of commits. Prefer the smallest necessary implementation and preserve validation, security, and error handling.

## Testing

Name unit and integration tests `*.test.ts`/`*.test.tsx`; name browser tests `*.spec.ts`. Add or update the closest test for every behavior change. No numeric coverage threshold is configured, so rely on meaningful branch and failure-path coverage.

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

- **验证纪律 (failure → cause → fix → recheck):** 任何测试/类型/构建检查失败,先复现并给出根因假设,再实施最小修复,最后重跑同一检查;禁止仅重试而侥幸通过。完成报告需记录四步证据链。
- **交付纪律:** 面向用户的改动合入前说明验收方式(PR/CI/手动验证);涉及数据库 migration 或破坏性变更必须记录回滚方案。本地测试通过 + agent 口头完成不是交付证据。
- **嵌套指令:** 每个 package/模块有自己的 AGENTS.md 时,以嵌套文件为准(它拥有该包级约定与验证命令)。
- **提交规范:** 使用 Conventional Commit 前缀;提交前按 `.agents/skills/aistudy-git-workflow/SKILL.md` 执行安全 Git 流程。
