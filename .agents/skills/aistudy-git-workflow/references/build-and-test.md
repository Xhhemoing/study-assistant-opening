# 按改动范围验证

## 日常开发与提交

- 行为改动默认只跑最近的相关测试和所属包类型检查；按需对改动文件运行 lint。没有新改动、失败或未解决疑点，不重复已经通过的检查。
- 纯文档改动检查内容与 diff 即可，不跑全量测试或构建。
- `npm run verify:ci` 仅用于 CI 工作流、heavy runner 变更或排查；它检查结构合同，不能替代实际执行。
- 不把完整本地检查、发布证据或浏览器验收变成每次开发、提交或 PR 的前置。合并与发布继续依赖现有 GitHub Actions `quality` 门禁；浏览器验收由用户负责，Agent 不自行或委派运行。

例如修改 web 编辑器草稿逻辑时（其他模块替换为对应测试文件和包）：

```pwsh
$ErrorActionPreference = 'Stop'
npx vitest run --project unit apps/web/src/features/editor/local-draft.test.ts
npm run typecheck -w @aistudy/web
```

集成或 handler 行为则选相应项目与测试文件；它们需要隔离测试服务。仅运行当前改动需要的项目，不先跑默认 `npm test` 再重复运行 integration/handler。

## 仅在用户明确请求时运行完整本地检查

准备必要服务后串行运行，每个项目一次：

```pwsh
$ErrorActionPreference = 'Stop'
npm run lint
npm run typecheck
npm test -- --project unit --project contract --project notion-pipeline
npm test -- --project '@aistudy/spike-*'
npm run test:integration
npm run test:handler
npm run build
```

- `npm run build` 运行 worker 的 `tsc --noEmit` 与 web 的 `next build`。
- 上述为非浏览器检查；浏览器 E2E 保留在现有 CI 中。本地 `npm run test:browser` 由用户执行，除非用户另行明确授权 Agent。
- 完整本地结果不能替代当前提交的远端 CI 结果；不因尚未执行本地全套而阻塞后续开发。

## 按需准备环境

只运行单元测试与类型检查时不启动 Docker 或安装 Chromium。首次安装依赖使用 `npm ci`；已有可用依赖时无需每次重装。

```pwsh
$ErrorActionPreference = 'Stop'
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
npm ci
```

- 需要集成/handler 测试时按 `docs/operations/ci.md` 准备隔离数据库与服务；不要对用户数据库运行测试，不要在日志打印 `.env` 内容或凭据。
- 质量脚本仍使用现有 `run-heavy.sh` 保护；Windows 需 Bash 可用。缺少 Bash 是相关脚本的环境限制，不把它当成产品测试失败。
- 不再需要本地服务时运行 `npm run compose:down`。

## 失败处理与交接

- 相关检查失败：保留现有失败输出，定位原因、做最小修复、重跑同一检查；已有清晰失败证据时无需为记录而额外重跑。
- 当前改动引入的失败须修复后再提交；远端认证、冲突、隔离服务或相关检查问题只阻止依赖它们的操作，不将无关历史失败扩成全项目停工。
- `npm ci` 失败时检查 Node/npm 版本与 lockfile 状态，不用 `npm install` 绕过；合并与发布仍须通过现有 CI。
- 简述改动、实际执行的检查、重要限制；没有用户浏览器反馈时标记“待用户浏览器验收”。不新增专门证据文件，不把未运行的命令总结为已通过。
