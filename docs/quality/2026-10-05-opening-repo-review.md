# 开学版仓库 Review 与整理记录（2026-10-05）

- 范围：`E:\Project\study-assistant-opening`，分支 `feat/opening-release`，审查基准 HEAD `2a10f57`（2026-10-05 11:39 UTC+8）。
- 方式：只读审查代码、文档、Git 与 GitHub（`gh`）；本地实际运行了包级类型检查、全仓 ESLint 和计划校验器。没有运行数据库、Docker、浏览器或真实模型相关测试。
- 标记约定：**[已核实]** 本次实际命令或读文件确认；**[未核实]** 只来自文档或推断，没有复跑。
- 本文是 review 记录，不提升 `tasks.json` 状态，也不代表发布验收。

## 1. 结论摘要

1. **代码基础可信，交付链路不闭合。** HEAD 上 8 个包加 e2e 的 `tsc --noEmit` 全部 exit 0 [已核实]。远端 CI（study-assistant-opening 仓库）在 `0d68232` 上只有 Browser tests 失败（23 passed / 20 failed / 3 skipped），Build 因此被跳过 [已核实]。
2. **最新 13 个本地提交（含 10-05 的账本提升、C01 凭据库、上传/OCR/记忆更正等代码）未推送，没有任何 CI 结果** [已核实]。
3. **没有任何开学版代码合入 `Xhhemoing/AIstudy` 的 `main`。** PR #2 仍为 OPEN，最后更新 2026-09-13，head `251b892` 本地不存在，是已分叉的旧线 [已核实]。
4. **账本：43 项，25 verified / 1 active (C01) / 17 planned；校验器 PASS，Ready：Q03、V01、RP1–RP6** [已核实]。10-05 一次性把 11 项从 planned 提升为 verified（`4eaf858`），均明确不含浏览器验收。
5. **RP1/RP2 的核心实现与测试在代码中已存在，但账本仍是 planned。** 按总计划，M2 门槛＝M01–M03＋RP1＋RP2，因此 **M2 在账本上未正式达成**（见 §3）。
6. **浏览器 CI 的 20 个失败中，至少 5 个已确认是测试选择器/文案与现 UI 不一致**（auth 1 个、opening-shell 4 个）；其余 15 个根因未核实（§4.1）。
7. **仓库卫生问题：** `b31feb7`（UI 提交）误提交了 2 个 tsx 编译缓存文件（`undefined/temp/tsx-86080/*`），同时夹带删除 `.learnings/`、`TODO.md`、`sync.sh` 等多处非 UI 改动；本地 `npm run lint` 因 `apps/web/.next-preview` 构建产物未被 ESLint 忽略而报 21111 个错误（源码本身无报错）。
8. **Notion 开学版看板无法访问**（当前连接的是另一个工作区，页面 404），看板与仓库的一致性未核实。

## 2. 仓库现状（分支 / 远端 / worktree / CI）

### 2.1 远端与分支 [已核实]

| 项 | 状态 |
|---|---|
| `origin` = `git@github.com:Xhhemoing/AIstudy.git` | SSH 拉取失败（Permission denied (publickey)），本地 `origin/*` 为旧引用；经 `gh api` 读取：`feat/opening-release`=`251b892`（PR #2 head），`main`=`7e0f6b8` |
| `study-assistant-opening` = `https://github.com/Xhhemoing/study-assistant-opening.git` | 公开仓库，默认分支 `feat/opening-release`=`0d68232`（2026-10-02 11:35 UTC+8）|
| 本地 `feat/opening-release` | `2a10f57`，相对 `study-assistant-opening/feat/opening-release` 领先 13、落后 0；相对 `main` 领先 121 |
| 未推送提交（13） | `eda6be5` `b31feb7` `5bd0d15` `78c10b4` `4eaf858` `b725636` `2d078b9` `a8d7c8d` `eeb40f7` `49de3bd` `abcc20c` `3b6b49a` `2a10f57` |
| 工作区 | 干净，仅未跟踪 `.learnings/`（本次已加入 `.gitignore`）|

### 2.2 Worktree 与 codex 分支 [已核实]

| Worktree / 分支 | HEAD | 与本分支关系 |
|---|---|---|
| `E:/Project/AIstudy` · `feat/complete-phase1-current-work` | `e7639c9` (09-06) | 已是本分支祖先（已包含）|
| `study-assistant-personal-use` · `codex/m4-integration` | `4382566` (09-25) | 自 `8d616c0` 分叉，独有 28 提交 |
| `study-assistant-personal-use-next` · `codex/personal-use-integration-next` | `296358a` (09-27) | 自 `8d616c0` 分叉，独有 52 提交 |
| `pu02`/`pu03`/`pu04`/`pu05`/`pu05b`/`pu06` · `codex/pu0x-*` | 09-25～09-27 | `git cherry` 显示其全部补丁已等价存在于 `codex/personal-use-integration-next`（各分支 not-in-next=0）|

本分支在 `8d616c0` 之后另有 26 个提交，与 personal-use 两条集成线**均未互相合并**。

### 2.3 CI [已核实]

- AIstudy：所有 CI 运行均为 failure。PR #2 最后一次运行 34761750828 失败于 “Unit and contract tests”（此前 34761135310 才是 MinIO 镜像问题）。
- study-assistant-opening：09-27 以来 8 次运行全部 failure。最新 36960887137（`0d68232`）：Lint、Typecheck、Plan/tooling、Unit/contract（2007 passed）、Spike（6）、Integration（528 passed / 1 skipped）、Handler（149）、Python parser 全部成功；**Browser tests 23 passed / 20 failed / 3 skipped，Build skipped**。

## 3. 里程碑与账本核对

### 3.1 里程碑表（定义见 `docs/superpowers/plans/2026-09-12-opening-release-implementation.md` §4）

| 里程碑 | 范围 | 账本状态 | 备注 |
|---|---|---|---|
| M0 基线可信 | B00–B02、F01–F03 | 全部 verified | 未合入 AIstudy；PR #2 OPEN、CI 红 |
| M1 能提交材料并求助 | I01–I03、T01–T03、U01–U02、U03 薄切片（+RP3 跨端恢复，09-21 追加）| 除 RP3 外 verified | 浏览器验收待用户 |
| M2 会记住、能重测 | M01–M03、L01–L03 **+RP1+RP2**（09-21 修订）| M/L verified；RP1、RP2 planned | **按修订门槛未正式达成** |
| M3 每天用得起来 | P01–P03、U03（RP6 今天页恢复入口先行）| verified；RP6 planned | 无移动端/浏览器验收；飞书真实推送属 Q02 |
| M4 基础可交付 | Q03 → Q01 → Q02 | 全部 planned；Q03 ready | 恢复 apply（PU05B B2）在 personal-use 线且未实现 [未核实，来自 progress-analysis] |
| M5 新增核心需求 | X01、C01–C03、V01、K01–K02、P04、U04、Q04 | X01 verified，C01 active，其余 planned | C01 IMAP/钉钉适配器未实现（check/sync 返回 503）|

### 3.2 证据与账本的不一致 [已核实]

1. **P02 没有评审记录。** 队友描述的 “P02 CLOSED (Reviewer PASS)” 在仓库中找不到对应签字；`docs/superpowers/plans/2026-09-19-opening-grok-execution.md` 只有 09-20 的 Coder 自报与协调者复跑（day-planner 15/15、opening-plans handler 6/6）。P02 直到 10-05 才在 `4eaf858` 中提升，同样没有评审记录。
2. **`m02-m03-active.md` 文件名与状态矛盾。** `docs/superpowers/evidence/2026-10-02-week-sprint/m02-m03-active.md` 被 M02、M03、U02 引为 verified 证据，但文件名是 “active”，正文写明浏览器验收待用户。
3. **P02/P03 证据计数不符。** `p02-p03-planning-reminders-verified.md`：integration 命令列出 4 个文件，输出却是 `Test Files 2 passed (2)`；repository 单测列出 3 个文件，输出 `2 passed (2)`。另外此文件使用 5433 端口，其它同批证据使用 15432。
4. **RP1/RP2 与 M02 重叠。** M02 证据描述的 “历史/材料隐私准入” 与 “completeTurn 在工作区行锁下原子校验 epoch” 正是 RP1/RP2 的范围。代码抽查（§4.2）确认已实现，但 RP1/RP2 仍为 planned。`docs/superpowers/evidence/2026-09-21-opening-release/rp2-writeback-race.md:72` 写明 “worker 捕获错误并调用 fail() 的并发全链路未覆盖，不能宣称完整 RP2 verified”；`continuation-status.md` 记 RP1 “已实施，尚需合入门禁”。
5. **“prior M02 tip BLOCKED”** 对应 `2026-09-19-opening-grok-execution.md` 的 “BLOCKED / Coord” 段（09-20：worker 未把 `privacy` 传给 `createTutorTurnHandler`、job 仓库无 `workspacePrivacyEpoch`）。当前代码已接线：`apps/worker/src/index.ts:77`、`packages/database/src/repositories/opening-jobs.ts:141`。
6. **任务数口径并存：** 27 项（09-12～09-14 的审计/证据）、37 项（`docs/design/2026-09-20-opening-frontend-review-plan.md:45`）、43 项（09-21 起至今）。旧文件是历史快照，不是错误，但读者容易误判。
7. **10-05 批量提升（`4eaf858`）** 的 11 项（M01–M03、L01–L03、P02、P03、U02、U03 及 C01→active）都只有自动化测试证据，没有 PR/CI 绑定 SHA，也没有浏览器验收；而 `continuation-status.md` 自己约定 “合入验收须 PR/CI 绑定 SHA”。

## 4. 代码 Review 发现

### 4.1 浏览器 CI 20 个失败的分类（run 36960887137）[部分核实]

点阵报告：11 个 F（断言失败）+ 9 个 T（超时）。

| 类别 | 用例 | 判定 |
|---|---|---|
| A. 选择器与 UI 不一致（已确认）| `tests/e2e/auth.spec.ts:13` | `getByLabel('确认密码')` 同时命中输入框和 “显示确认密码” 按钮（strict mode violation）[已核实] |
| A. 选择器与 UI 不一致（已确认）| `tests/e2e/opening-shell.spec.ts:9/36/52/70`（4 个）| spec 断言导航名 “Opening navigation”，而 `0d68232` 的 `apps/web/src/features/opening/shell/opening-shell.tsx:48` 实际是 `aria-label="学习工作台导航"`；空状态标题 “还没有学习记录” 在源码中只出现在一个单测的否定断言里 [已核实] |
| B. 旧版界面 spec（12 个）| command-palette ×2、document-relations、document-tags、free-exploration、knowledge-links、native-backup、notebook-preview ×3、onboarding-paths、workspace-navigation | 多为等待标题/按钮超时；根因 [未核实]。CI 未设 `OPENING_RELEASE`，因此不是旧路由重定向导致 |
| C. 开学版流程 spec（3 个）| opening-upload、today-plan ×2 | 根因 [未核实] |

附带观察：Playwright webServer 日志提示 `"next start" does not work with "output: standalone"`，应改用 standalone server 启动，否则测试环境与生产启动方式不一致 [已核实是警告；是否导致失败未核实]。按 AGENTS.md 约定浏览器验收归用户，但 CI 门禁仍红，Build 永远拿不到执行证据。

### 4.2 隐私 / epoch / 权限 / 配置

| 严重度 | 位置 | 发现 | 依据 |
|---|---|---|---|
| 中 | `apps/worker/src/index.ts:37`、`:38`、`:45` | worker 直接读 `process.env` 并回落到开发默认值（`redis://127.0.0.1:6379`、`postgres://postgres@127.0.0.1:5432/aistudy`、S3 `minioadmin/minioadmin`）。web 端走 `loadEnv` 校验（`apps/web/src/server/runtime.ts:11`）。生产漏配会静默连到默认地址或用默认凭据，不会启动即失败 | 读代码 [已核实] |
| 中 | `apps/web/src/middleware.ts:33` | CSRF 同源校验在 `PUBLIC_BASE_URL` 未设置时回落到 `request.nextUrl.origin`（来自请求 Host）。缺失 Origin 时会拒绝（`access-policy.ts:49`），整体安全，但生产应强制配置 `PUBLIC_BASE_URL`，不应依赖回落 | 读代码 [已核实] |
| 低 | `apps/worker/src/runtime/run-job.ts:24-32` | `validateWorkspaceEpoch` 用 `catch` 吞掉所有错误：数据库瞬时错误也会被记为 “privacy epoch changed” 并把任务终结为 failed，错误信息误导。`:8` 的注释 “wire in opening-jobs when allowlisted” 已过时（`opening-jobs.ts:141` 已实现）| 读代码 [已核实] |
| 低 | `apps/worker/src/jobs/tutor-turn.ts:101-103` | tutor 任务的 epoch 基线在**执行时**读取，`opening_tutor_jobs` 没有入队时的 `privacy_epoch` 快照（只有 `opening_jobs` 在 0018 中有）。入队后、执行前发生删除时不会被识别为 “epoch 变化”；执行时会重读排除列表，所以风险有限 | 读代码与迁移 [已核实]；实际影响 [未核实] |
| 低 | `packages/database/src/storage/opening-credential-vault.ts:61` | AES-GCM 解密未指定 `authTagLength: 16`，理论上接受截断的认证标签；建议显式限定 | 读代码 [已核实] |
| 低 | `apps/web/src/app/api/opening/health/route.ts:1` | Web 路由通过 7 级相对路径导入 `scripts/opening-readiness-probes.mjs`，形成应用对仓库脚本的耦合；该路由不需鉴权，且每次请求都探测 DB/Redis/存储 | 读代码 [已核实] |
| 低 | `packages/database/src/repositories/opening-tutor-jobs.ts:220` | `completeTurn` 锁工作区行时只按 `id`、不带 `owner_user_id`；后续更新以 `workspace_id` 限定，目前无越权路径，仅一致性建议 | 读代码 [已核实] |
| 信息 | `apps/web/src/features/opening/planning/review-discard-service.ts:10` | `x-opening-caller` 头部检查由客户端控制，不是安全边界；真正鉴权是 `requireOpeningScope` | 读代码 [已核实] |

**RP1/RP2 抽查结论 [已核实存在，完整性未核实]：**

- RP1：`packages/database/src/repositories/opening-tutor-history.ts:10/27/30` 使用 `listExcludedSourceIds` 让引用了被排除来源的历史失效；集成测试在 `tests/integration/opening-tutor-history.test.ts:41/50`。计划要求的 “断言实际发往 Provider 的输入不含被排除内容” 本次未核实。
- RP2：`opening-tutor-jobs.ts:217-229` 在事务内 `SELECT privacy_epoch ... FOR UPDATE` 并比对 `expectedPrivacyEpoch`；worker 在 `tutor-turn.ts:196` 传入。测试：`opening-tutor-terminal.test.ts:268`、`tests/integration/opening-privacy-writeback-race.test.ts:112`、`tests/integration/opening-tutor-turn.test.ts:240`。
- 归属扫描：54 个 `apps/web/src/app/api/opening/**/route.ts` 中，除公开的 health 外都经 `requirePrincipal`/`requireOpeningScope` 或委托服务鉴权（正则扫描后对 4 个未命中文件逐一人工核对）[已核实]。逐条 owner 过滤的 SQL 未全量审查 [未核实]。

### 4.3 测试缺口

| 严重度 | 位置 | 发现 |
|---|---|---|
| 中 | `tests/contract/opening-real-use-ac.placeholders.test.ts:125` | AC01–AC12 共 12 个真实使用验收用例全部 `it.skip`，注释 “Placeholder until F02 verified”，但 F02 已于 09-13 verified，文件最后修改是 09-16（`381ea68`）。`opening-real-use-ac.probes.test.ts` 有 11 个 `it`、1 个 `it.todo`（AC12）。与 RU-01～07 审计对应的验收至今未成测试 |
| 中 | 浏览器 | 同上 §4.1；账本中 U02/U03/M01–M03/L01–L03/P02/P03 的浏览器验收全部待用户 |
| 低 | `tests/integration/opening-learning-summary-performance.test.ts:128` | 性能用例 `skipIf(!enabled)`，CI 中 skip（与 integration 的 1 skipped 吻合，[推断]）|
| 信息 | 全仓 | 没有 `.only`；`TODO/FIXME/HACK` 在 `apps/`、`packages/` 中 0 处 [已核实] |

### 4.4 工程卫生

| 严重度 | 位置 | 发现 |
|---|---|---|
| 中 | `undefined/temp/tsx-86080/17909-*`（2 个文件，已被跟踪）| `b31feb7` 误提交的 tsx 编译缓存，内含 `packages/config/src/opening-model.ts` 的编译代码和本机绝对路径（`E:\Project\...`）。不含密钥，但不属于仓库。目录名 “undefined” 说明某处临时目录环境变量为空 [推断] |
| 中 | `b31feb7` “feat: 深度优化界面 UI 和交互体验” | 一个 UI 提交混入大量非 UI 变更：删除 `.learnings/*`、`TODO.md`、`.hermes.md`、`sync.sh`、`demos/pelican-bicycle.html`、pi-sparkle 技能和一份 07-21 计划，重写 `AGENTS.md`，从 `eslint.config.mjs` 去掉 `.hermes/**`、`project/**` 忽略。建议 Heidi 确认这些删除是否有意 |
| 低 | `eslint.config.mjs:7-17` | 忽略列表有 `**/.next/**`、`**/.next-opening-e2e/**`，但没有 `.next-preview`。本地 `eslint .` 报 21111 个错误，**全部**来自 `apps/web/.next-preview`；CI 中没有该目录，所以 CI 的 Lint 通过 [已核实] |
| 低 | `package.json` 的 `typecheck/lint/test/build` | 都经 `bash scripts/run-heavy.sh` 执行；Windows 本机 PATH 中没有 `bash`，`npm run typecheck` 直接失败（`'bash' is not recognized`）。本次改为逐包直接运行 `tsc`，全部通过 [已核实] |
| 低 | `.agents/skills/impeccable/` 与 `.github/skills/impeccable/` | 两份同名技能（分别 151 和 145 个跟踪文件），各含一个 513,309 字节的 `scripts/live-browser.js`，属于重复内容 |
| 信息 | `.tmp/`（已忽略，仅本地）| 含 `ffprobe-static-3.1.0.tgz`（121,756,431 字节）、`ffmpeg-installer-win32-x64-4.1.0.tgz`（22,202,240 字节）和若干 09-20 的一次性修复脚本；不进仓库，但占本地磁盘 |
| 信息 | 密钥扫描 | 对跟踪文件按 `sk-…`、`AKIA…`、私钥头、`ghp_…`、`xox[bp]-` 模式扫描，0 命中 [已核实；仅限这些模式] |

## 5. 文档与计划整理建议

| 文档 | 判定 | 建议 |
|---|---|---|
| `docs/superpowers/plans/opening-release/tasks.json` | **当前唯一状态源** | 保持；状态变更只在这里改 |
| `docs/superpowers/plans/2026-09-12-opening-release-implementation.md` | 当前总计划（43 项、M0–M5）| 保持；§6 “当前证据入口” 可补一条指向最新 review/progress 的链接 |
| `docs/superpowers/plans/opening-release/continuation-status.md` | 执行游标，停在 2026-09-25，已滞后 | **本次已加滞后提示行**（不改正文）|
| `docs/superpowers/plans/progress-analysis-2026-10-05.md` | 10-05 进度校准 | 当前有效；放在 `plans/` 根目录不太合适，建议以后进度类文档统一放到 `docs/quality/` 或 `opening-release/` 下 |
| `docs/plans/2026-10-02-week-sprint-plan.md` | 10/2–10/7 冲刺计划 | 当前有效；冲刺结束（10-07）后标记完成并链接证据 |
| `docs/superpowers/plans/2026-10-04-opening-upload-flow.md` + `specs/2026-10-04-opening-upload-flow-design.md` | 最新上传流程设计 | 当前有效 |
| `docs/superpowers/plans/2026-09-19-opening-grok-execution.md`、`docs/plans/2026-09-18-quality-dual-agent.md`、`docs/quality/grok-bot-opening-code-prompt.md` | Q-R1 / Stage 0–1 双代理执行期文档 | 历史；建议加 “历史执行记录，状态以 tasks.json 为准” 的提示 [待确认] |
| `docs/quality/opening-plan-audit.md`、`opening-real-use-audit.md`、`opening-real-use-evidence.md`、`opening-t03-*.md`、`opening-ru04-f02-contract-gaps.md` | 基于 27 项旧账本的 09-13/14 审计 | 历史快照；RU-01～07 / AC01～AC12 的处置仍未落成测试（§4.3），建议在 traceability 中跟踪，不必改原文 |
| `docs/design/2026-09-20-opening-frontend-review-plan.md` | 引用 37 项口径 | 历史；可加口径说明 [待确认] |
| `docs/superpowers/plans/personal-use/*`、`2026-09-25-personal-use-multi-agent.md` | personal-use 线计划，执行在其他 worktree | 需决定与开学版的合并路线后再整理 [待确认] |
| 08 月及更早的 `docs/plans/*`、`docs/superpowers/plans/2026-08-*` | 一期（Library/Learn/Explore）旧计划 | 可整体归档到 `docs/archive/`（移动文件，需确认）|

## 6. 整理清单

### 6.1 已执行（单个本地提交，未推送）

1. 新增本文件 `docs/quality/2026-10-05-opening-repo-review.md`。
2. `.gitignore` 新增 `.learnings/`（agent 自我改进日志；`b31feb7` 已有意从仓库删除，10-04 又在本地重新生成）。
3. `docs/superpowers/plans/opening-release/continuation-status.md` 顶部加一行滞后提示（不改正文）。

### 6.2 待 Heidi 确认（本次未执行）

1. **推送** 13 个本地提交到 `study-assistant-opening`，让 CI 在 `2a10f57` 上重跑。
2. **删除被误提交的 `undefined/temp/tsx-86080/*`**（2 个文件），并把 `undefined/` 加入 `.gitignore`。
3. **确认 `b31feb7` 中的非 UI 删除**（`TODO.md`、`sync.sh`、`.hermes.md`、pi-sparkle 技能、demo、07-21 计划、ESLint 忽略项）是否有意；如非有意需恢复。
4. **`eslint.config.mjs` 增加 `**/.next-preview/**` 忽略**（一行配置改动）。
5. **修复浏览器 spec 漂移**：`auth.spec.ts:18` 改用 `getByRole('textbox', { name: '确认密码' })`；`opening-shell.spec.ts` 对齐 “学习工作台导航” 与当前空状态文案；其余 15 个失败逐个定位。是否授权 Agent 运行 Playwright 需你决定（AGENTS.md 默认不允许）。
6. **worker 配置改为启动时校验**（与 web 的 `loadEnv` 一致，生产缺配即失败）；生产强制 `PUBLIC_BASE_URL`。
7. **RP1/RP2 补核验后再决定是否提升**：补 “实际发往 Provider 的输入” 断言和 worker `fail()` 并发全链路，然后由集成者更新 `tasks.json`（本次不改状态）。
8. **修正证据文档**：P02/P03 计数不符需重跑并更正；`m02-m03-active.md` 改名或补 “verified 依据” 说明；为 P02 补评审记录，或明确 “无独立评审”。
9. **AIstudy PR #2 处置**：关闭或改为从 `study-assistant-opening` 重新开 PR；修复 origin 的 SSH key 或改用 HTTPS remote。
10. **清理已被 integration-next 吸收的 codex 分支和 worktree**：`codex/pu02`～`pu06`、`pu05b`（`git cherry` 显示补丁均已存在于 `codex/personal-use-integration-next`）。删除前请再确认这些 worktree 没有未提交改动（本次未检查 dirty 状态）。
11. **决定三条线的合并路线**：`feat/opening-release`、`codex/personal-use-integration-next`、`codex/m4-integration` 都从 `8d616c0` 分叉，互不包含。
12. **本地磁盘清理** `.tmp/` 中约 144 MB 的 ffmpeg/ffprobe 包和一次性脚本（已忽略，不影响仓库）。
13. **合并重复技能目录** `.agents/skills/impeccable` 与 `.github/skills/impeccable`。
14. **AC01–AC12 占位用例**：要么实现，要么在 traceability 中注明延期原因，并把 skip 注释更新为真实的阻塞条件。

## 7. 建议下一步

1. 先推送并拿到 `2a10f57` 的 CI 结果（不推送，后续所有 “verified” 都没有 CI 绑定）。
2. 修复已确认的 5 个浏览器 spec 漂移，定位其余 15 个，让 Build 步骤至少跑一次。
3. 完成 RP1/RP2 剩余核验，按修订门槛正式关闭 M2；再做 RP3（M1）和 RP6（M3）。
4. 开始 Q03（打包/恢复），它是 M4 的唯一入口；同时需要决定 personal-use 线 PU05B B2（restore apply）如何并入。
5. 浏览器验收（用户）：按 `m1-m2-desktop-verified.md` 的入口走一遍上传 → 对话 → 记忆 → 课程 → 不保存模式。
6. Notion 开学版看板需要在正确的工作区重新授权连接后再核对（本次 404，未核实）。

## 附：本次实际运行的检查

| 检查 | 结果 |
|---|---|
| `node scripts/validate-opening-plan.mjs` | PASS（43 tasks）；Ready: Q03, V01, RP1–RP6 |
| `tsc -p <pkg>/tsconfig.json --noEmit`（domain/contracts/config/database/ai/ui/worker/web）+ `tsconfig.e2e.json` | 全部 exit 0，合计约 49 秒 |
| `npm run typecheck` | 本机失败：`bash` 不在 PATH（工具链问题，非代码问题）|
| `eslint .` | 21111 errors，全部位于 `apps/web/.next-preview`（构建产物）|
| `gh run view 36960887137 --log-failed` | 浏览器失败明细见 §4.1 |
| 未运行 | unit/integration/handler/browser 测试、构建、数据库与 Docker 相关检查 |

## 处理记录 2026-10-05

Heidi 回复“请你分析并解决”后，按授权范围处理。分支 `feat/opening-release` 上全部为小步提交，只做快进推送到 `study-assistant-opening`，没有 force push，也没有改写历史。`tasks.json` 状态未改；AIstudy `origin` 和 PR #2 未触碰；三条分叉线未合并；`.tmp` 归档未删。

### 已完成提交

| SHA | 内容 | 证明 |
|---|---|---|
| `78caaff` | `git rm` 掉 `undefined/` 下两个 tsx 缓存文件，`.gitignore` 加 `undefined/`；ESLint 忽略 `**/.next-preview/**` | 全量 `eslint .` exit 0 |
| `e7ae27c` | 浏览器用例对齐当前 UI：`auth.spec.ts` 的“确认密码”用 exact 定位；`opening-shell.spec.ts` 导航名改为“学习工作台导航”，空状态和登录跳转断言同步更新 | e2e tsc 与 eslint 通过；CI 37273710573 中 auth 和 opening-shell 已不在失败列表 |
| `25c5762` | Worker 启动时用 `loadWorkerEnv` 校验基础设施 env：生产环境缺变量直接失败（fail closed），非生产才保留本地默认值 | `worker-env.test.ts` 4 个用例 |
| `3f62121` | 生产环境未配置 `PUBLIC_BASE_URL` 时，middleware 对 cookie 鉴权的写请求返回 500 CONFIGURATION | `access-middleware.test.ts` 新增 3 个用例 |
| `2f4ba3a` | `run-job` 只有真实 epoch 不一致才记为“privacy epoch changed”；epoch 查询本身出错时不再伪装成隐私变化 | 新增 2 个用例，旧代码上确认失败 |
| `3fd3503` | AES-GCM 加解密固定 `authTagLength: 16`，截断的 tag 不再能通过认证 | 新增用例，旧代码上确认 RED（Node 24 接受 4/12 字节 tag） |
| `a72cdd0` | RP2：补 worker 侧单测，`completeTurn` 因 epoch drift 被拒时走 `fail()`，不走 `markUnknown` | `tutor-turn.test.ts` 29/29 |
| `ec0b713` | 证据文档：P02/P03 追加 2026-10-05 更正节（不改原文）；M02/M03 追加“浏览器验收仍待做”的说明 | 见下文 |
| `69060f1` | 集成测试 `identity-migration-compatibility` 的期望迁移列表补上 0039–0042 | CI 37272218428 集成测试通过 |
| `867c7d6` | 集成测试 `opening-worker` 的 parse epoch 用例：显式推进 workspace epoch，用例结束后恢复 | 同上 |
| `3bbe030` | 修复：a8d7c8d 去掉了“以 epoch 当版本”的围栏后，解析失败可能覆盖新版本的 source 状态（代码注释写明不允许）。现在 parse job 的 payload 带 `sourceVersion`，`failOpeningJob` 只更新对应版本；旧 payload 不加围栏。按 a8d7c8d 的设计，epoch 变化改为期望 `PARSE_STALE` | `opening-job-failure.test.ts` 4/4；CI 集成测试通过 |
| `2e018bb` | 修复：`route.ts` 导出了非路由字段 `summarizeOpeningHealth`，导致 `next build` 失败，Playwright webServer 起不来。逻辑和测试移到 `features/opening/health/` | CI 37273710573 的 build 通过，浏览器测试得以运行 |
| `eb98177` | e2e：document-editor 的两个“新建笔记”链接改用 `.first()` 消除歧义；opening-upload 把测试超时调到 180s（原 90s 小于用例内部 120s 的等待） | e2e tsc/eslint 通过；待最终 CI 验证 |

### 本地门禁（Windows，Node v24.18.0）

- tsc：8 个包和 `tsconfig.e2e.json` 全部 exit 0。全量 `eslint .` exit 0。
- unit：`--project unit` 309 个文件、2077 个用例全部通过。
- contract：18 passed / 1 failed。失败的是 `ci-workflow.test.ts` 中需要 `bash` 的用例，原因是本机没有 bash，属环境问题，CI 上通过。
- handler 和 integration 无法在本机运行：15432 上共享的 `aistudy_opening_test` 已被 `codex/personal-use-integration-next` 线迁移过（`MIGRATION_UNKNOWN_HISTORY: 0027_opening_recovery.sql`）。因其他线也在用，没有重置。另有 17 个 SQL 文件的工作区副本是旧的 CRLF（属性是 `eol=lf`），导致 checksum drift，已按索引内容重新检出，内容不变。这两类测试以 CI 的全新数据库为准。

### CI 结果（`Xhhemoing/study-assistant-opening`）

| run | 提交 | 结果 |
|---|---|---|
| 37270915283 | `ec0b713` | Integration 失败：7 failed / 537 passed（3 个文件）。原因是迁移列表过期、parse epoch 用例过期、解析失败投影的版本围栏。浏览器测试未运行 |
| 37272218428 | `3bbe030` | Integration 和 Route handler 全部通过；浏览器测试的 webServer `next build` 类型错误（health route 导出） |
| 37273710573 | `2e018bb` | Browser：16 failed / 27 passed / 3 skipped（上次 run 36960887137 为 20 failed / 23 passed）。Build 因此被跳过 |

最后一次推送（含本文档）的 CI 结果见交付报告。

### 剩余浏览器失败分类（run 37273710573）

- **遗留界面（需产品决定，不是代码回归）**，共 13 个：command-palette ×2、document-relations、document-tags、free-exploration、knowledge-links、native-backup、notebook-preview ×3、onboarding-paths（Path C）、today-plan ×2（走 `/learn`）、workspace-navigation（Learn/Explore/Library）。a8d7c8d 把导航收敛为三个 Opening 入口，middleware 也把 `/learn` 等重定向到 `/opening/*`。这些用例仍按旧界面断言。要退役还是改写成 Opening 版本，需要 Heidi 决定。
- **已修，待最终 CI 验证**：document-editor（定位歧义）、opening-upload（超时预算）。

### 验证结论（RP1 / RP2，未改账本）

- RP1：已核实 `opening-tutor-history.ts` 的隐私过滤，以及 `tests/integration/opening-tutor-history.test.ts`、`opening-tutor-privacy-input.test.ts` 的覆盖。
- RP2：已核实 `opening-tutor-jobs.ts` 的 `FOR UPDATE` 加 `expectedPrivacyEpoch`、`opening-tutor-terminal.test.ts:268`、两个真实并发集成测试（`opening-privacy-writeback-race`、`opening-worker-privacy-race`），以及本次补的 worker 单测。`rp2-writeback-race.md:72` 记的缺口（worker 的 fail() 全链路）已由 `opening-worker-privacy-race.test.ts` 和本次单测覆盖。
- 两项代码和测试层面均可支持 verified，但账本状态按约定由 Heidi 决定。本次因数据库原因没能在本机复跑这两个集成测试，CI Integration 已通过。

### Worktree / 分支清理

- 已移除 worktree（普通 `git worktree remove`，不带 `--force`）：pu02、pu04、pu05、pu06。移除前已确认 `status --porcelain` 干净，`git cherry` 相对 `codex/personal-use-integration-next` 为 0 个未包含补丁。被忽略的 `.local/` 本地证据日志已先备份到 `E:\Project\.worktree-local-archive-2026-10-05\`。
- pu05b：git 已注销该 worktree，但目录 `E:\Project\study-assistant-pu05b\node_modules` 残留。里面是指向 `study-assistant-personal-use\node_modules` 的 junction，目标已核实完好。残留目录未手工删除。
- pu03：未移除。`.local/docling-venv` 和 `hf-home` 是指向 `C:\Users\86080\.cache\...` 与 `D:\CodexTaskCache\...` 的 junction，为避免误删外部缓存，暂不处理。
- 分支：6 个分支执行 `git branch -d` 全部被拒（"not fully merged"）。它们的补丁只是以等价补丁的形式存在于 integration-next，并没有合并进当前 HEAD。按约定未使用 `-D`，分支保留。

### 仍需 Heidi 决定

1. 13 个遗留界面浏览器用例：退役，还是改写为 Opening 版本。
2. RP1/RP2（以及 P02/P03 的复核）是否在 `tasks.json` 中提升或保持现状。P02 没有 reviewer 记录。
3. 本机测试库：给本分支单独建一个库，或决定重置共享的 15432 库。
4. 删除 pu05b 残留目录（只删 junction）、pu03 的处理方式，以及 6 个分支是否用 `-D` 删除。
5. 以下仍待确认：b31feb7 的非 UI 删除（`.learnings/*`、`TODO.md`、`.hermes.md`、`sync.sh`、`demos/pelican-bicycle.html`、pi-sparkle skills ×2 份、2026-07-21 计划文档、`AGENTS.md` 重写、ESLint 去掉的 `.hermes/**` 和 `project/**` 忽略项）；AIstudy origin 的 SSH 问题和 PR #2；三条分叉线如何合并；AC01–AC12 占位；`.tmp` 归档；是否允许 agent 在本地运行 Playwright；Notion 看板访问权限。
