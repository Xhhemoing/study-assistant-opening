# AIstudy 新版项目计划：验收与执行附件

日期：2026-09-27。返回 [主计划](2026-09-27-learning-continuity-implementation.md)。本附件描述待实施的测试与证据，不表示这些用例已经通过；A/B/C/D/E 编号是验收案例，不能与原任务账本的 B01 等编号混用。

## 1. 使用方式与覆盖来源

先执行对应切片的失败用例，确认失败源于目标缺陷，再实现最小修复并用同命令复查。现有功能若已经正确，记录真实行为并保留，不为制造“红灯”删除安全措施。并发测试用真实 PostgreSQL 两连接及确定性屏障；浏览器测试需要真实候选持久化、操作和结果读取。

| 输入章节 / 审阅发现 | 处理位置 | 验收 |
| --- | --- | --- |
| v2 §1–2、§9：证据分层与已有修复 | S0，主计划第 1 节 | D01–D02、V0 |
| v2 §3：三类审核，旧测试错误预期 | S1 | A01–A08 |
| v2 §4–5：尝试、帮助、版本、纠错 | S2–S3 | B01–B09 |
| v2 §6、§8：成长、摘要、历史规模 | S6 | B10–B12、E05 |
| v2 §7：补测时间和生命周期 | S4 | C01–C05 |
| v2 §10：三入口、恢复、日程 | S1、S5、S7 | A07、D04–D05 |
| v2 §11：资产、隐私、模型未知执行 | S5、S8 | D03、D06、E06 |
| v2 §12：恢复 | 每个数据切片＋S8 完整演练 | E07、D07–D08 |
| v2 §13–14：真实收益与依赖顺序 | 主计划第 2/6 节、S8 | V8 的使用记录 |
| 第二轮：先重放再验证陈旧状态 | S1、S3 | E01–E02 |
| 第二轮：策略版本不能触发新业务周期 | S4 | E03 |
| 第二轮：通用任务和补测权威状态 | S4 | E04 |
| 第二轮：as-of 不等于墙钟时间戳 | S2、S3、S6 | E05 |
| 第二轮：新 schema 与恢复同片交付 | S1–S7 中的持久字段变化 | E07 |
| 第二轮：设置、归档、在途作业 | S5 | E06 |
| 第二轮：禁止无条件新增哈希 | 主计划 Global Constraints、3.1 | E02；审阅本次 schema/依赖差异 |
| 第二轮：delivered 不代表阅读，AI 不仅能产候选 | 主计划 Architecture、3.2 | B04，检查面向用户的措辞 |
| 本次整理：隔离 E2E 的 Windows 解析路径 | S0 | D02；独立记录静态发现与实跑结果 |

## 2. 行为验收矩阵

### 2.1 审核与用户操作

| 案例 | 输入 / 操作 | 必须观测的结果 | 层 / 切片 |
| --- | --- | --- | --- |
| A01 | 真实保存助理任务候选，从产品审核页接受 | 正确候选离开 pending；只创建一个 opening_tasks；页面显示可进入的正式任务 | integration＋handler＋browser / S1 |
| A02 | 永久/临时记忆候选分别接受、忽略 | 走记忆命令；临时到期规则保留；不误建 task | handler＋browser / S1 |
| A03 | 补测候选接受，推荐时间存在但没有硬截止 | 消费 retest 来源；task 与活动对应；task.dueAt 不被推荐时间填充 | integration＋browser / S1、S4 |
| A04 | 助理 task 的 ID 送往 retest 接受；另构造不同来源同 UUID | 拒绝错源/错型且无正式写入；联合身份有效 | contract＋handler / S1 |
| A05 | 同 key 原请求、同 key 变载荷、不同 key 重复接受 | 依次是可重放、冲突、已处理；正式对象数量最多一 | integration / S1 |
| A06 | 接受时材料失效、其他端已处理、写任务中途失败 | 当前权限/来源复查；失败无半条正式状态；页面解释并保留可重试意图 | integration＋browser / S1 |
| A07 | 同时有会话断点和待处理建议；另测 401、读取失败、无数据 | 继续入口和审核同时可用；错误不伪装空态；无记录不造演示数据 | unit＋browser / S1 |
| A08 | 另一 owner/workspace 读取或接受候选 | 不泄露内容、来源或结果，不产生状态变化 | handler / S1 |

### 2.2 证据、纠错与历史

| 案例 | 输入 / 操作 | 必须观测的结果 | 层 / 切片 |
| --- | --- | --- | --- |
| B01 | 无 problemId 的自报“独立正确” | 普通观察保存；资格非 yes；写入、摘要、Worker 返回同样原因 | unit＋handler / S2 |
| B02 | 同 session 的 A 题提示，B 题不同 attempt 无关联帮助 | A 的提示不机械污染 B；关联不明时说明 unknown | unit＋integration / S2 |
| B03 | 同题已看答案，再建立 attempt | 历史答案曝光仍可追溯；不伪装未见新题；本次无帮助与熟悉度分开 | integration / S2 |
| B04 | 帮助在提交前、提交后、无法确认先后三种情况 | 分别影响本次独立资格、不追溯污染、unknown；可取回不宣称人已读 | unit＋integration / S2 |
| B05 | 自报/模型建议/未知方法的 reference_checked/有方法及依据的核对 | 来源与核验资格分开，前三者不自动升级为客观正确 | contract＋unit / S2 |
| B06 | 追加替换/撤销、同 root 并发纠正、旧头更新、重放 | 有效头唯一；替换不双计；撤销不计；旧头冲突但已成功原请求重放成功 | integration / S3 |
| B07 | 修改已接受/已完成补测所依赖的观察 | 未开始建议失效；接受任务提示变更；完成状态不复活，测量可待复核 | integration / S3、S4 |
| B08 | 来源从 v1 更新到 v2，旧观察固定 v1 | 旧历史保留；读取和 Worker 使用相同适用性；不把 v1 自动当 v2 | integration / S2、S6 |
| B09 | 缺历史版本、来源不可用、隐私排除 | unknown/unavailable/excluded 分开；不回填当前版，不让旧缓存继续暴露正文 | integration＋handler / S2、S5 |
| B10 | 先提示后独立成功；另一个 requirement 仍失败 | 显示成长及历史限制；不因 every() 永久否定成长，也不抹掉不同要求反例 | unit＋integration / S6 |
| B11 | 同技能有效观察 0、1、200、201 条 | 无证据不生成未掌握结论；响应满足数量上限、完整计数正确，历史可全部翻阅 | contract＋integration / S6 |
| B12 | 多技能/来源/修订链，分页期间新增、补录、纠错、删除 | 固定 revision 内无重复；新补录等待刷新；删除即时生效；报告可见性造成的数量变化 | integration / S6 |

### 2.3 补测、恢复和非测评路径

| 案例 | 输入 / 操作 | 必须观测的结果 | 层 / 切片 |
| --- | --- | --- | --- |
| C01 | 2026-09-01 观察，2026-09-27 重算两天建议 | 原建议 2026-09-03 有据可查；重新安排是显式动作，不自动改硬截止 | unit / S4 |
| C02 | 接受未来补测；完成/取消当前到期项 | 未来不 due，终态退出 due；时区与本地日历意图保留 | integration / S4 |
| C03 | 推迟/忽略后多次生成；策略升级；真正新证据周期 | 推迟期间无提醒，同一依据不骚扰，新周期有原因且可生成 | integration / S4 |
| C04 | 答错、未核验、提前作答分别提交 | 活动可 completed；correctness、独立资格和延迟资格分开 | unit＋integration / S4 |
| C05 | 通用任务 done，无观察；随后重复提醒作业 | completed/unverified，不生成正确观察，旧提醒不外发 | integration / S4 |
| D01 | 空隔离库单独运行，再变更文件顺序；故意使 fixture 身份初始化失败 | 自动应用既有迁移，不依赖其他测试；失败连接释放；业务库保护完整 | integration＋tooling / S0 |
| D02 | Windows/Linux 配置、工作目录变化、缺依赖，真实 PDF/PPTX | 实际解释器可用；两页内容、页码、对象存储、DB 及失败临时文件清理成立 | unit＋integration＋CI / S0 |
| D03 | 模型可能已执行但响应丢失，然后取消或用户明确重试 | 保留 outcome_unknown 与未决费用；取消不承诺零费用；无静默重发 | unit＋integration / S8 |
| D04 | 不建课程，读材料、笔记、探索，关闭评价，再刷新/跨端返回 | 内容可保存可找回，无强制测评或任务；不保存模式不留下恢复正文 | handler＋browser / S5、S7 |
| D05 | 依赖冲突、估时偏差、硬截止不能同时满足、任务中断 | 解释缺口并提供取舍，不占锁定时间/改截止；仅更新实际剩余量 | unit＋browser / S7 |
| D06 | 一资产关联两门课程，分别移除、归档、删除、AI 排除 | 成员关系、资产正文、自动行为、模型准入各按定义改变；不扩大访问 | integration＋browser / S5 |
| D07 | 旧备份含后来删除的来源、已完成活动；恢复后启动读取 | 叠加当前删除事实，不复活内容/提醒/外部模型作业 | integration＋演练 / S8 |
| D08 | 干净环境完整恢复、丢密钥、对象损坏、最新删除水位缺失 | 完整情形校验事实与原件并实测恢复时间；其他情形安全失败或隔离 | integration＋演练 / S8 |

### 2.4 第二轮新增的边界案例

| 案例 | 确定性交错 / 输入 | 严格预期 | 切片 |
| --- | --- | --- | --- |
| E01 | 请求 expectedHead=H1 成功产生 H2，响应丢失后原 key/原请求重试 | 鉴权后先找到原决定；重放 H2 引用，不因当前头 H2 拒绝 H1 | S1、S3 |
| E02 | T1 查 key 未命中；T2 同 key 接受并提交；T1 再取得对象锁；另测同 key 不同目标 | 前者锁后重查并重放；后者规范化意图不同而冲突；数据库只留一份决定/产物 | S1、S3 |
| E03 | policy v1 的周期已 declined，升级 v2 并两个 Worker 同时生成 | 不创建新周期；只有新可比依据/要求/显式动作才推进 cycleId | S4 |
| E04 | done 后补交答案；skipped 与 snooze；取消/提交同时发生；重开完成项 | 遵守主计划状态表；学习事实不丢；终态不复活；重开是新活动 | S4 |
| E05 | T1 锁定 historyRevision 后未提交；首屏读取；T2 等待写；随后翻页 | 首屏只捕获已提交水位；之后提交的记录不混入；历史修订按水位选头；当前删除立即覆盖 | S2、S3、S6 |
| E06 | 作业入队后关闭/归档；Worker 将要发布；接受任务已存在；再开启 | 新自动产物/提醒受抑制；已接受任务保留；不倾倒积压；保留已经外发的真实状态 | S5 |
| E07 | 每片迁移写入新事实→导出→空库恢复→重复原命令 | 新字段/历史源版本/终态/重放信息保留；旧格式 unknown；无运输 job 回放 | S1–S7 的数据变化 |
| E08 | 本地日历跨时区/DST，用户明确安排与建议日期不同 | 不用固定偏移替代 IANA；歧义时显式处理；推荐/安排/截止/最早时点分开 | S4、S7 |

## 3. 可直接纳入测试文件的最小例子

下面是拟新增或扩展的测试内容；应在对应实现切片加入文件并实际运行。它们只覆盖局部规则，不能替代上表的真实事务和浏览器用例。

### 3.1 候选联合身份

S1 在 `packages/contracts/src/opening/candidate-review.ts` 导出 `candidateRefSchema`，与主计划 CandidateRef 完全一致。新增 `packages/contracts/src/opening/candidate-review.test.ts`：

```ts
import { expect, it } from 'vitest';
import { candidateRefSchema } from './candidate-review';

it('rejects a retest kind under assistant origin', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  expect(candidateRefSchema.safeParse({ origin: 'assistant', kind: 'retest', id }).success).toBe(false);
  expect(candidateRefSchema.safeParse({ origin: 'assistant', kind: 'task', id }).success).toBe(true);
  expect(candidateRefSchema.safeParse({ origin: 'retest', kind: 'retest', id }).success).toBe(true);
});
```

handler 的 A04 再以数据库中的真实助理对象证明：即使 JSON 通过某一格式解析，错来源的实际对象仍不得被接受。

### 3.2 时间计算保留原始依据

扩展现有 `packages/domain/src/opening/retest-policy.test.ts`，保持该函数只做给定 UTC 间隔计算；用户本地日历安排另走已有 timezone 规则：

```ts
import { expect, it } from 'vitest';
import { suggestRetestAt } from './retest-policy';

it('keeps the recommendation anchored to the observation', () => {
  expect(suggestRetestAt('2026-09-01T08:00:00.000Z', 2))
    .toBe('2026-09-03T08:00:00.000Z');
});
```

S4 的真实接受测试还必须断言：现在是 2026-09-27 时，不因此把 task.dueAt 写成 2026-09-27；只通过此纯函数测试不足以证明接受链正确。

### 3.3 设置的优先级

S5 输入 `account` 为三个 boolean，`course` 为同字段的部分覆盖；缺省字段继承 account。课程可收紧，不能越过账号总关闭；archived 禁止自动行为。新增 `packages/domain/src/opening/learning-preferences.test.ts`：

```ts
import { expect, it } from 'vitest';
import { resolveLearningPreferences } from './learning-preferences';

it('does not let a course override the account assessment switch', () => {
  expect(resolveLearningPreferences(
    { assessmentEnabled: false, retestSuggestionsEnabled: true, automaticRemindersEnabled: true },
    { assessmentEnabled: true, retestSuggestionsEnabled: true },
    false,
  )).toEqual({
    assessmentEnabled: false,
    retestSuggestionsEnabled: false,
    automaticRemindersEnabled: false,
  });
});

it('stops automatic actions for an archived course', () => {
  expect(resolveLearningPreferences(
    { assessmentEnabled: true, retestSuggestionsEnabled: true, automaticRemindersEnabled: true },
    {},
    true,
  )).toEqual({
    assessmentEnabled: false,
    retestSuggestionsEnabled: false,
    automaticRemindersEnabled: false,
  });
});
```

这里 automaticRemindersEnabled 指自动学习/补测提醒；普通用户手动任务的提醒有自身设置，不因此全局删除。手工恢复某个归档任务的提醒是显式覆盖动作，不能隐式重开整个课程的自动评价。

## 4. 实施时的命令组

路径均相对仓库根 `E:/Project/study-assistant-opening`。先在同一个 pwsh 会话执行下列辅助函数，再执行目标命令组。每条 Node 命令的非零退出都中止该组，避免 PowerShell 只看到最后一个成功结果。这个函数仅用于手工执行，不作为新增仓库门禁脚本。

```powershell
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath 'E:/Project/study-assistant-opening'
function Invoke-NodeCheck {
    param([Parameter(Mandatory = $true)][string[]]$NodeArgs)
    & node @NodeArgs
    if ($LASTEXITCODE -ne 0) { throw "Node check failed with exit code $LASTEXITCODE" }
}
```

integration/handler 需要由既有隔离服务流程提供 `OPENING_TEST_DB=1` 和 `OPENING_TEST_DATABASE_URL`，并通过现有 globalSetup 校验/迁移；不得从应用 `.env` 借用业务库 URL。需要 S3/Redis 的测试必须实际启动对应隔离服务。依赖或权限受阻就记录原原因，不修改保护/跳过断言来凑通过。

Opening 浏览器使用 `playwright.opening.config.mts`，不要误用默认配置去重置另一个数据库；它会通过既有环境模块使用专用端口和测试模型。S0 先解决该模块的 parser 平台兼容性。已有 `scripts/opening-e2e/services.ps1` 的位置参数是 `start|status|stop`；只管理它拥有的进程，不终止未知服务。此文档编写未启动这些服务。

### V0：运行修复与完整验证

```powershell
$ErrorActionPreference = 'Stop'
Invoke-NodeCheck -NodeArgs @('--test', 'tests/tooling/opening-test-db.test.mjs', 'tests/tooling/ci-workflow.test.mjs', 'tests/tooling/opening-e2e-environment.test.mjs')
Invoke-NodeCheck -NodeArgs @('node_modules/vitest/vitest.mjs', 'run', '--project', 'unit', 'apps/worker/src/parsers')
Invoke-NodeCheck -NodeArgs @('node_modules/vitest/vitest.mjs', 'run', '--project', 'integration', 'tests/integration/opening-tutor-turn.test.ts')
Invoke-NodeCheck -NodeArgs @('node_modules/vitest/vitest.mjs', 'run', '--project', 'integration', 'tests/integration/opening-fixture.test.ts', 'tests/integration/opening-parse-job.test.ts', '--sequence.shuffle', '--sequence.seed=20260927')
```

parser 的干净 Python 安装、模型准备和真实 PDF/PPTX 执行沿用 `services/parser/README.md`；显式使用本次 resolver 得到的 Python，不猜机器路径。以上是定向回归；完整 integration/handler 和 Opening 浏览器子集分别运行如下。Opening 子集不代表默认配置下的全仓 browser 套件，后者仍须在现有 CI 中独立执行：

```powershell
$ErrorActionPreference = 'Stop'
Invoke-NodeCheck -NodeArgs @('node_modules/vitest/vitest.mjs', 'run', '--project', 'unit', '--project', 'contract')
Invoke-NodeCheck -NodeArgs @('node_modules/vitest/vitest.mjs', 'run', '--project', 'integration')
Invoke-NodeCheck -NodeArgs @('node_modules/vitest/vitest.mjs', 'run', '--project', 'handler')
Invoke-NodeCheck -NodeArgs @('node_modules/playwright/cli.js', 'test', '--config=playwright.opening.config.mts')
```

完整构建与 Linux CI 继续使用仓库现有脚本，不重写包装器；手工命令仍由 pwsh 发起。记录脚本既有子进程依赖以及未运行的 Redis spike，不能把本地 Windows 结果替代 Linux。通过与跳过需分别计数。

### V1：审核、幂等和恢复

```powershell
$ErrorActionPreference = 'Stop'
Invoke-NodeCheck -NodeArgs @('node_modules/vitest/vitest.mjs', 'run', '--project', 'unit', 'packages/contracts/src/opening/candidate-review.test.ts', 'apps/web/src/features/opening/planning/today-read.test.ts', 'apps/web/src/features/opening/planning/today-service.test.ts')
Invoke-NodeCheck -NodeArgs @('node_modules/vitest/vitest.mjs', 'run', '--project', 'integration', 'tests/integration/opening-retest-task-bridge.test.ts')
Invoke-NodeCheck -NodeArgs @('node_modules/vitest/vitest.mjs', 'run', '--project', 'handler', 'tests/integration/handler/opening-retest-accept.test.ts', 'tests/integration/handler/opening-memory-candidate.test.ts', 'tests/integration/handler/opening-today-read.test.ts')
Invoke-NodeCheck -NodeArgs @('node_modules/playwright/cli.js', 'test', '--config=playwright.opening.config.mts', 'tests/e2e/opening-review.spec.ts')
```

candidate-review.test.ts 与 opening-review.spec.ts 为 S1 新增；助理 task 的接受/并发用例在现有桥接测试中按来源分组，实际检验三种来源，不只 retest。

### V2：身份、版本与资格

```powershell
$ErrorActionPreference = 'Stop'
Invoke-NodeCheck -NodeArgs @('node_modules/vitest/vitest.mjs', 'run', '--project', 'unit', 'packages/domain/src/opening/evidence-eligibility.test.ts', 'packages/domain/src/opening/assistance.test.ts', 'apps/web/src/features/opening/learning/observation-service.test.ts', 'apps/web/src/features/opening/learning/read-service.test.ts', 'apps/worker/src/jobs/retest-candidate.test.ts')
Invoke-NodeCheck -NodeArgs @('node_modules/vitest/vitest.mjs', 'run', '--project', 'integration', 'tests/integration/opening-learning-attempts.test.ts')
Invoke-NodeCheck -NodeArgs @('node_modules/vitest/vitest.mjs', 'run', '--project', 'handler', 'tests/integration/handler/opening-observations.test.ts')
```

其中 evidence-eligibility、opening-learning-attempts 为新增文件。若 Worker 现有测试未覆盖新资格，扩展同名测试，而不是另建未接入 Vitest 的目录。

### V3：追加纠错

```powershell
$ErrorActionPreference = 'Stop'
Invoke-NodeCheck -NodeArgs @('node_modules/vitest/vitest.mjs', 'run', '--project', 'unit', 'apps/web/src/features/opening/learning/observation-service.test.ts', 'packages/domain/src/opening/learning-summary.test.ts')
Invoke-NodeCheck -NodeArgs @('node_modules/vitest/vitest.mjs', 'run', '--project', 'integration', 'tests/integration/opening-observation-revisions.test.ts')
Invoke-NodeCheck -NodeArgs @('node_modules/vitest/vitest.mjs', 'run', '--project', 'handler', 'tests/integration/handler/opening-observations.test.ts')
```

opening-observation-revisions.test.ts 为 S3 新增。该组记录真实两连接的交错点和最终行数，不把原函数的受控模拟当数据库并发证明。

### V4：补测与任务状态

```powershell
$ErrorActionPreference = 'Stop'
Invoke-NodeCheck -NodeArgs @('node_modules/vitest/vitest.mjs', 'run', '--project', 'unit', 'packages/domain/src/opening/retest-policy.test.ts', 'packages/domain/src/opening/retest-activity.test.ts', 'apps/worker/src/jobs/remind.test.ts')
Invoke-NodeCheck -NodeArgs @('node_modules/vitest/vitest.mjs', 'run', '--project', 'integration', 'tests/integration/opening-retest-lifecycle.test.ts', 'tests/integration/opening-retest-task-bridge.test.ts', 'tests/integration/opening-reminders.test.ts')
```

retest-activity.test.ts 与 opening-retest-lifecycle.test.ts 为新增。除成功路径外，故意在观察保存后、活动更新前抛错，证明同库事务不会留下半完成状态。

### V5：设置、隐私与归档

```powershell
$ErrorActionPreference = 'Stop'
Invoke-NodeCheck -NodeArgs @('node_modules/vitest/vitest.mjs', 'run', '--project', 'unit', 'packages/domain/src/opening/learning-preferences.test.ts', 'apps/web/src/features/opening/tutor/ephemeral-service.test.ts', 'apps/web/src/features/opening/tutor/ephemeral-abort.test.ts')
Invoke-NodeCheck -NodeArgs @('node_modules/vitest/vitest.mjs', 'run', '--project', 'integration', 'tests/integration/opening-learning-preferences.test.ts', 'tests/integration/opening-tutor-history.test.ts', 'tests/integration/opening-tutor-turn.test.ts')
```

learning-preferences 两个文件为新增。保留原有隐私写回竞态用例；验收检查实际传给测试 Provider 的 context/messages，不只检查 DB 删除标记。浏览器存储检查不得打印真实敏感正文。

### V6：完整摘要与稳定翻页

```powershell
$ErrorActionPreference = 'Stop'
Invoke-NodeCheck -NodeArgs @('node_modules/vitest/vitest.mjs', 'run', '--project', 'unit', 'packages/domain/src/opening/learning-summary.test.ts', 'apps/web/src/features/opening/learning/read-service.test.ts')
Invoke-NodeCheck -NodeArgs @('node_modules/vitest/vitest.mjs', 'run', '--project', 'integration', 'tests/integration/opening-learning-summary-pagination.test.ts')
```

pagination 文件为新增；合成负载与并发子组也放在该测试职责中，耗时实验用显式运行选项，不能让默认回归依赖十万条样本。测量报告标注设备、数据规模、查询计划、扫描行、峰值内存、响应字节与冷热耗时；在目标环境实测前不设置任意数字阈值。

### V7：三入口、移动端与日程

```powershell
$ErrorActionPreference = 'Stop'
Invoke-NodeCheck -NodeArgs @('node_modules/vitest/vitest.mjs', 'run', '--project', 'unit', 'packages/domain/src/opening/day-planner.test.ts', 'packages/domain/src/opening/planning-time.test.ts', 'apps/web/src/features/opening/planning/plan-input.test.ts')
Invoke-NodeCheck -NodeArgs @('node_modules/playwright/cli.js', 'test', '--config=playwright.opening.config.mts', 'tests/e2e/opening-learning-continuity.spec.ts', 'tests/e2e/opening-workflow.spec.ts')
```

opening-learning-continuity.spec.ts 为 S7 新增。真实笔记/探索能力如果正式 Opening 入口尚未接通，应以最小路由和真实服务接入完成 D04，不通过 legacy mock 掩盖缺口。真机清单至少记录系统/浏览器、输入键盘、页码/引用、长公式、焦点、网络中断恢复。

### V8：每片恢复兼容与最终演练

```powershell
$ErrorActionPreference = 'Stop'
Invoke-NodeCheck -NodeArgs @('node_modules/vitest/vitest.mjs', 'run', '--project', 'unit', 'apps/worker/src/runtime/budgeted-call.test.ts', 'packages/domain/src/opening/backup-privacy.test.ts', 'packages/domain/src/opening/backup-apply-plan.test.ts', 'packages/database/src/storage/opening-backup-manifest.test.ts')
Invoke-NodeCheck -NodeArgs @('node_modules/vitest/vitest.mjs', 'run', '--project', 'integration', 'tests/integration/opening-backup-records-repository.test.ts', 'tests/integration/opening-backup-records-snapshot-repository.test.ts', 'tests/integration/opening-backup-compose-repository.test.ts', 'tests/integration/native-backup-roundtrip.test.ts')
```

扩展上述实际集成文件覆盖新 schema 的完整往返，不仅测试 JSON serialization。S1–S7 中改变持久字段的切片执行涉及它的子集；S8 再演练新机器/空环境中的正式导入、解密、原件访问和终态行为。恢复目标记录包括备份时刻、恢复时刻、最后可恢复事实、缺失事实/对象、实测耗时及剩余限制。

实际学习收益记录单独包含：任务要求、参考与核对方法、帮助/曝光、可比性、预定延迟、参加/未参加原因、额外复习、后续使用任务、管理时间。分析开关、保留期和目标由使用者选择；本计划不虚构提升率。

## 5. 共有检查、读回与完成证据

每片在相关行为测试后运行涉及包的 TypeScript 和 lint。以下命令覆盖本计划主要代码包；实际没改的包不用每片重复全跑。原全套 CI 在正式交付时执行。

```powershell
$ErrorActionPreference = 'Stop'
$configs = @('packages/contracts/tsconfig.json', 'packages/domain/tsconfig.json', 'packages/database/tsconfig.json', 'apps/worker/tsconfig.json', 'apps/web/tsconfig.json', 'tsconfig.e2e.json')
foreach ($config in $configs) {
    Invoke-NodeCheck -NodeArgs @('node_modules/typescript/bin/tsc', '-p', $config, '--noEmit')
}
Invoke-NodeCheck -NodeArgs @('node_modules/eslint/bin/eslint.js', 'packages/contracts/src/opening', 'packages/domain/src/opening', 'packages/database/src/repositories', 'apps/web/src/features/opening', 'apps/worker/src/jobs')
Invoke-NodeCheck -NodeArgs @('scripts/validate-opening-plan.mjs')
```

新增/更改的 settings、preferences、exploration 与测试文件在定向 lint 列表中追加其精确路径。结构检查只验证计划文件/任务依赖，不替代产品行为。每个连贯实施切片结束后运行一次 `graphify update .`；产物不提交，SQL 未进入图时直接核对迁移，不增加安装步骤。

当前文档任务的完成检查仅包括：文件读回、链接与路径、43 项账本映射、场景覆盖、无占位内容、文档差异及既有计划结构测试。本文列出的 application/DB/browser 命令是将来的实施验收，不能计成本次已经通过。
