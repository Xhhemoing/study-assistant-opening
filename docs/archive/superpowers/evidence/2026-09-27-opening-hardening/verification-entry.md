# 验证入口优化：执行记录

日期：2026-09-27。对应用户提供的优化计划 OP-01–OP-03；原任务 B02、F03、Q01、RP5、Q03。

## 范围与当前代码

- 起始分支：`feat/opening-release`，Git 提交 `5154078f183bfea13ffb03214f2d2ae49b4a24ea`，与附件审阅版本一致。
- 本记录描述该提交之上的未提交工作区改动，不冒充合并后 CI 或发布证据。
- 开始时已有未跟踪的 `.superpowers/`、`.tmp-ts-check.mjs`、`NUL`、`topic3_taylor_extract.txt`，均保留。
- 依用户要求，不新增哈希、冻结契约、额外基线或门禁。复用现有迁移器、隔离库保护及测试入口，不削弱已有安全措施。
- 原 43 项任务账本及 RP1–RP6 状态不变；附件 JSON 只作实施索引，不建立另一份任务账本。
- 不运行付费模型，不导入真实用户数据，不执行生产迁移或发布。OP-16 仍按原计划延后。

## 实际环境

Windows；Node.js 24.18.0、npm 11.16.0、PostgreSQL 17.5、Python 3.13.14。
隔离 PostgreSQL 在本次新建的 `.local/opening-hardening-pg`，仅监听 loopback 端口 55439。
测试数据库名为 `aistudy_opening_test`，不连接现有应用数据目录。验证结束后已关闭本次 PostgreSQL，保留忽略目录中的测试数据与日志。

现有 migration 文件为 `0001_library.sql` 至 `0026_opening_turn_outcome_unknown.sql`，本轮没有新增或修改数据库 migration。
现有 Python 环境用于复现；另建 `.local/opening-parser-clean` 验证依赖安装。
Linux GitHub Actions 使用的环境与本地不同，必须独立验证。

所有手工命令通过 PowerShell 执行。为遵守用户不混用 Bash/cmd 的要求，本地 lint/typecheck/test 直接调用项目安装的 Node CLI，构建调用原有 `npm run build`。Git Bash 仅作为原有测试/脚本的子进程依赖进入本次进程 PATH，不改系统 PATH 或原有包装器。远端 CI 仍需独立执行。

## OP-02：失败 → 原因 → 修复 → 复查

### 空测试库缺表

1. **失败**：启用既有隔离库开关，设置本次隔离库地址，运行：
   `node node_modules/vitest/vitest.mjs run --project integration tests/integration/opening-tutor-turn.test.ts`。
   原代码退出 1，suite 初始化报告 `relation "users" does not exist`；19 条测试被初始化失败阻断，不能计为已执行。
2. **原因**：`scripts/opening-test-db.mjs` 的 globalSetup 只验证并传递 URL；fixture 随即 INSERT users，没有明确的 schema 初始化步骤。
3. **修复**：在现有校验成功后导入并等待现有 `migrateFromUrl()`，不复制迁移逻辑，不依赖其他测试先运行。
4. **复查**：同一隔离库运行 tutor、migration-order、identity-migration-compatibility 三个文件，退出 0，33/33 通过。关于 schema search_path 相互干扰的假设未被复现，因此没有修改这些测试或生产迁移器。

### fixture 初始化失败泄漏连接

1. **失败**：将本次 fixture 的 `AUTH_SECRET` 设为空，以真实 JWT 失败中断初始化；用户记录已插入，`pg_stat_activity` 仍存在该 fixture 的 1 个连接。
2. **原因**：初始化异常未进入 fixture 返回值中的正常关闭方法。
3. **修复**：用局部 try/catch 在初始化失败时等待 `sql.end({ timeout: 5 })`，再抛出原错误。
4. **复查**：新增 `tests/integration/opening-fixture.test.ts`，先观察期望 0、实际 1 的失败，再观察同一测试通过，剩余连接为 0。测试本身恢复环境并关闭观察连接。

### 已有保护

`node --test tests/tooling/opening-test-db.test.mjs`：12/12 通过。
`node --test tests/tooling/*.test.mjs`：66/66 通过（解析器修改前）。
保留启用标志、loopback、精确库名、数据库查询参数覆盖拒绝，以及 Vitest 串行执行。
修复后以 `--sequence.shuffle --sequence.seed=20260927` 重排上述三个文件及新增 fixture 回归：4 个文件、34/34 通过。OP-02 已通过独立规格审查和代码质量审查；不据此声称完整集成套件通过。

## OP-03：当前运行证据

- 已核对默认 Node runner 和真实集成测试均写死 Windows venv 路径；现有 CI 未安装 Python/parser 依赖。
- 修改前，现有 Python 环境运行 `python -m pytest services/parser/tests -q`：6 passed、1 existing xfailed，76.09 秒。这个 PPTX xfail 不是已通过的真实转换证据。
- 已用干净环境中的 uv 0.12.19 对实际已用的 Docling 2.126.0 与 pytest 9.1.1 生成无新增哈希的跨平台依赖版本清单；实际在新 venv 安装成功（退出 0），`pip check` 报告 No broken requirements found。

### OP-03 的修改与复查

- 配置以模块所在仓库为起点，开发环境选择对应平台的 venv；Worker 从 `apps/worker` 启动时也能解析到正确目录。生产和 CI 显式配置路径。
- 启动先进行目录、可执行文件及限时 Python 导入检查，再创建数据库、Redis 或 S3 客户端。缺少运行环境不再延迟到消费任务才报错。
- 真实数据库解析集成测试复用同一配置入口；既有 PDF、unsupported MIME、临时文件清理等断言保留。
- 新环境安装仅使用一份依赖版本清单，没有新增哈希校验。模型准备为单独联网步骤，使用已有模型清单；文档转换继续强制离线。
- 干净 Python 3.13.14 venv 的 `python -m opening_parser --check` 退出 0；`python -m pytest services/parser/tests -q` 为 **14 passed，110.39 秒**，包括真实两页 PDF、真实两页 PPTX、超时/输出上限及启动错误。这里复用已有模型缓存，不声称重新下载了全新缓存。
- Node parser 定向测试 4 文件 / 25 测试通过；路径、初始化失败、取消与捕获上限均有回归。OP-03 独立规格及代码质量审查通过。
- 全仓 ESLint 退出 0；domain/contracts/config/database/ai/ui/worker/web 及 E2E 共 9 个 TypeScript 配置检查均退出 0。

### 本地测试进程 PATH 问题

首次全量 unit/contract：217 文件通过、1 文件失败、1 文件跳过；1165 测试通过、1 失败、12 跳过、1 todo。
唯一失败是原 `ci-workflow.test.ts` 的 Bash 包装器用例：`spawnSync` 找不到 Bash，stdout 为 undefined。
已确认 Git 自带 `C:/Program Files/Git/bin/bash.exe`，仅未在测试进程 PATH 中；在本次 PowerShell 验证进程补路径，不修改测试或系统配置。
同一 CI 契约文件复查：4/4 通过。完整重跑结果在下方最终验证表中记录；既有 skipped/todo 不计为通过。

## 最终验证汇总

| 检查 | 本次结果 |
|---|---|
| 全仓 ESLint | pass，退出 0 |
| 8 个包/应用与 E2E TypeScript | 9/9 配置 pass |
| Unit + contract 完整重跑 | 218 文件通过、1 文件跳过；1166 测试通过、12 跳过、1 todo；退出 0 |
| 测试库初始化/失败清理/迁移兼容（重排） | 4 文件、34 测试通过 |
| Python 干净环境 | 安装、pip check、启动检查通过；14 测试全部通过，无 xfail |
| 实际 Node→Python→两页 PDF | pass；断言页号、两页预期文字和 imagePath；不含 S3/DB 环节 |
| Node tooling | 67/67 通过 |
| 原计划结构检查 | 43 项任务检查通过；仅结构检查，不代表应用正确 |
| 技术 Spike | 首次 2 文件失败、4 文件通过：未传 DB URL 命中未启动的 5432，另有 Redis 连接拒绝导致队列超时。显式使用本次隔离 DB 后，数据库 Spike 1/1 复查通过；Redis 项仍受阻，不改测试、不延长超时掩盖问题 |
| 完整 integration / handler / browser | not_run：需要尚未可用的隔离 Redis/MinIO；定向真实 DB 回归不替代完整套件 |
| Worker + Web 生产构建 | `npm run build` 退出 0；Next 完成编译、类型检查、59 页静态生成及构建追踪 |
| Graphify | `graphify update .` 退出 0，纯 AST、无 LLM；生成产物继续被忽略。现有 SQL 解析扩展缺失，27 个 SQL 文件未进入图，本轮未改 migration，不额外安装工具 |
| 更改后的 Linux GitHub Actions | not_run：当前是未提交工作区，没有更改后远端 run |

所有运行日志保留在忽略目录 `.local/opening-hardening-evidence/`，不提交构建产物、测试数据库、模型文件或真实材料。

## RP1–RP6 的证据边界

| 原任务 | 当前代码/测试位置 | 本次能证明什么 |
|---|---|---|
| RP1 | opening-tutor-history、opening-tutor-privacy-input 测试 | 代码/测试存在，不自动等于隐私闭环验收 |
| RP2 | opening-tutor-jobs、opening-privacy-writeback-race、opening-worker-privacy-race | 已有并发测试入口，未据此改任务状态 |
| RP3 | opening-conversations、opening-conversation-resume、assistant-view | Tutor 定向回归通过，不代表跨刷新浏览器恢复全部通过 |
| RP4 | assistant/message-model、sources/source-service | 保留现有版本化引用实现；未进行人工支持度评价 |
| RP5 | ci.yml、docs/operations/ci.md | 修复验证入口；更改后的 Linux CI 尚未执行 |
| RP6 | planning/today-read、today-view、handler/opening-today-read | 现有读取与测试不应被误报为空壳；未作产品验收 |

## 限制、验收与回滚

- 本机启动隔离 Redis/MinIO 的命令被自动审批拒绝（仅返回 `blocked by policy`，未提供具体理由）。没有绕过拒绝，也未把模拟服务计为真实服务验收。
- 完整 Node→Python→S3→数据库解析集成、全部服务测试、浏览器 E2E 与更改后的 Linux CI 尚未完成。
- 按计划 V0 顺序，在验证入口及完整 CI 未验收前，不启动 OP-04 之后的业务状态协议与产品功能扩张。
- 合入验收应使用包含本轮更改的提交运行现有 GitHub Actions `quality`，确认真实 PDF/PPTX、integration、handler、browser 和 build 的结果，并继续按原 Q03 位置记录运行链接。
- 回滚仅撤回本轮启动入口与 parser 配置改动；不改生产 schema，不删除现有隐私、幂等、费用或迁移保护。若 parser 环境不可用，应停止新解析并保留已存材料，不标记为 ready。





## S0 执行续记（2026-09-27）

本节是上述历史记录之后的实际续跑结果。当前分支仍为 `feat/opening-release`，HEAD 为 `5154078f183bfea13ffb03214f2d2ae49b4a24ea`，验证对象包含尚未提交的运行修复及本节说明的增量。没有把工作区结果记成该 HEAD 上已经存在的远端 CI 结果。

### 环境与范围

- Windows，Node `24.18.0`，Python `3.13.14`。复用本日先前建立的 `.local/opening-parser-clean` venv 和已有模型缓存；本次没有重新安装全部依赖或重新下载模型。当前 GitHub 工作流使用 Linux / Node 22，本机结果不能替代它。
- `scripts/opening-e2e/services.ps1 start` 已实际成功。专用 PostgreSQL `15432`、Redis `16379`、MinIO `19000` 可用，SELECT、PING、S3 字节往返均通过。先前“服务启动受阻”保留为历史，已不是当前阻塞。
- integration/handler 只使用 `aistudy_opening_test`；浏览器只使用同一专用 PostgreSQL 实例中的 `aistudy_opening_e2e`。没有读取应用 `.env` 的业务数据库地址来执行迁移或清库。
- Opening 浏览器使用 `3100` 和本地 fixture model `18081`，未调用付费模型、发送外部消息或接触生产数据。默认浏览器配置另行运行，不与 Opening 子集混算。
- 保留已有 parser、CI、fixture 修复。新增增量限于 E2E parser 路径语义、类型声明、测试客户端端口修复，以及真实 PPTX / 转换失败清理覆盖；未新增 schema、hash、任务账本或门禁。

### 新增修复的失败链与复查

**E2E parser 路径。** 原 `scripts/opening-e2e/environment.mjs` 固定 Windows 路径并忽略显式 override。新增实际 builder 测试先出现 14/17 通过、3 项失败；按 Worker resolver 的模块根路径和平台规则修复后，17/17 通过。`PARSER_TEMP_DIR`、服务隔离和测试模型配置保持不变。独立质量审查发现 `.d.mts` 未声明新增第二参数；有效的内存 TypeScript 调用探针先报 TS2554，再补 `platform?: NodeJS.Platform`，同一探针零诊断，17 项测试再次通过。Windows 上传入平台参数的测试不冒充实际 Linux 执行。该修复的独立规格和质量审查通过。

**真实集成调用遗漏环境。** 空库单文件回归先通过 19/19。随后重排的五文件检查中，parser suite 因本次调用遗漏 `PUBLIC_BASE_URL`、`AUTH_SECRET` 而在 storage 初始化时失败，其他 34 项通过。根因是现有 `loadEnv` 校验；仅补专用测试环境，未改测试断言或产品代码，同一五文件、同一 seed 重跑 36/36 通过。日志为 `targeted-db-parser.log` 和 `targeted-db-parser-recheck.log`。

**测试 fixture 随机端口。** 全部 tooling 初次为 70/71，失败发生在 `fetch` 的 `bad port`，请求尚未到达 fixture；原失败没有记录具体随机端口。用仅内存替换的端口 10080 确定性复现原六项全部失败，`node:http` 能到达同一服务。最小修改仅在 `tests/tooling/opening-provider-fixture.test.mjs` 使用 HTTP 客户端，保留 port 0、六项测试和全部断言。复查发现默认连接池会复用上一短生命周期服务已关闭的 socket，观测到 `reusedSocket=true` / ECONNRESET；为该测试请求设置 `agent: false` 后，同一坏端口检查及正常随机端口检查均 6/6 通过，完整 tooling 71/71。没有固定日常测试端口或增加重试。独立规格和质量审查均通过。日志为 `provider-fixture-bad-port-red.log`、`provider-fixture-bad-port-green.log`、`tooling.log`、`tooling-recheck.log`。

**D02 缺失覆盖。** 现有 Python PPTX 测试不等于 PPTX 完整存储链。新增纯合成两页 PPTX，保留原 PDF 与 audio 断言；参数化验证真实上传、Node→Python、页码/文字/source_version、ready、staging 清除和临时目录为空。另用损坏 PDF 触发真实转换错误，断言拒绝、零 chunks、未 ready、仍 uploaded、S3 原件仍存在及临时文件清空。原件存在断言不声称逐字节完整性核验。最终单文件 4/4，通过 61.84 秒；局部 lint 通过，独立规格和质量审查通过。本次是对已有行为补覆盖，没有虚构产品缺陷或 TDD 红灯。

该解析测试沿用既有 teardown：本次临时目录与 S3 新增对象已清除；旧对象不动。专用测试 DB 保留最后 audio source 和 fixture 元数据，chunks 为零，不声称已把测试库彻底清空。

### 本轮实跑结果

| 检查 | 结果与准确边界 |
| --- | --- |
| `node scripts/verify-ci.mjs` | pass；含既有 CI 契约 4/4 |
| 全仓 ESLint / TypeScript | ESLint exit 0；9 个现有 TypeScript 配置全部 exit 0；后续仅测试增量另跑局部 lint |
| unit + contract | 218 文件通过、1 文件跳过；1166 项通过、12 跳过、1 todo；退出 0 |
| 空库单独 tutor | 确认专用库 public schema 0 表后，由 globalSetup 迁移；19/19 |
| 重排 DB / fixture / parser | seed `20260927`，5 文件、36/36；含真实 PDF、失败连接清理与迁移兼容 |
| 完整 integration | 48 文件、256/256，226.56 秒；此全量运行早于补加 PPTX / 损坏 PDF 用例，不将两次测试重叠相加 |
| 补充解析集成 | 最终 PDF、PPTX、损坏 PDF、audio 共 4/4；见上文，未据此伪造新的全量计数 |
| 完整 handler | 23 文件、87/87，97.81 秒 |
| Python parser | 14/14，114.54 秒，无 xfail；含真实两页 PDF/PPTX |
| 技术 Spike | 6 文件、6/6；包括真实 Redis 队列与数据库 |
| 全部 Node tooling | 最终 71/71；初次失败及最小修复见上文 |
| 原任务计划结构 | 43 项，依赖无环；只证明结构，不升级业务状态 |
| Opening 浏览器子集 | `playwright.opening.config.mts`：8/8，2.5 分钟；含实际 PDF 解析、fixture 引用、原件字节下载、发送中刷新与再次刷新无重复 |
| 默认全仓浏览器配置 | 首轮 19 failed / 24 passed / 3 skipped；修复后全量复跑仍出现 Path C 失败，随后用户中断；无最终汇总，不算通过 |
| 正式 Worker + Web 构建 | `npm run build` exit 0，完成 59 页静态生成及构建追踪；沿用既有 Bash 包装器，由 pwsh 发起 |
| Graphify 更新 | 已执行 `graphify update .`，exit 0；SQL parser 缺失及少数零节点文件有警告，不将图更新当代码验证 |
| 含修复提交的 Linux CI | 尚未运行；本地工作区尚未提交/推送 |

完整日志保留于忽略目录 `.local/opening-s0-execution/`；lint/TypeScript 成功时无正文输出，其退出结果由顺序运行器记录。浏览器报告/测试结果仍属于忽略产物，不提交。原 43 项账本没有新增、删除或自动状态升级。

### 当前验收边界

S0 的本机服务验证已有上述实际证据，默认 browser 与含修复提交的 Linux CI 仍未验收。本次用户明确要求跳过测试并继续，按这一范围调整推进 S1 的有限后端实现，但不关闭 S0、不将未经验证的 S1 代码记为交付。S2–S8 尚未开始。推送仍需独立授权；没有提交、推送、合并或部署。

### 默认 browser 修复与用户调整范围

- 根因：新笔记 block ID 带 `block-` 前缀，不满足 UUID；探索晋升保存 `{ text }`，编辑器却直接作为 BlockNote 内容加载。补测试先得到 2 failed / 11 passed，再修正 UUID 与读取转换；最后编辑器 9 文件、37/37（含 UUID fallback）。
- 测试适配：补 mutating API 的 Origin；隐藏 radio 点击可见 label；命令面板等待客户端列表加载；预览从页面菜单进入；编辑器改验服务器保存，清除本地副本后刷新仍有内容。只排除 trace 确认的无 promotion-source 404，保留其他 console/page 错误断言。
- 练习根因：旧 UI 仍用 mock 题面，而会话/提交走真实 DB。fixture 只为注册的测试工作区写入相同题目。随机 ID 曾导致 API 201 但 UI 找不到题目，已调整为对应的旧题 ID。隐藏信心 radio 与判定后才出现的辅助说明也修正。teardown 删除工作区触发 append-only 保护，改为只删本例练习会话和内容，不删除学习事件、不禁用触发器。
- 诊断运行器曾把 `$DATABASE_URL` 当字面量导致 Invalid URL；只修正本地 PowerShell 变量展开，未改产品环境配置。
- 用户停止测试之前，最后定向 browser：`document-editor exploration-promotion practice-player` 为 7 passed (14.5s)；局部 ESLint exit 0，`tsconfig.e2e.json` 与 Web TypeScript exit 0。
- 默认配置使用专用 `aistudy_default_e2e`，不是 Opening 子集数据库。曾因测试 MinIO 仅允许 3100 导致默认 3000 上传跨域失败；只对自有测试 MinIO 进程临时允许这两个来源，未改仓库配置。
- 原始 `playwright.config.ts` 复跑包含正常重建，输出 Path C 失败后被用户中断。根因静态定位：`转为课程` 只在未接入 detail 路由的旧 CandidatePanel，实际路由渲染 ExplorationWorkspaceDetail。没有删除/跳过该用例；完整 browser 仍未通过。
- 原始全量日志：`.local/opening-s0-execution/browser-default-recheck.log`；定向各轮与 trace：忽略目录 `.local/trace-dbg/`。这些本地诊断产物不进入提交。
- S1 后续状态见同目录 `s1-candidate-safety.md`；其中已补非浏览器验证，浏览器验收留待用户。S0 浏览器项仍不关闭。
- 自有隔离测试服务已通过 `services.ps1 stop` 停止；此前诊断 Next 与被中断的 Playwright 进程不再监听。后续浏览器验收按更新后的 AGENTS 约定交由用户，不再作为 Agent 继续开发的前置阻塞。
