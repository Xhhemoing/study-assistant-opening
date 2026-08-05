---
name: aistudy-git-workflow
description: Use when working in the AIstudy repository and asked to pull remote changes, prepare or create commits, merge a branch, or run the project's build and test gates before handoff or merge.
---

# AIstudy Git Workflow

仓库专属安全 Git 同步与质量验证流程。保持 `main` 可部署、保留用户现有改动、对每个实际运行的门禁报告证据。

## Project Facts

- 包管理器:npm。始终遵守 `package-lock.json`;干净安装用 `npm ci`。
- 运行时:Node.js `>=20`,CI 用 Node.js 22。
- 布局:npm workspaces(`apps/*`、`packages/*`、`spikes/*`)。
- CI 工作流:`.github/workflows/ci.yml`;运维参考:`docs/operations/ci.md`。
- 本地服务:PostgreSQL `5432`、隔离 E2E PostgreSQL `5433`、Redis `6379`、MinIO `9000`。
- 质量脚本调用 `bash scripts/run-heavy.sh`。Windows 上用 WSL 或 Git Bash;`bash` 不可用时报告环境阻塞,而不是声称质量命令通过或静默改写 runner。

## 不可协商的安全规则

1. 每个 Git 操作都以 `git status --short --branch`、`git branch --show-current`、`git log -1 --oneline` 开始。
2. 现有改动视为用户所有:检查并绕开它们;未经明确授权绝不 reset、clean、discard、amend 或覆盖。
3. 不提交 `.env`、凭据、生成产物、`node_modules`、`.next`、`dist`、`build`、覆盖率、Playwright 报告或测试结果。
4. 绝不把 `git reset --hard`、`git checkout --`、`git clean`、force-push 或宽泛 `git add -A` 当便捷手段。
5. 遇未解决冲突、必选门禁失败、远端认证缺失或服务不健康时停止;给出精确命令与下一步安全动作。

## 核心流程

- **Pull / Update:** 仅在干净工作树且目标分支明确验证后做 fast-forward-only 更新;脏树时展示路径让用户决定(提交/worktree/显式 stash),不静默 stash。冲突保持可见并询问解决方案。
- **Commit:** 确定范围 → `git diff --check` → 窄测试先行 → 仅暂存目标路径 → 审查完整 staged 补丁 → 一个 Conventional Commit → `git status` + `git log -1` 验证。除非明确要求否则不 amend;push 是独立的用户授权动作。
- **Merge:** 优先 PR 进入 `main`(CI 是合并门禁);合并前更新特性分支并跑完整验证序列,仅 push 命名特性分支。绝不 force-push `main`;本地合并且冲突时停止,保持冲突标记待用户解决。

## Build and Test

门禁顺序、环境准备与失败处理见 [references/build-and-test.md](references/build-and-test.md)。合并前按顺序串行运行全部门禁,遇第一个失败即停止;完整交接必须列出每个门禁的真实通过/失败状态,绝不把未运行的命令总结为已通过。
