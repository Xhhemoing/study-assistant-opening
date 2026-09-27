# Opening 隔离验收环境实施计划

> **For agentic workers:** Use executing-plans to execute the existing S0 acceptance slice. Read-only subagents may inspect dependencies or review changes; the main agent owns writes.

**Goal:** 可重复启动独立 PostgreSQL、Redis、MinIO、Web 与 worker，验收上传→真实解析→辅导传输→版本引用→刷新恢复。

**Architecture:** 复用仓库便携服务，专属端口/目录；不读取应用 .env 作为测试数据库默认值。Playwright 使用独立生产构建目录。确定性模型仅运行在 tests/support 的 loopback HTTP server，不能成为产品 fallback；真实模型语义验收单独报告。

**Tech Stack:** PowerShell 7、Node.js、PostgreSQL、Redis、MinIO、Next.js、Playwright、既有 Python parser。

## Global Constraints

- 保留现有未提交改动；已在独立 worktree feat/opening-release，不再创建工作树。
- 不提交、不推送、不部署；测试数据只写新建的 .local/opening-e2e 服务。
- PostgreSQL 15432、Redis 16379、MinIO 19000/19001、Web 3100、测试模型 18081。
- E2E 数据库固定 aistudy_opening_e2e，integration 固定 aistudy_opening_test；guard 校验 loopback、端口、库名与显式标志，拒绝 query 参数改变连接目标。
- 服务只监听 loopback；进程停止必须核验本任务 PID/启动时间/路径，不能停未知服务。
- 所有命令 pwsh，PowerShell 首行 ErrorActionPreference=Stop，文本读写 UTF8；新代码文件不超过200行。
- 每项失败记录 failure→cause→fix→recheck；不把 fixture provider 当真实模型质量证据。

## Task 1：隔离服务与防误操作契约

Files: scripts/opening-e2e/environment.mjs, services.ps1, tests/tooling/opening-e2e-environment.test.mjs.

- [x] 测试先证明配置缺失；覆盖拒绝业务库/远端/错误端口/query override、生产配置不泄漏到子进程、固定loopback服务与零外部模型调用。
- [x] 实现 environment builder 与启动/检查/停止 PowerShell 脚本；重复启动不覆盖已有数据。
- [x] 建立独立服务、建库/建bucket，通过真实SELECT、Redis PING、S3 put/get。

## Task 2：独立构建与浏览器主流程

Files: playwright.opening.config.mts, scripts/opening-e2e/server.mjs, tests/support/opening-provider.mjs, tests/e2e/opening-workflow.spec.ts; minimal next.config.mjs isolation config.

- [x] 新增指定配置，Next独立输出和tsconfig，端口3100、reuseExistingServer=false。
- [x] 使用真实私有上传、worker、解析和来源下载；只有外部模型HTTP采用明确标记的测试fixture。
- [x] 验证浏览器上传、处理完成、提问、引用原件字节、刷新后对话和来源恢复；保留失败截图/trace。
- [x] 复跑现有Opening浏览器用例，旧断言仅在证据说明已漂移时修正为行为断言。

## Task 3：验证与交付记录

- [x] 串行运行定向unit/tooling、独立integration/handler、类型/定向lint与生产构建/浏览器。
- [x] 保存准确命令、计数、环境边界与未运行项目到 docs/superpowers/evidence/2026-09-24-opening-isolated-acceptance/verification.md。
- [x] 完成后graphify update一次，审查本轮diff，不提升尚未通过全部门禁的任务状态。

## Completion (2026-09-25, Asia/Shanghai)

本地隔离验收切片已完成；详见对应 evidence/verification.md 的 September 25 continuation。
浏览器 8/8、unit 1112/1112、integration 224/224、handler 87/87、tooling 59/59 通过。
新增修复：保留跳转原始 host；事务性投影解析失败；fixture 仅验证指定来源块正文。
类型、全仓库 lint、独立 Next 生产构建、计划结构和 diff 检查通过；图谱更新一次 exit 0。
六个任务端口全部关闭，服务 manifest 清理完毕。未提交、推送、部署，未提升 43 任务总账状态。
这不等于真实模型语义、外部提醒、完整恢复演练或远端 CI 验收。
