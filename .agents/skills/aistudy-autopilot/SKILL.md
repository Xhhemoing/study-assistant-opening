---
name: aistudy-autopilot
description: Use when orchestrating continuous high-throughput autonomous development in AIstudy with one coordinator and multiple parallel subagents (isolated `share` coding workers, `inherit` read-only auditors/reviewers, `run_workflow` batching, fast local gates, and exact-head GitHub Actions CI merge).
---

# AIstudy Autopilot Orchestrator Skill

单主控 + 多并行 Subagent 高吞吐持续开发工作流（无人工并发与配额限流版）。在严格守住安全门禁与类型/构建完整性的前提下，把每轮端到端周期压缩到分钟级。

## 核心架构：Hub-and-Spoke 流水线

- **唯一主控 Coordinator（当前主对话）**：负责任务拆解、文件 `allowedPaths` 隔离、共享契约与迁移号协调、并发子 Agent 调度、CI 合并（`--match-head-commit`）与 `docs/STATUS.md` 同步。主控**不与 worker 同时写业务文件**，不在同一步串行等待可并行的审查或子任务。
- **隔离编码 Workers（`Workspace: "share"` / `aistudy-autopilot-worker`）**：每张任务卡拥有互不重叠的 `allowedPaths`、独立的 Git 工作树与分支，只跑 **30 秒级极速本地门禁**，通过后立刻 commit + push + 开 PR，并把 `headRefOid` 交回主控。
- **零上下文污染 Audit / Reviewer Subagents（`Workspace: "inherit"`）**：
  - 全部严格只读，通过 `git diff` / `git show` / `gh pr view` 按提交 SHA 核对，绝不依赖可变工作区状态。
  - 必须显式指定独立角色与审视角度（安全/边界/并发 vs 业务行为/UI/测试覆盖）。
- **批处理编排（`run_workflow`）**：当任务天然分裂成 >=4 个同构独立单元（多模块审计、多 PR 状态检查、多文件重构）时，使用 `run_workflow` 以 Python 代码编排 `parallel` / `pipeline`。

## 五阶段持续迭代闭环

### Wave 0 — 契约定稿与互斥分片（5 分钟）
1. 同步基线：`git fetch study-assistant-opening --prune`；确认 `feat/opening-release` 与 `integration/opening` 对齐，且无未归档的脏工作区冲突。
2. 明确本轮任务清单，先锁定任何跨包公开契约（`packages/contracts`、DB schema/migrations、共享 repository 接口）。
3. 把每个修复或功能切片写入严格**文件互斥**的任务卡（含：`goal`、`baseSha`、`branch`、`allowedPaths`、`commands`、`forbiddenPaths`），禁止两张并行卡写同一文件。

### Wave 1 — 全并行实现 + 极速本地门禁（10–25 分钟）
- 对 N 个互不重叠的任务卡，在**同一轮并发**启动 N 个 `Workspace: "share"` 子 Agent。
- 每个 worker 只执行最贴近改动的快速门禁（不在多个 worker 中并发执行完整 E2E 或全仓 build）：
  - `node scripts/check-learner-copy.mjs --strict`
  - `node scripts/check-api-contracts.mjs --strict`
  - 改动涉及的 unit 测试：`npx vitest run --project unit <changed-tests>` 或 `node --test <tooling-tests>`
  - 改动涉及包的 `npx eslint <changed-files>` 与所属包 `npm run typecheck -w @aistudy/<pkg>`
  - `git diff --check`（强制 LF，禁止 staged `.env`、`apps/web/next-env.d.ts`）
- 通过后 worker **直接 commit + push 到 `study-assistant-opening` + 创建 PR（`--base feat/opening-release`）** 并回报 PR 号、精确 40 位 `headRefOid`、改动文件、已跑与未跑命令。

### Wave 2 — 远端全量 CI + 并行独立双视角审查（与 Wave 1/下一波重叠）
- PR 一开出，`GitHub Actions` 自动并发跑全量 `integration-parser`、`handler-browser-spikes`、`static-unit-contract-spikes`、`production-build` 与最终 `lint-typecheck-test-build`。
- **同回合**由主控对每个候选 PR 并发派发只读 Reviewer subagent，核查：
  1. 严格作用域（无 `.env`、`next-env.d.ts`、本机路径、生产 IP、未授权迁移 `0001`–`0111` 变更）
  2. 信任边界（API 鉴权、`ownerId`/`workspaceId` 隔离、`lockWorkspaceLearningHistory` 锁序、`append-only` 事件不变量）
  3. UI 与学习者文案（仅 Tailwind 语义 token，无原生 CSS / inline style，无禁用技术词）
  4. 测试真实性（覆盖行为与失败路径，无弱化或跳过既有断言）
- 需要等待远端 CI 完成时，使用 `schedule(DurationSeconds=480, TimerCondition="any", ...)` 做事件驱动唤醒，严禁使用 shell `sleep` 轮询。

### Wave 3 — 自动合入、双干线同步与分支/工作树回收
- 同时满足「Reviewer Verdict = `APPROVE`」+「精确 `headRefOid` 的 `lint-typecheck-test-build` = `SUCCESS`」后，由主控立即执行合入：
  ```powershell
  gh pr merge <PR_NUM> --repo Xhhemoing/study-assistant-opening --merge --match-head-commit <HEAD_SHA> --delete-branch
  ```
- 若前序合入造成后续 PR 冲突：在干净工作区合入最新 `study-assistant-opening/feat/opening-release`，重跑受影响局部验证并 push，**必须等新 `headRefOid` 的 CI 全绿**再合入。
- 每批合入后立即对齐双干线（若 `integration/opening` 无独有提交）：
  ```powershell
  git checkout feat/opening-release
  git fetch study-assistant-opening --prune
  git merge --ff-only study-assistant-opening/feat/opening-release
  git push study-assistant-opening feat/opening-release:integration/opening
  ```
- Windows 清理废弃临时 worktree 加速技巧：先 `cmd /c "if exist `"<wt>\node_modules`" rmdir /s /q `"<wt>\node_modules`""` 再 `git worktree remove --force "<wt>"` + `git worktree prune`。

### Wave 4 — 收尾核对、U 级清单与浏览器验收交接
- 更新 `docs/STATUS.md`（实际日期、已合 PR/SHA 列表、未解决缺陷、待审批事项）及 `docs/plans/2026-10-27-full-learning-loop-master-plan.md` 附录 F（通过独立文档 PR + CI）。
- 将所有需要用户逐次审批的 U 级事项（数据库迁移执行、生产配置调整、真数据操作、视觉模型配置）整理为只读核对单，**绝不越权执行**。
- 输出中文《交付与浏览器验收清单》，标明所有前端交互均为 **待用户浏览器验收**，绝不伪造截图或本地 Playwright 结果。

---

## 不可逾越的红线

1. **禁止本地浏览器验收**：遵循根目录 `AGENTS.md`，Agent 绝不运行或委派本地 Playwright、浏览器自动化、截图或真机验收；远端 GitHub Actions CI 的浏览器检查保持启用。
2. **禁止越权生产与数据操作**：绝不执行生产数据库迁移、不修改生产配置/密钥、不导出/篡改真实学习数据。
3. **禁止公开仓库信息泄露**：`docs/`、commit message、PR 正文中绝不写入本机绝对路径（Windows/macOS/Linux 家目录）、主机 IP、服务端口快照或 PID。
4. **禁止降级测试或伪造通过**：不得删除/跳过既有红测以换取绿灯；未执行的重检查须如实标注并交精确 SHA CI 把关。

---

## 推荐配合命令与复用模板

- 可用 `/goal` 搭配下文主控提示词触发多轮长时间自动推进；用 `/teamwork` 或 `run_workflow` 启动大规模并行切片。
- 若存在已停用的历史文件队列目录，可配合 `scripts/local-dev-flow.mjs` / `scripts/local-dev-watch.mjs` / `scripts/local-dev-worker.mjs` 做只读契约校验与隔离派单，但不与 Antigravity `Workspace: "share"` 混用写同一路径。

### 主控 `/goal` 提示词模板

```text
请加载并严格遵循 .agents/skills/aistudy-autopilot/SKILL.md 与根目录 AGENTS.md，采用“单主控 Coordinator + 多并行隔离 Subagent”模式全速高质量推进开发：

1. 本轮目标（按优先级）：
   - <目标 1：例如高数测试版反馈缺陷全链路审计与修复>
   - <目标 2：例如通用学习工作区 / M4-1b 收尾与文档同步>
2. 执行方式：
   - 先做只读多路审计，切分为 file-disjoint 的小任务卡；
   - 全量并发派发 `Workspace: "share"` worker subagent 修复、补回归单测、跑极速本地门禁后直接 push & 开 PR（base `feat/opening-release`）；
   - 同回合对每个 PR 派发独立只读 reviewer subagent 审查精确 headRefOid；
   - 等待远端 CI 使用 `schedule` 唤醒而非轮询 sleep；
   - Review 通过且精确 `headRefOid` CI 全绿的 PR 立即 `--match-head-commit` 合入并同步 `integration/opening`，清理已合分支；
   - 最后更新 `docs/STATUS.md` 并输出中文《交付与浏览器验收清单》。
3. 硬边界：
   - 严禁运行本地 Playwright / 浏览器自动化 / 截图（标记“待用户浏览器验收”）；
   - 严禁执行生产库迁移、修改生产配置或触碰真实用户数据；
   - 公开文档与 PR 严禁出现本机绝对路径或主机拓扑。
```
