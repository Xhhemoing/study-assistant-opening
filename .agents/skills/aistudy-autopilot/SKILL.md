---
name: aistudy-autopilot
description: Use when orchestrating continuous high-throughput autonomous development in AIstudy with one coordinator and multiple parallel subagents (isolated `share` coding workers, `inherit` read-only auditors/reviewers, `run_workflow` batching, fast local gates, and exact-head GitHub Actions CI merge).
---

# AIstudy Autopilot Orchestrator Skill

单主控 + 多并行 Subagent 高吞吐持续开发工作流。严格遵守 `AGENTS.md` 与 `docs/operations/agent-workflow.md` 的默认 v2 并发与资源守卫（运行中实现 writer `<= 5`，除非当前会话获用户明确授权提高吞吐；派发新 writer 前确认可用内存 `available >= 500 MiB`；尊重平台真实配额、`scripts/run-heavy.mjs` 重验证锁以及未合入 H 栈深度 `<= 2`、未合入 H PR `> 4` 时暂停新 H 的栈限流），在守住安全门禁与类型/构建完整性的前提下压缩每轮端到端周期。

## 核心架构：Hub-and-Spoke 流水线

- **唯一主控 Coordinator（当前主对话）**：负责任务拆解、文件 `allowedPaths` 隔离、共享契约与迁移号协调、并发子 Agent 调度，并按 `AGENTS.md` 与 `docs/operations/agent-workflow.md` 的唯一集成者边界、v2 风险分级与 `--match-head-commit` 规则合入 PR、同步双干线及发起 `docs/STATUS.md` PR。主控**不与 worker 同时写业务文件**，不在同一步串行等待可并行的审查或子任务。
- **唤醒活性不变量（Wakeup Liveness Invariant）**：全流程最终收尾前，主控在结束任何回合前必须核实至少有 1 个运行中 Subagent **或**本回合已调用 `schedule(..., TimerCondition="any")` 并拿到有效 `task-id`；严禁仅口头声称挂定时却未调工具导致会话永久休眠。
- **隔离编码 Workers（`Workspace: "share"` / `aistudy-autopilot-worker`）**：每张任务卡拥有互不重叠的 `allowedPaths`、独立的 Git 工作树与分支，只跑 **30 秒级极速本地门禁**，通过后立刻 commit + push 并开 PR，将 PR 号与精确 40 位 `headRefOid` 交回主控。
- **零上下文污染 Audit / Reviewer Subagents（`Workspace: "inherit"`）**：
  - 全部严格只读，通过 `git diff` / `git show` / `gh pr view` 按提交 SHA 核对，绝不依赖可变工作区状态。
  - 必须显式指定两个独立审视角度：**视角 A（安全 / 契约 / 信任边界 / 并发与隔离）** 与 **视角 B（业务行为 / UI / 测试覆盖与失败路径）**。
  - **常驻热只读双审查员复用**：在多波推进期间保持安全/契约与行为/测试两个 `Workspace: "inherit"` 只读审查员常驻，跨 PR 通过 `send_message` 绑定精确 `headRefOid` 复用；编码 `Workspace: "share"` worktree 则随完自清 `node_modules` 并 `kill` 回收。
- **批处理编排（`run_workflow`）**：当任务天然分裂成 >=4 个同构独立单元（多模块审计、多 PR 状态检查、多文件重构）时，使用 `run_workflow` 以 Python 代码编排 `parallel` / `pipeline`。

## 五阶段持续迭代闭环

### Wave 0 — 契约定稿、v2 分级与互斥分片（5 分钟）
1. 同步基线：`git fetch study-assistant-opening --prune`；核实 `feat/opening-release` 与 `integration/opening` 状态，确认无未归档的脏工作区冲突。
2. 明确本轮任务清单，先锁定任何跨包公开契约（`packages/contracts`、DB schema/migrations、共享 repository 接口），公开接口变更由唯一集成者确认后再派发。
3. 为每张切片确定 v2 风险级别与目标基分支，并写入严格**文件互斥**的任务卡（含：`goal`、`baseSha`、`branch`、`baseBranch`、`risk`、`allowedPaths`、`commands`、`forbiddenPaths`），禁止两张并行卡写同一文件：
   - **L（仅改测试、仅改文档、无行为变化的纯删死代码）**：目标分支为 `integration/opening`（仅当用户在当前会话明确授权整合批直合时，才可指向 `feat/opening-release`，且仍须满足完整审查与双项必选 CI）。
   - **H（改变行为、数据、契约或公共接口，含 UI 行为；存疑按 H）**：从安全基线独立 PR 指向 `feat/opening-release`，不得借 L 集成池带入。
   - **U（含迁移的版本部署、数据库迁移执行、破坏性迁移、生产配置、真数据操作、视觉模型配置、定样等）**：须用户逐次审批，不因高效推进放宽。

### Wave 1 — 全并行实现 + 极速本地门禁（10–25 分钟）
- 派单前逐项核验默认 v2 并发与资源守卫：
  - 运行中实现 writer 并发数 **`<= 5`**（除非当前会话获用户明确授权提高吞吐；只读审计/审查 Subagent 与已交回待审 PR 不占 writer 名额，`L` 占 writer 名额但不占 H 积压容量）；
  - 每次新增 writer 前本机可用内存 **`available >= 500 MiB`**；
  - 遵守平台真实配额、共享环境 `scripts/run-heavy.mjs` 重验证锁，以及未合入 H 栈 `<= 2`（未合入 H PR `> 4` 时暂停新 H，优先 L 或缺陷修复）。
- 满足上述守卫后，对 N 个互不重叠的任务卡并发启动 `Workspace: "share"` 子 Agent。
- 依赖与可选本地辅助脚本边界：
  - `Workspace: "share"` 新建工作树默认不含 `node_modules`：纯文档卡片一般不在 worktree 中安装依赖；需要执行本地 unit/lint/tsc 检查（含脚本门禁）的编码工作树，须在派卡时预授权 `npm ci --prefer-offline --no-audit --no-fund`，并在终止子 Agent 前清理 `<worktree>/node_modules`（Windows 下用 `rmdir /s /q`）。
  - 可选使用 `#421` 合入的本地看板辅助脚本（`scripts/local-dev-flow.mjs`、`scripts/local-dev-watch.mjs`、`scripts/local-dev-worker.mjs`）执行结构化 `.codex.json` 任务板调度、文件监听与本地 worker 调用，但仍须严格遵守并发 `<= 5`、`available >= 500 MiB`、严格 `allowedPaths` 与“不自动合入”规则。
- 每个 worker 只执行最贴近改动的快速门禁（不在多个 worker 中并发执行完整 E2E 或全仓 build）：
  - `node scripts/check-new-fixed-colors.mjs`
  - `node scripts/check-server-boundary.mjs`
    - **App Router 分层边界（Plan §7.4）**：`apps/web/src/app/**` 路由文件禁止直接运行时导入 `@aistudy/database` 或数据库/缓存驱动，须经 `apps/web/src/features/*/server/*` 的 `import "server-only"` 应用服务层适配。
  - `node scripts/check-learner-copy.mjs --strict`
  - `node scripts/check-api-contracts.mjs --strict`
  - 改动涉及的 unit 测试：`npx vitest run --project unit <changed-tests>` 或 `node --test <tooling-tests>`
  - 改动涉及包的 `npx eslint <changed-files>` 与所属包 `npm run typecheck -w @aistudy/<pkg>`（注意：`@aistudy/senseweave` 未定义 `typecheck` 脚本；`@aistudy/web`、`@aistudy/worker` 与其余 7 个 workspace 包 `ai`、`config`、`contracts`、`database`、`domain`、`jingwei`、`ui` 均有定义）。注意根级 `npm run typecheck` 仅覆盖各工作区 `src/`（不含 `*.test.ts[x]`）及 `tsconfig.e2e.json`（`tests/e2e/**/*.ts`、`tests/restart/**/*.ts`、`playwright*.ts`/`mts`、`scripts/db-reset-e2e.ts`），**不**检查 `tests/integration/**/*.test.ts`（含 `tests/integration/handler/**/*.test.ts`）、`tests/contract/*.test.ts` 或 `packages/*/src/**/*.test.ts`：
    - 若改动 `tests/e2e/**/*.ts` 或 `tests/restart/**/*.ts`，运行根级 `npm run typecheck`（经 `run-heavy` 串行锁）或 `npx tsc -p tsconfig.e2e.json --noEmit`；
    - 若改动 `tests/integration/**/*.test.ts`（含 `tests/integration/handler/**/*.test.ts`）、`tests/contract/*.test.ts` 或 `packages/*/src/**/*.test.ts`，运行 `npx eslint <changed-files>` 与对应 Vitest 项目（`--project integration` / `--project handler` / `--project contract` / `--project unit`）及精确 head CI；若需额外执行独立 `tsc --noEmit`，须显式传入匹配 `tsconfig.base.json` 的编译选项（如 `--strict --moduleResolution Bundler` 等），避免误以为根 `npm run typecheck` 已覆盖 `tests/integration/`。
  - `git diff --check`（强制 LF，禁止 staged `.env`、`apps/web/next-env.d.ts`）
- 通过后 worker **直接 commit + push 到 `study-assistant-opening` 并按 v2 分级创建 PR**（`L` 卡 `--base integration/opening`，仅当当次会话获明确整批授权时可用 `--base feat/opening-release`；`H` 卡独立 `--base feat/opening-release`），在 PR 正文标明风险分级、依据、完整 base-to-head 改动、`unverified` 范围，并向主控回报 PR 号、精确 40 位 `headRefOid`、改动文件与命令真实退出码：
  - **PowerShell PR 正文防转义**：Windows `pwsh` 下创建/更新 PR 正文一律使用单引号 Here-String `@' ... '@ | gh pr create/edit --body-file -`，防止双引号内 Markdown 反引号触发转义。

### Wave 2 — 远端全量 CI + 独立审查门禁（与 Wave 1/下一波重叠）
- PR 一开出，`GitHub Actions` 按改动分类运行对应作业（`docs_only=false` 时并发运行 `integration-parser`、`handler-browser-spikes`、`static-unit-contract-spikes`、`production-build` 与 `isolated-worker-pdf-browser`；`docs_only=true` 时运行 `classify-changes` 与 `documentation-light-check`）。合并前在**精确最终 PR `headRefOid`** 上**必须同时通过两项必选 CI 门禁**：
  - **`lint-typecheck-test-build`**（`quality`）
  - **`real-worker-pdf-browser-flow`**（`worker-gate`）
  二者缺一不可，绝不可省略 `real-worker-pdf-browser-flow`。
- **审查门禁执行规则（严格区分渠道模式，绝不混淆替代）**：
  1. **常态 v2 规则渠道（当 `Claude Opus 5.5 high` + 独立异家族 `GPT` 渠道已配置且按 v2 规则要求启用时）**：
     - **`L` PR**（`integration/opening`）：合入前必须取得独立 `GPT` 批准，合入后进入指定 `Claude Opus 5.5 high` 后补审队列（补审发现真实缺陷立即开最高优先级修复 PR；完成前不得标为已通过）。
     - **`H` PR**（`feat/opening-release`）：合入前**必须同时取得**指定 `Claude Opus 5.5 high` **与** 独立异家族 `GPT` 双方批准（并满足 `agent-workflow.md` 长期授权全部条件或用户逐次批准）。
     - 若所需指定渠道不可用，如实记录未审/阻塞，不得以自审、空 verdict 或降级模型代替。
  2. **Antigravity 会话明确授权的多 Subagent 自主运行模式（仅当用户在当前会话明确授权时）**：
     - 对每个候选 PR 的精确 `headRefOid` 并发派发**两个独立只读 Subagent 审查视角**（**视角 A**：安全 / 契约 / 信任边界 / 并发与隔离；**视角 B**：业务行为 / UI / 测试覆盖与失败路径），与两项必选 CI 并行作为合入前技术审查门禁。
     - 该模式**不削弱任何 `H`/`U` 用户审批边界**；**绝不可声称 Subagent 审查替代了指定 v2 签批（`Claude Opus 5.5 high` / 独立 `GPT`）**，除非当前会话/规则已获用户明确授权。
- 所有只读审查统一核查：
  1. 严格作用域（无 `.env`、`next-env.d.ts`、本机路径、生产 IP、未授权迁移或未授权跨界改动）
  2. 信任边界（API 鉴权、`ownerId`/`workspaceId` 隔离、`lockWorkspaceLearningHistory` 锁序、`append-only` 事件不变量）
  3. UI 与学习者文案（仅 Tailwind 语义 token，无原生 CSS / inline style，无禁用技术词）
  4. 测试真实性（覆盖行为与失败路径，无弱化或跳过既有断言）
- **两段式 CI 定时节拍（保护 30 步规划复盘周期）**：需要等待远端全量 CI 时使用事件驱动 `schedule(..., TimerCondition="any")`，严禁使用 shell `sleep` 轮询或高频短定时消耗步数预算；新 PR 推送后首轮设 `DurationSeconds=480`（8 分钟），唤醒后若仅余 `integration-parser` / `handler-browser-spikes` 等收尾作业设续轮 `180`–`300` 秒（并按唤醒活性不变量确认拿到有效 `task-id` 后再结束回合）。

### Wave 3 — 自动合入、双干线推进与分支/工作树回收
- 同时满足以下全部条件后，由唯一集成者执行精确 SHA 合入：
  1. 适用审查门禁已通过（常态 v2 渠道按 `L`/`H` 取得对应 `GPT` / `Claude Opus 5.5 high` 批准；或当前会话获用户明确授权 Antigravity 自主运行时，双视角独立只读 Subagent 均给出 `APPROVE` 且未越权替代未经授权豁免的 v2 签批或 `H`/`U` 审批）；
  2. **精确最终 PR `headRefOid`** 上 **BOTH** `lint-typecheck-test-build`（`quality`）**AND** `real-worker-pdf-browser-flow`（`worker-gate`）均为 `SUCCESS`（绝不可省略 `real-worker-pdf-browser-flow`）。
  ```powershell
  gh pr merge <PR_NUM> --repo Xhhemoing/study-assistant-opening --merge --match-head-commit <HEAD_SHA> --delete-branch
  ```
- 若前序合入造成后续 PR 冲突：在干净工作区合入最新目标基分支（`integration/opening` 或 `feat/opening-release`），重跑受影响局部验证并 push；**必须在新 `headRefOid` 上重新取得对应审查确认，且 BOTH `lint-typecheck-test-build` 与 `real-worker-pdf-browser-flow` 全绿**后再合入。
- **双干线推进与对齐**：
  - `L` PR 合入 `integration/opening` 后，按 v2 节奏（至少累计 3 个 `L` 合入，或距上次提升约 6 小时）由唯一集成者发起提升 PR 合入 `feat/opening-release`（写明完整 base-to-head 差分与所含 PR，取得独立 `GPT` 快审与精确 `headRefOid` 两项必选 CI 全绿；所含 `L` 仍须完成 `Claude Opus 5.5 high` 后补审）。
  - 仅当 `integration/opening` 相对 `feat/opening-release` **无未提升独有提交**（可用 `git merge-base --is-ancestor study-assistant-opening/integration/opening study-assistant-opening/feat/opening-release` 核实）时，在 `H` 合入或提升完成后将 `feat/opening-release` 快进同步回 `integration/opening`：
    ```powershell
    git checkout feat/opening-release
    git fetch study-assistant-opening --prune
    git merge --ff-only study-assistant-opening/feat/opening-release
    git push study-assistant-opening feat/opening-release:integration/opening
    ```
- **Windows `share` worktree 实践提示**：
  - 本地仓库配置启用长路径：`git config core.longpaths true`，并保持 subagent `Role` 简短（`<= 12` 字符），避免在 `Workspace: "share"` 检出深层工作树路径时触发 Windows `MAX_PATH` 失败。
  - 若在 `Workspace: "share"` 编码 worktree 内执行了预授权的 `npm ci --prefer-offline --no-audit --no-fund`，在终止 subagent 或回收废弃 worktree 前先清理 `<worktree>/node_modules`（确认无未合并独有成果且符合清理授权后，Windows 先 `cmd /c "if exist `"<wt>\node_modules`" rmdir /s /q `"<wt>\node_modules`""`，再 `git worktree remove --force "<wt>"` + `git worktree prune`）。

### Wave 4 — 收尾核对、U 级清单与浏览器验收交接
- 更新 `docs/STATUS.md`（实际日期、已合 PR/SHA 列表、未解决缺陷、待审批事项，由唯一集成者负责）及 `docs/plans/2026-10-27-full-learning-loop-master-plan.md` 附录 F：**两者均必须通过独立 PR + 必选 CI（`lint-typecheck-test-build` 与 `real-worker-pdf-browser-flow`）后合入**（`scripts/ci/checks.py` 将 `STATUS.md` 排除在 `docs_only` 快速路径之外，因此修改 `docs/STATUS.md` 的 PR 会运行完整 CI）。
- 将所有需要用户逐次审批的 U 级事项（含迁移的版本部署、数据库迁移执行、破坏性迁移、生产配置调整、真数据操作、视觉模型配置、定样）整理为只读核对单，**绝不越权执行**。
- 输出中文《交付与浏览器验收清单》，标明所有前端交互均为 **待用户浏览器验收**，绝不伪造截图或本地 Playwright 结果。

---

## 不可逾越的红线

1. **禁止本地浏览器验收**：遵循根目录 `AGENTS.md`，Agent 绝不运行或委派本地 Playwright、浏览器自动化、截图或真机验收；远端 GitHub Actions CI 的浏览器检查保持启用。
2. **禁止越权生产与数据操作**：绝不执行生产数据库迁移、破坏性迁移、定样越权拍板，不修改生产配置/密钥，不导出/篡改真实学习数据。
3. **禁止公开仓库信息泄露**：`docs/`、commit message、PR 正文中绝不写入本机绝对路径（Windows/macOS/Linux 家目录或盘符路径）、主机 IP、服务端口快照或 PID。
4. **禁止降级测试或伪造通过**：不得删除/跳过既有红测以换取绿灯；未执行的重检查须如实标注并交精确 SHA CI 把关。

---

## 推荐配合命令与复用模板

- 可用 `/goal` 搭配下文主控提示词触发多轮长时间自动推进；用 `/teamwork` 或 `run_workflow` 启动大规模并行切片。
- 所有并行编码统一使用 `Workspace: "share"` 独立工作树，只读审计与审查统一使用 `Workspace: "inherit"` 并绑定精确 `headRefOid`，不与外部队列或脚本并发写同一工作区路径。

### 主控 `/goal` 提示词模板

```text
请加载并严格遵循 .agents/skills/aistudy-autopilot/SKILL.md、docs/operations/agent-workflow.md 与根目录 AGENTS.md，采用“单主控 Coordinator + 多并行隔离 Subagent”模式推进开发：

1. 本轮目标（按优先级）：
   - <目标 1：例如高数测试版反馈缺陷全链路审计与修复>
   - <目标 2：例如通用学习工作区 / M4-1b 收尾与文档同步>
2. 执行方式：
   - 先做只读多路审计，切分为 file-disjoint 的小任务卡并按 v2 分级（L/H/U）定好目标分支；
   - 在默认 v2 并发与资源守卫（运行中 writer <= 5，除非当次会话获用户明确授权提高吞吐；available >= 500 MiB；尊重 H 栈上限与 run-heavy 锁）下并发派发 `Workspace: "share"` worker subagent 修复、补回归单测、跑极速本地门禁后 push & 开 PR（L 卡 `--base integration/opening`，仅当会话获整批授权时直指 `feat/opening-release`；H 卡独立 `--base feat/opening-release`）；
   - 按 v2 规则在精确 `headRefOid` 上取得独立审查（启用指定 `Claude Opus 5.5 high` + 独立 `GPT` 渠道时按 L/H 要求取齐；若当前会话获用户明确授权 Antigravity 自主运行，则并发派发安全/边界与行为/测试双视角只读 reviewer subagent 作为合入前技术门禁，绝不擅代指定 v2 签批或 H/U 用户审批）；
   - 等待远端 CI 使用 `schedule` 唤醒而非轮询 sleep；
   - 审查门禁通过且精确 `headRefOid` 上 BOTH `lint-typecheck-test-build` 与 `real-worker-pdf-browser-flow` 均全绿后，由唯一集成者以 `--match-head-commit` 合入目标分支，按 v2 节奏批量提升 `integration/opening`，并在无未提升独有提交时对齐双干线、清理已合分支；
   - 最后通过独立 PR + 必选 CI 更新 `docs/STATUS.md`（触发完整 CI）与附录 F，并输出 U 级核对单及中文《交付与浏览器验收清单》。
3. 硬边界：
   - 严禁运行本地 Playwright / 浏览器自动化 / 截图（标记“待用户浏览器验收”）；
   - 严禁执行数据库迁移/破坏性迁移、修改生产配置、触碰真实用户数据或擅自定样；
   - 公开文档与 PR 严禁出现本机绝对路径、主机拓扑或 PID。
```
