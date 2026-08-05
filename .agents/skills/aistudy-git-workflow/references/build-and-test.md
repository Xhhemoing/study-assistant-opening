# Build and Test 完整门禁

在合并前按顺序串行运行以下门禁,遇到第一个失败即停止:

```bash
npm run verify:ci
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run test:handler
npm run test:browser
npm run build
```

- `lint/typecheck/test/integration/handler/browser/build` 对应 `.github/workflows/ci.yml` 的门禁;`verify:ci` 是本地结构预检,CI 不运行它。
- `npm run build` 运行 worker 的 `tsc --noEmit` 与 web 的 `next build`。
- 仅文档或窄范围改动可只跑较小相关检查用于提交,但合并前仍需完整序列,除非用户明确接受文档化例外。
- 用 `docker compose -f infra/docker/compose.yml ps` 确认服务健康后再跑集成或浏览器测试;不要在日志打印 `.env` 内容或凭据。
- 不再需要本地服务时运行 `npm run compose:down`。

## 环境准备

**WSL:**

```bash
if [ ! -e .env ]; then cp .env.example .env; else echo '.env exists; preserving it'; fi
npm ci
npm run compose:up
npm run db:migrate
npx playwright install chromium --with-deps
```

**Git Bash(原生 Windows,无需 Linux 系统依赖):**

```bash
if [ ! -e .env ]; then cp .env.example .env; else echo '.env exists; preserving it'; fi
npm ci
npx playwright install chromium
```

**PowerShell 等价的保护式 .env 设置:**

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env } else { Write-Output '.env exists; preserving it' }
npm ci
```

## 失败处理与交接

- `bash` 不存在:转到 WSL/Git Bash 或报告 Windows 上完整套件受阻;不要把它当作测试失败。
- `npm ci` 失败:检查 Node/npm 版本与 lockfile 状态;不要用 `npm install` 替代。
- 服务连接失败:检查 `docker compose ... ps` 与健康日志,服务恢复后重试受影响门禁。
- Playwright 启动或端口失败:检查 `playwright.config.ts`,仅在授权下释放冲突进程,然后重跑浏览器门禁。
- 任何门禁失败:保留日志,不提交不合并不合并,报告第一个失败命令与之前门禁的通过情况。

最终交接必须包含:当前分支、HEAD 提交、改动路径、执行的命令、每个门禁的通过/失败状态、服务前置条件、未运行或受阻的检查。绝不要把未运行的命令总结为已通过。
