# 2026-09-21 环境核查：Vitest shebang+CRLF 陷阱与 worktree 准备

日期：2026-09-21
范围：为 RP1/RP2 准备独立 worktree `../study-assistant-opening-rp12`（detached @ 8d616c0，node_modules 以 junction 指向主仓库安装）

## 发现的问题与根因

在 worktree 运行任何 integration/handler project 测试时，Vitest 报 `SyntaxError: Invalid or unexpected token`，堆栈落在 `vitest/dist/module-evaluator.js` 的 `new Script`/`runInThisContext`。

根因链（逐层证实）：
1. `scripts/opening-test-db.mjs` 第一行是 shebang `#!/usr/bin/env node`；仓库 `core.autocrlf=true` 且无 `.mjs` 的 eol 属性 → 工作区文件为 CRLF。
2. Node 的 CJS 加载器会剥离 shebang，但 Vitest 4 的 `module-evaluator` 对 globalSetup 使用 `vm.Script` 直接求值源码，不剥离 shebang。
3. shebang 行以 `\r` 结尾（LF 时 Node 对 shebang 有特殊宽容，CRLF 时 `\r` 成为非法 token）→ `line1 + line2` 编译即失败；`line1` 单独编译通过。
4. 主仓库未暴露是因为近期集成测试在本机未运行（见 task-status-reconciliation：隔离库不可用记录）；worktree 首次运行即触发。

修复：
- `.gitattributes` 增加 `*.mjs text eol=lf`（与既有 `*.sh`、`*.sql` 一致），主仓库与 worktree 同步。
- worktree 内 `scripts/opening-test-db.mjs` 已规范为 LF；同命令复测 `tests/integration/opening-tutor-history.test.ts` 3 tests passed。

## worktree 使用约束

- junction 指向主仓库 `node_modules`，仅适用于依赖未变更期间；新增/升级依赖后必须重建。
- worktree 为 detached HEAD，禁止在其中提交；产出以补丁形式回主仓库集成。
- DB 测试使用 `OPENING_TEST_DB=1 OPENING_TEST_DATABASE_URL=postgres://aistudy:aistudy@127.0.0.1:5433/aistudy_opening_test`，串行运行。

## 附带验证

- `aistudy_opening_test` 数据库在线（5433，owner aistudy）。
- 主仓库 `tests/integration/dependency-checks.test.ts` 等需要 DATABASE_URL/Redis，本次未作为 RP 门禁运行。
