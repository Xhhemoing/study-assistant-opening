---
name: aistudy-git-workflow
description: Use when working in the AIstudy repository and asked to pull remote changes, prepare or create commits, merge a branch, or run the project's build and test gates before handoff or merge.
---

# AIstudy Git Workflow

仓库专属安全 Git 同步与质量验证流程。保持主线 `feat/opening-release` 可部署、保留用户现有改动、对每个实际运行的门禁报告证据。

## Project Facts

- 正式仓库:`Xhhemoing/study-assistant-opening`,remote 名 `study-assistant-opening`;主线 `feat/opening-release`,L（仅测试、文档、无行为变化的纯删死代码）先进 `integration/opening`,H（行为、数据、契约、公共接口变化）独立进主线。
- 包管理器:npm。始终遵守 `package-lock.json`;干净安装用 `npm ci`。
- 运行时:Node.js `>=20`,CI 用 Node.js 22。
- 布局:npm workspaces(`apps/*`、`packages/*`、`spikes/*`)。
- CI 工作流:`.github/workflows/ci.yml`;运维参考:`docs/operations/ci.md`。
- 本地服务:PostgreSQL `5432`、隔离 E2E PostgreSQL `5433`、Redis `6379`、MinIO `9000`。
- 重任务入口:`node scripts/run-heavy.mjs`,根 `lint`/`test`/`build` 与 web、worker 的 `typecheck` 已经过它。POSIX 委托 `run-heavy.sh`,Windows 用 Node 目录锁,不需要 Bash。拿不到全机槽位时退出码 75,记为未验证,不算通过也不算产品失败;需要排队时设 `HERMES_HEAVY_LOCK_TIMEOUT`(秒,默认 120)。

## 不可协商的安全规则

1. 任务开始时检查 `git status --short --branch`、`git branch --show-current`、`git log -1 --oneline`；暂存、提交、拉取或合并等关键写操作前复查状态与相关 diff，不为连续只读操作重复同一检查。
2. 现有改动视为用户所有:检查并绕开它们;未经明确授权绝不 reset、clean、discard、amend 或覆盖。
3. 不提交 `.env`、凭据、生成产物、`node_modules`、`.next`、`dist`、`build`、覆盖率、Playwright 报告或测试结果。
4. 绝不把 `git reset --hard`、`git checkout --`、`git clean`、force-push 或宽泛 `git add -A` 当便捷手段。
5. 遇未解决冲突、当前改动相关检查失败、远端认证缺失或当前操作必需服务不健康时，停止对应写操作并说明下一步；未运行的全量检查或无关既有失败不阻塞其他开发。合并与发布仍须通过现有 CI。

## 核心流程

- **Pull / Update:** 仅在干净工作树且目标分支明确验证后做 fast-forward-only 更新;脏树时展示路径让用户决定(提交/worktree/显式 stash),不静默 stash。冲突保持可见并询问解决方案。
- **Commit:** 确定范围 → `git diff --check` → 窄测试先行 → 仅暂存目标路径 → 审查完整 staged 补丁 → 一个 Conventional Commit → `git status` + `git log -1` 验证。除非明确要求否则不 amend;push 是独立的用户授权动作。
- **Merge:** 交付合入一律走 PR，按 2026-11-08 v2／2A：只有唯一集成者合 integration 和主线，worker／开 PR 会话不自合，接管不产生第二合并权。L 须独立 GPT 批准＋精确 head required CI，合入 integration 后补指定 Claude Opus 5.5 high；H 须两路批准＋精确 CI，独立主线 PR；U 原审批不放宽。提升按至少 3 个 L 合入或约 6 小时批量，GPT 快审完整差分＋精确 CI，L 仍补审；不再以补丁等价免审。部署条件仍按 `docs/operations/agent-workflow.md` 原授权，不由 L 延后审查推导。候选分支仅在卡片明确授权时普通 merge 已核精确父提交／目标分支，保留原历史，不等于获准合入目标分支；冲突保持可见，仅按明确授权解决，否则停止交集成者。合并前按需更新特性分支，仅 push 获准命名特性分支到正式 remote，不推 integration／主线。T3 子树由平台 `isolation: "worktree"` 准备，worker 不 shell 建树；full-access runtime 不扩大 Git 权限。完整本地检查不作默认前置，纯文档仅 diff-check 与完整差分核对，绝不 force/reset/clean/覆盖他人成果。

## Build and Test

按改动范围选择检查，默认运行最近的相关测试与所属包类型检查；纯文档改动不跑全量。`verify:ci` 仅用于 CI/runner 变更或排查。具体命令、环境准备与失败处理见 [references/build-and-test.md](references/build-and-test.md)。浏览器验收由用户负责；交接简述实际检查与未验证范围，不新增验收记录文件，不把未运行的命令总结为已通过。
