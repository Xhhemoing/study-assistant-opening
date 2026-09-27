# Personal-use Multi-agent Execution Protocol

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让多个 agent 在同一可复现基线上独立编写、验证与交接，不丢失现有工作，不将局部通过误报为发布。

**Architecture:** 单一协调者管理契约、文件租约、依赖和合入；实现 agent 使用独立 worktree；审查只读。原43项任务是完整范围账本，本计划PU编号仅细化个人使用切片，不替换旧状态。

**Tech Stack:** PowerShell 7、Git worktree、npm workspaces、Vitest、Playwright、现有隔离服务脚本。

## Global Constraints

- 所有命令使用pwsh；脚本首行`$ErrorActionPreference = 'Stop'`；文本读写显式`-Encoding UTF8`，二进制复制保持字节。
- 本轮仅编写计划。执行时不自动生产部署、迁移生产数据、公开服务、扩大数据授权或付费调用。
- 现有dirty文件均属用户；禁止reset/clean/stash/宽泛add覆盖，禁止从旧HEAD直接开实现分支后假装拥有未提交能力。
- Node≥20、React 18兼容、每个新改代码文件≤200行；UI仅Tailwind，图标lucide-react；包级AGENTS优先。
- 每项行为改变执行failure→cause→fix→recheck；审查意见不是测试证据。原Q03→Q01→Q02、CAP01–06/Q04门禁不降低。

## PU00：冻结可复现基线与隔离服务租约

**Owner:** COORDINATOR。**Depends:** 无。**Files:** 只在`.local/personal-use/`生成受保护的基线清单与本地日志；纳入提交的内容由逐路径清单决定。

**读取事实：** 规划时HEAD为`8d616c0622e070799a4d8a3e3e7a172cf2caa189`，分支`feat/opening-release`；112条modified、172条untracked状态记录，数量会变化。这不是新任务的可复现基线。

**Produces:** `baseline.json`包含`baseCommit,snapshotCommit,sourceRoot,paths[{path,kind,sha256}],migrationReservations,baselineChecks[{command,exit,status,artifact}],capturedAt`；`kind=tracked|untracked|deleted`，删除项sha256=null；snapshotCommit仅在真实提交后填入。

- [ ] 1. 读取status/branch/log、嵌套AGENTS；逐路径区分所需实现、无关工作、私人数据、临时与生成文件；保存允许路径，不读取或复制`.env`/凭据。untracked目录递归展开为具体文件。
- [ ] 2. 冻结期间暂停原树写入；为允许文件计算SHA256，保存删除项；生成只含允许tracked路径的二进制Git补丁，并逐一复制允许untracked文件。再次计算源文件hash，变化即作废该快照并重新核对，不能拼出混合版本。
- [ ] 3. 创建独立集成worktree，从上述HEAD应用补丁和允许文件；不改变原树/index。目标路径逐一规范化并检查在worktree根内，拒绝`..`、重解析点及已存在且来源不明的目标；二进制采用Copy-Item。
- [ ] 4. 审查集成树完整diff、秘密/生成物排除与清单hash；只暂存允许路径，按aistudy-git-workflow形成基线提交，记录真实snapshotCommit。不得自动纳入用户全部dirty内容。
- [ ] 5. 使用snapshotCommit创建`codex/personal-use-integration`及各任务`codex/pu02-continuity`等分支。优先已有隔离机制；目录默认仓库`.worktrees/`且先确认ignored。若已有外部托管worktree则沿用，不嵌套创建。
- [ ] 6. 每个实现worktree按lockfile安装依赖；禁用共享可写node_modules junction；每树独立`.next`/测试输出。所需私密配置通过现有安全注入，不复制进Git。
- [ ] 7. 在集成树执行下方基线检查，记录失败及原因。环境阻塞不算产品失败；已有产品失败先关联原任务修复，再放行依赖该行为的工作。纯离线计划/fixture准备可继续。
- [ ] 8. 扫描实际migration及原预约：规划时磁盘0001–0026，0027–0029仅预约。默认先交付恢复，若执行时仍为此状态，由协调者将恢复分配为`0027_opening_recovery.sql`，原C01/K01/K02未落盘预约顺移0028/0029/0030，并同步原总计划/子计划/interfaces，运行原计划校验后广播。若任一预约已落盘，先重新确定完整连续序列和依赖再放行；禁止改已发布SQL、空迁移填洞或直接跳到0030。

```powershell
$ErrorActionPreference = 'Stop'
git status --short --branch
if ($LASTEXITCODE -ne 0) { throw 'Git status failed' }
git branch --show-current
if ($LASTEXITCODE -ne 0) { throw 'Git branch failed' }
git log -1 --oneline
if ($LASTEXITCODE -ne 0) { throw 'Git log failed' }
node scripts/validate-opening-plan.mjs
if ($LASTEXITCODE -ne 0) { throw 'Opening plan invalid' }
node --test tests/tooling/opening-plan.test.mjs tests/tooling/opening-capability-plan.test.mjs
if ($LASTEXITCODE -ne 0) { throw 'Plan gates failed' }
node node_modules/vitest/vitest.mjs run --project unit
if ($LASTEXITCODE -ne 0) { throw 'Baseline unit failure; record cause before repair' }
```

**验收：** 新worktree能在无原树未提交文件引用的情况下复现基线；每项排除/失败可追溯。基线完成不等于产品可发布。
**回退：** 仅停用本任务新worktree，保留原树和证据；没有用户数据或生产schema变更，不自动删除目录。

## 调度、文件租约与合入

- 并发上限4个agent：1协调者、最多2实现者、1独立审查者。最初三路只读分析/计划编写可以并行；代码阶段保留审查槽。
- PU00→PU01先串行。之后优先PU02+PU04；PU02合入后PU03可与PU05A0并行。PU05A0→PU05A1→PU05B→PU05C在同可靠性lane串行。
- PU03+PU04组合验证后才能PU06；PU06通过且live配置满足才能PU07；PU05C+PU06+PU07之后PU08最终交付。
- 调度先核对execution.json的dependsOn与entryGates；operationGates仅阻塞对应live/发布/部署操作，允许独立离线准备；exitEvidence在任务执行后验收，禁止反用作入口。PU07的observe/stop是已完成的观察报告，不等于verified或M4准入通过，协调者记录后修复/续观，不能自行放行PU08。
- PU00根据各子计划的Files清单生成协调者根目录的`.local/personal-use/leases.json`：`{revision,sourceRoot,leases:[{taskId,owner,worktree,writePaths,status}]}`；将花括号/通配路径展开为精确文件，拟新增文件保留精确目标路径；规范化后检查重叠并在派发前冻结。所有worktree引用同一租约文件，路径或owner变动由协调者升revision后通知。
- 同一文件只能有一个有效写租约；独立worktree不等于允许同一文件无协调改写。冲突先停该文件的实现，由协调者拆任务或串行交接，不靠最后覆盖。
- 共享单写：全部`packages/contracts/**`、所有package.json/lockfile、各包index.ts、migration编号/登记、`apps/web/src/features/opening/runtime.ts`、CI/root配置、导航入口、原tasks.json及计划索引由COORDINATOR管理。
- continuity-data独占接续repository/today reader；continuity-ui独占Today页面及接续组件；learning独占observation/read-service/learning-summary/evaluator；reliability独占backup/privacy-delete/readiness/restore。具体文件按子计划列出。
- 实现agent交付patch或自己分支的窄commit，不push、不merge、不改原树；共享单写文件交付精确建议补丁，由协调者应用后跑调用方测试。
- 每次交接先规格审查，再质量审查；审查者不能只复述实现者报告。审查失败回原owner最小修复，重新验证受影响边界。
- 合入顺序按DAG；cherry-pick到集成分支前检查status与基线SHA，冲突保持可见。共享契约变更产生新contractRevision，下游rebase后重跑，不默认兼容。
- service/DB/S3/browser/build全局仅一个重型验证租约；最多两个独立worktree的窄unit可并行。审核不绕开资源租约。
- 隔离服务现有端口15432/16379/19000/19001/3100/18081必须由协调者统一租赁，不能由两个`run.ps1`相互停止服务。仅清理本次manifest记载的PID/端口/命名空间。
- 私人材料、raw日志和截图仅进受保护的`.local/`；可提交证据只保留脱敏结果和复现命令。不得把正文、令牌、signed URL打印到协作报告。

## Agent交接记录（缺项则不能标verified）

```json
{
  "taskId": "PU02", "status": "planned", "baseSha": null,
  "contractRevision": null, "writePaths": [], "changedPaths": [],
  "checks": [], "redCauseFixRecheck": [], "reviewFindings": [],
  "remaining": [], "patchOrCommit": null
}
```

`planned`初始记录不是交付证据。交接记录status使用active/review/verified/blocked；execution.json沿用原图校验支持的planned/active/blocked/verified，审查期间保持active；checks每项必须填command、cwd、exitCode、status、artifact；未经运行留not_run，禁止预填pass。原任务仅在完整原门禁满足时由协调者提升。

## 可直接派发的提示词

> 阅读主计划、00协议及分配子计划。你的taskId/owner来自execution.json，writePaths来自协调者冻结的.local/personal-use/leases.json（核对revision）。先核对baseline.json的snapshotCommit和contractRevision，按包级AGENTS及Graphify定位。逐项编写失败用例、复现原因、最小实现、重跑同命令。只写租约路径，共享文件给协调者补丁；不碰其他dirty内容。付费/生产/新授权保持blocked，继续不依赖它的任务。结束提交精确变更、红绿证据、未运行项、回退方式和交接记录。发现接口冲突先回报，禁止自行发明平行契约。

## 异常恢复与重启

- agent超时/503后先检查文件、diff、进程与测试产物；不能把中断当零写入。保留有效工作，重新分派原任务，不启动第二个同文件写者。
- 连续服务错误时协调者接管该lane或减少并发；记录实际参与情况，不虚构独立审查。用户已要求自主推进，普通修复/只读核验不反复征求许可。
- 新会话先读主计划、execution.json及最近交接记录；以实际文件/提交/运行证据校准状态。任务未完不在聊天中宣称会后台自动继续。
