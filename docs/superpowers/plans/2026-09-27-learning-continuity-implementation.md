# AIstudy 学习连续性与证据可信度新版项目计划

> **For agentic workers:** 实施时使用 writing-plans 对应的 executing-plans 工作流逐切片执行。本文不启动代码实现、子 Agent、提交、推送或部署；这些行为以当次用户授权为准。

**Goal:** 在现有 AIstudy 内先让用户操作可靠成立，再让学习记录可解释、可纠正、可恢复，最后用真实使用判断后续功能的投入顺序。

**Architecture:** 保留 Next.js Web＋独立 Worker＋PostgreSQL 的模块化单体，以及现有 Redis、对象存储、身份与权限边界。contracts 定义边界，domain 处理纯规则，服务层编排，database 管理查询与事务；AI 可生成答案、解释和候选，正式业务状态由应用服务验证后改变。

**Tech Stack:** 沿用当前锁定依赖，不在本计划升级框架或引入新基础设施；Node.js 20+、TypeScript、React 18 兼容语法、PostgreSQL、Vitest、Playwright、现有 Python 解析器。手工命令使用 PowerShell 7。

**日期与状态：**2026-09-27；这是待实施计划，不是完成报告。S0–S8 是本文切片索引，不是第二份任务账本。

**2026-09-28 阶段交接更新：**S2/S3 的服务端与消费者主体已接入 V2，课程练习、资格/版本说明、知识库材料与笔记编辑器入口已连到现有工作区路由。B 已报告本轮负责的 UI 22/22、局部 lint 与差异检查通过，S3 history head 修复保留；这只是本地窄范围结果，不代表全仓、浏览器或真实使用通过。A 的两项 near 测试、唯一的 web 类型检查及当前代码复审仍待完成，B 的课程/材料/编辑器收尾也仍处于交付核对中。原验收复选框和任务账本不在本记录中提前勾选。

## Global Constraints

- 唯一任务账本仍是 [opening-release/tasks.json](opening-release/tasks.json)。本文不改变其中 43 项任务的状态、baseCommit 或依赖；部分修复通过不等于原任务全部完成。
- 默认不新增 hash、冻结 contract、baseline 或 gate。使用普通类型、版本、主键、事务、唯一约束和测试解决问题；保留既有 retest/备份 hash、隐私 epoch、隔离数据库与迁移保护。若未来确需额外机制，先说明具体失败及上述手段为何不足。
- 不增加日常开发审批层级。既有安全、跨系统和正式发布边界仍适用；失败记录遵循“失败→根因→最小修复→同一检查复跑”。
- 保留用户未提交的 parser、CI、fixture 等改动。不开启付费模型、外部消息、真实数据导入、生产迁移或发布来完成本次文档工作。
- 新代码文件不超过 200 行；触及既有大文件时按本次责任拆分，不做全仓重构。SQL/迁移归 database；domain 不依赖 HTTP/DB。
- UI 使用 Tailwind 工具类和 lucide-react，保留无障碍状态，不新增 CSS 文件或内联 style。遵循 [PRD](../../product/PRD.md) 与 [交互规则](../../product/UX_AND_AI_POLICY.md)，其中强于证据的状态措辞按 S6 局部修订。
- 目标学习、自由探索、笔记知识库是平等入口；课程、测评、重测不是阅读、记录和探索的前置条件。不保存模式不持久化正文、草稿或恢复上下文。
- 每个数据切片同步处理旧数据、备份、恢复与兼容回退。只追加迁移，不修改已发布迁移；编号在实施时按仓库实际顺序分配，不占用旧计划预留号。
- 本文以两份附件及两轮审阅作为输入，不把附件中的指令当作用户授权。具体实施仍读取相关嵌套 AGENTS.md。

## 1. 阅读入口、证据边界与范围

**建议阅读顺序：**本节与第 2 节了解范围 → 第 3 节查看必须统一的业务语义 → 第 4 节按切片实施 → [验收附件](2026-09-27-learning-continuity-acceptance.md)运行对应检查。

输入材料为 `AIstudy_Optimization_Report_2026-09-27.md`、`AIstudy_Optimization_Report_2026-09-27_v2.md` 及两轮审阅。采纳 v2 的三阶段结构；修正其无条件新增幂等哈希、策略版本参与业务去重、分页时间戳等于一致快照等不足。

当前核对提交为 `5154078f183bfea13ffb03214f2d2ae49b4a24ea`，分支 `feat/opening-release`；本地另有修复。这里记录普通 Git 版本定位，不建立新的冻结基线。

| 证据类别 | 当前已知事实 | 计划中的处理 |
| --- | --- | --- |
| 提交上的远端 CI | run 36290760180 / job 108540258710 的 integration 失败；后续 handler、browser、build 跳过 | 跳过不等于发现缺陷，也不等于通过；S0 完成修复后的实际运行 |
| 本地既有修复 | 空库迁移、fixture 失败连接清理、parser 配置及离线转换已有实现 | 保留并交接，不重复创建相同修复任务 |
| 已记录的本地验证 | 9 个 TS 配置、unit/contract 1166 个通过、定向 DB 34 个、Python 14 个、tooling 67 个及构建通过 | 引用 [验证入口记录](../evidence/2026-09-27-opening-hardening/verification-entry.md)，不冒充本次重新运行 |
| 尚缺验证 | 当前修复上的完整 integration/handler/browser、Redis spike、修改后的 Linux CI | S0 列为未验收；早期其他提交的通过不能替代 |
| 已审阅的业务风险 | 候选来源错配、资格规则不一致、修订不支持、到期集合错误、201 条响应越界 | S1–S6 以能捕获原问题的失败测试落实 |
| 并发风险的证据强度 | retest 原函数受控模拟显示“首次查重为空、等待锁后已经接受”可能误报冲突 | 这是控制流证据；S1 补真实 PostgreSQL 双连接交错测试 |
| 额外静态发现 | `scripts/opening-e2e/environment.mjs` 仍写 Windows `Scripts/python.exe` | S0 核对隔离 E2E 入口与 parser 新配置是否一致，不先声称已复现 Linux E2E 失败 |

本计划补充 [开学版总计划](2026-09-12-opening-release-implementation.md)，在本轮修复的顺序和业务语义上以本文为准。C01–C03、V01、K01–K02、P04、U04、Q04 的既有能力承诺保留；它们不进入本轮近期实施序列，不据此宣布取消或完成。尤其 L02 的证据改进不能替代依赖 K01 的 K02 验收。

本轮不实现 FSRS/BKT、自动掌握率、永久误解画像、复杂知识图谱、通用 Agent 编排、多人协同或完整离线同步。恢复卡与真实规则先于更多自动化。

## 2. 三阶段与任务映射

| 阶段 / 切片 | 用户可见交付 | 原任务映射 / 负责领域 | 本文依赖 |
| --- | --- | --- | --- |
| 一 / S0 | 当前修复能在实际服务及 Linux CI 验证 | B02、F03、RP5；Q01–Q03 的验证贡献 / INTEGRATOR、PIPELINE、QA | 现有本地修复 |
| 一 / S1 | 能继续原工作，三类建议能正确审核和重试 | RP3、RP6、U03、P02、M01、L02 / EXPERIENCE、DATA | S0 |
| 二 / S2 | 尝试、版本与帮助范围明确，共用资格判定 | L01、L02、RP4 / DATA、EXPERIENCE、AI | S1 |
| 二 / S3 | 观察可纠正和撤销，历史不双计 | L01–L03 / DATA、EXPERIENCE | S2 |
| 二 / S4 | 补测、通用任务和提醒状态一致 | L02、P02、P03 / DATA、PIPELINE、EXPERIENCE | S2、S3；沿用 S1 接受链 |
| 二 / S5 | 关闭评价、归档和隐私操作有明确效果 | M02、M03、RP1、RP2、U03 / DATA、AI、EXPERIENCE | S1、S4 |
| 二 / S6 | 有界摘要、可翻阅历史和不过度推断的成长展示 | L02、L03、U03 / DATA、EXPERIENCE | S2–S5 |
| 三 / S7 | 无课程阅读/笔记和现实日程都能顺畅使用 | U02、U03、P02、RP6 / EXPERIENCE、DATA | S1、S5、S6 |
| 三 / S8 | 干净环境恢复、真实课程与自由探索的使用证据 | 先 Q03，再 Q01、Q02 / INTEGRATOR、QA | S0–S7 |

本文依赖是切片的集成顺序，不重写账本依赖。可先修复某条已存在的 P02 路径，但 P02 整体状态仍受 L01 等原依赖约束；Q01 的定向测试可提早写，整体验收仍在 Q03 后、Q02 前。M01/M02 等已有实现先核对现存测试与隐私保障，不按“planned”误判为完全未实现。

没有虚构人员容量或日历工期。每个切片完成最小纵向闭环后再安排下一片；发现前片缺陷就修复该片，不并入无关功能。阶段一未验收时可准备后续规格和失败用例，但不把业务扩张包装成已交付。

## 3. 各切片共同遵守的业务语义

### 3.1 候选身份与命令重放

审核对象使用明确联合类型，不根据 UUID 或界面文案猜来源：

```ts
type CandidateRef =
  | { origin: 'assistant'; kind: 'task' | 'memory'; id: string }
  | { origin: 'retest'; kind: 'retest'; id: string };
type ReviewResult = {
  disposition: 'applied' | 'replayed' | 'already_processed';
  resultRef: { kind: 'task' | 'memory' | 'retest'; id: string } | null;
};
```

这是拟新增契约。助理任务走 `POST /api/opening/tasks`；记忆走已有 memory-decision；补测走已有 retest accept。审核页面是普通产品页面，链接不直接打开写操作 API。所有命令重新验证 workspace、owner、对象类型、来源准入及输入；UI 禁用按钮不承担幂等责任。

事务顺序：先鉴权和当前访问/隐私准入 → 按作用域、命令、clientKey 查已完成操作并比较规范化意图 → 首次执行才检查当前状态/expectedVersion → 写产物、决定与重放结果。同 key 原请求在成功响应丢失后重试，不因旧 expectedVersion 被拒绝。

首次查重为空时，在获得对象锁后重新查重；跨对象同 key 由唯一约束协调，唯一冲突需结束失败事务后在新事务中读取原操作并比较。比较包括 origin、kind、id、操作、原 expectedVersion 及有业务意义的字段；不新增通用哈希要求。保留已有 retest 哈希并验证兼容。重放返回当前仍有权访问的结果引用，不借历史响应复活已删除正文。

### 3.2 学习事实、共同资格与版本

事实至少区分 course/scope、skill/requirement、problem/item version、attempt、观察发生时间、服务端记录时间、判断来源、帮助及内容版本。缺题目或版本的普通记录仍可保存，资格为 unknown，不补成当前版本或客观正确。

拟新增 `evaluateEvidenceEligibility(observation, context)`，输出 `independentAttempt`、`verifiedCorrect`、`usableForCurrentVersion`、`usableForDelayedCheck`，每项为 `yes | no | unknown`，另有统一 `reasonCodes` 和 `policyVersion`。观察写入、摘要、补测 Worker 使用同一 domain 实现；客户端无权声明这些派生结果。

帮助绑定 attempt/problem；session 只作容器。提交前可取回的帮助与提交后反馈分开；已看过同题答案的事实不因创建新 attempt 消失。`delivered` 指助手结果已持久化并可由客户端取回，不证明人已阅读；缺少关联或无法判定先后时保留 unknown，不增加阅读监控。历史熟悉度与本次是否受帮助也分开。

`reference_checked` 本身只是判断来源：还需有可追溯参考、核对方法/范围和检查者，不能等同系统客观判分。开放题可保留人工核对与限制；模型建议不能直接变为 verifiedCorrect。

版本适用性为 `exact | equivalent_confirmed | changed_needs_check | version_unknown | unavailable | privacy_excluded`。等价映射必须有明确确认记录与适用范围；材料改版不抹掉旧学习事实，也不自动证明旧结论适用于新版。skillLabel 同名不跨课程自动合并；首轮用课程内稳定身份和 requirementKey，不依赖新知识图谱。

### 3.3 补测与任务：一个权威活动状态

业务补测活动独立于运送作业。状态为 `proposed | accepted | in_progress | completed | declined | cancelled | invalidated | superseded`；结果 `correct | incorrect | unverified` 和测量资格另存，做完不代表答对或延迟检验合格。

| 操作 / 场景 | 权威效果 |
| --- | --- |
| 接受候选 | 一个活动关联一个正式 task；任务 pending，建议时间不转硬截止 |
| 正常提交观察 | 同一 PostgreSQL 事务保存有效观察、更新活动与 task；答错也可 completed |
| 通用任务页直接 done | 活动 completed、结果 unverified；不制造观察 |
| 完成后补交答案 | 增加或关联学习证据，保持 completed；不重开提醒 |
| 通用任务 skipped | 已接受活动 cancelled，reason 为 user_skipped；不等于 snooze |
| 推迟 | 活动保持 accepted/in_progress，更新 snoozedUntil；推迟期间不提醒 |
| 取消与答案并发 | 按活动版本/锁确定状态胜者；取消先提交时仍可保存合法学习观察，但不把 cancelled 改为 completed |
| 重开已完成事项 | 创建显式新活动/证据周期，关联前项；不复活旧测量 |
| 修订学习依据 | 已完成活动保留终态，测量可改为需复核；未开始候选失效，已接受任务显示依据变化供用户处理 |

`notBeforeAt` 是协议允许的最早测量时刻；`recommendedAt` 是建议；`scheduledStartAt` 是用户确认安排；`deadlineAt` 仅为真实明确截止。UTC 时点与 IANA 时区、本地日期意图同时保留。没有延迟协议就不声称延迟保持合格。

到期集合只读 accepted/in_progress，按用户安排优先、否则推荐时间判断，并遵守 snoozedUntil、当前设置和归档状态；未排时间与终态不算到期。2026-09-01 的观察按旧两天启发式得出 2026-09-03，2026-09-27 重算不能悄悄变成当天硬截止。

业务去重使用 scope＋course/skill＋requirement＋purpose＋evidenceCycleId。policyVersion 是解释元数据，不进入“自动产生新周期”的条件；算法升级/Worker 重试不重新生成已拒绝或仍活跃的建议。新可比证据、要求变更或用户明确再次尝试才启动新周期，用普通事务/唯一约束防并发重复。

### 3.4 一致历史、隐私与恢复

历史分页以有效观察根为单位，`occurredAt DESC, rootObservationId DESC` 排序；纠错不移动根的位置，真实新练习才有新发生时间。`recordedAt` 与 occurredAt 分开，补录不能混入此前翻页快照。

采用 workspace/owner 作用域内的普通事务 revision 计数行：写事实/修订时，在既有 session/course/root/activity/task 锁之前锁定独立计数行，仅实际新增事实时递增并将 revision 存入观察行；事务回滚不推进。保留既有 course historyRevision 兼容消费方，但它不能单独重建跨课程迁入/迁出的完整修订链。首屏在短一致读事务只读已提交水位，不插入或锁定计数行；随后游标携带此 revision 和根排序边界，先从完整修订链选择水位以内有效头，再过滤课程/要求和当前隐私。不用 `nextval()`、客户端时间或单独 snapshotAsOf 日期推断提交先后，不保持跨 HTTP 长事务。这是普通数据版本与事务，不是新的冻结基线、哈希或门禁。

所有观察/修订写入口必须使用同一版本规则；旧已提交数据在迁移时纳入明确起始 revision，身份/正确性未知仍未知。来源适用性与当前权限在读取时重新检查；隐私删除立即屏蔽事实正文、摘要和引用，优先于历史快照。“无遗漏”只针对该快照内仍有权读取的记录。返回计数说明所对应的 revision 与当前可见性。

备份复用当前 manifest、完整性检查和恢复拓扑。新尝试、修订、决定、补测活动及历史引用版本必须随所属切片支持导出→干净恢复；不等 S8 才补字段。恢复业务状态，不回放运输 jobs/outbox、外部模型或提醒。旧备份先叠加可用的最新删除记录；删除水位或密钥不可得时隔离检查，不承诺完整恢复。

## 4. 可执行切片

以下“新增”为计划文件，“修改”为现有位置。文件过大时按列出的责任拆分。每片运行 [验收附件](2026-09-27-learning-continuity-acceptance.md)对应命令组；记录到原任务 evidence 入口，不创建另一个状态系统。

### S0：完成已有运行修复的验证交接

**修改/核对：**`scripts/opening-test-db.mjs`、`tests/integration/opening-fixture.ts`、`apps/worker/src/parsers/parser-config.ts`、`apps/worker/src/parsers/parser-preflight.ts`、`services/parser/requirements-lock.txt`、`.github/workflows/ci.yml`、`docs/operations/ci.md`、`scripts/opening-e2e/environment.mjs`。沿用 [隔离验收环境](2026-09-24-opening-isolated-acceptance.md)。

**输入/输出：**输入是当前本地差异和已有修复日志；输出是绑定实际代码版本、服务环境和 CI run 的验证记录，不新增测试框架。

- [ ] 先读取差异与验证入口记录，列出此次实际执行和引用历史执行的边界；不得重做已完成的 parser/fixture 修复。
- [ ] 运行验收附件 V0：空隔离库单文件、乱序集成、fixture 初始化失败连接清理；保留所有数据库保护。
- [ ] 检查 Worker、解析集成、隔离 E2E 是否使用同一平台配置语义；对仍硬编码的入口先补 Windows/Linux 配置失败用例，再按现有 resolver 最小修复。
- [ ] 完成真实 Node→Python→对象存储→数据库→页码引用链与失败清理，再跑完整 integration/handler/browser 和 build；服务不可用就如实记录，不能用 mock 替代服务可用性。
- [ ] 在获准的提交/推送流程中运行包含修复的 Linux CI，记录未跳过的实际结果和 run 链接；本计划本身不提交或触发发布。

**完成与回退：**完整验证边界可读，未运行项不记通过；仅撤回本片启动/配置修复，不改生产 schema。解析环境不可用时保留原件并显示失败，不能标 ready。

### S1：正确审核、可靠重试与继续入口

**修改：**`apps/web/src/features/opening/planning/today-read.ts`、`today-service.ts`、`today-view.tsx`（均在同目录）、`apps/web/src/app/(opening)/opening/today/page.tsx`、`apps/web/src/app/api/opening/tasks/route.ts`、已有 memory-decision/retest accept 路由、`packages/database/src/repositories/opening-retest-task.ts`、`opening-memory-candidate.ts`、`opening-candidates.ts`。

**新增：**`packages/contracts/src/opening/candidate-review.ts` 与 `packages/contracts/src/opening/candidate-review.test.ts`；`apps/web/src/features/opening/planning/review-service.ts`、`review-view.tsx`；`apps/web/src/app/(opening)/opening/review/page.tsx`；`tests/e2e/opening-review.spec.ts`。

**接口：**第 3.1 节 CandidateRef/ReviewResult；`TodayResumeState` 改为独立页面状态和可同时存在的 continueItem/pendingReviews，沿用旧消费者适配，不用互斥 confirm 状态遮住继续动作。

- [ ] 先在 today-read、today-service 及真实 handler 测试重现错源路由；新增 V1 的三类候选行为，不再把 API 地址字符串当产品完成证据。
- [ ] 从实际来源组装审核列表；显示可读名称、来源、用户可修改项和决定后产物。任务接受补齐 owner/type 校验；继承记忆路径已有隐私和重放能力。
- [ ] 助理候选决定在其现有持久记录扩展 clientKey、规范化意图和 resultRef；必要唯一索引随本片迁移。补测路径保留旧 hash，通过锁后复查及唯一冲突回读解决竞态，不建立通用候选平台。
- [ ] 用真实 PostgreSQL 双连接和同步屏障验证顺序重试、同 key 并发、不同 key 并发、同 key 不同目标/载荷、提交成功但响应丢失；断言正式对象数及返回引用，不用 sleep 制造概率竞态。
- [ ] 普通建议与恢复入口并列；错误、未登录、无数据分别展示。刷新和跨端恢复沿用 RP3 的逻辑请求身份，不保存模式不创建恢复正文。
- [ ] 新决定字段同步进入现有备份选择列与往返测试；旧客户端不得绕过新 owner/type 验证。

**完成与回退：**A01–A08 及 E01–E02 成立；恢复审核 UI 时仍保留服务器验证/已处理状态，禁用出错动作优于回退到错源 API。

### S2：尝试身份、内容快照与共同资格

**2026-09-28 进展：**S2 两条实现支线已完成本批集成，状态为“待用户浏览器验收”。A 接通服务端 attempt 身份、题目/来源版本快照、观察提交、真实帮助送达及事务内 historyRevision；B 将同一资格函数接入读取、摘要、补测 Worker 与课程练习页面。自报正确不自动升级为核验正确，缺失历史身份/版本保留 unknown；同题再次练习创建新 attempt 并保留帮助历史。新增迁移为 `0028_opening_learning_attempts.sql`，已应用于隔离测试库及独立本地开发库；独立开发库当前随 S3 交付准备应用至 `0029`，不等同生产迁移。

**本批并行分工：**A 负责事实写入、共享契约/导出、迁移及备份；B 负责消费者、课程展示及对应测试。两条实现使用 gpt-6-astra / high，独立审查使用 gpt-6-sol / ultra；共享数据库检查串行执行。本批不启动依赖 S2 的 S3–S7 完整切片。

**非浏览器检查与审查：**沿用纯资格函数 61 项已通过单测；最新备份领域单测 14/14、真实 MinIO/隔离 PostgreSQL 备份恢复集成 14/14、消费者集成 8/8、attempt handler 5/5、旧 observations handler 1/1。contracts/domain/database/web/worker 常规类型检查、本轮 11 个测试入口额外严格类型检查及局部 ESLint 通过；上述检查范围有交叠，不累计为全仓通过数。跨课程 attempt/session 绑定、同名 requirement 隔离、练习会话恢复/隐私选择和 reference-only 历史记录的隐私过滤均经修复及窄复核。额外编译旧 `tests/integration/opening-tutor-turn.test.ts` 仍有 27 个既有严格类型诊断，例如约 72 行 provider kind 推断及 101 行 SQL 数组索引；对应原文已与 HEAD 比对，本批未扩展清理，不宣称全仓严格编译通过。

**备份修复与证据边界：**当前版本缺失的反例暴露历史缺失降级规则被误用于当前对象；修复为当前 `(sourceId, version)` 缺失返回 OBJECT_MISMATCH 并清理暂存，历史缺失仍标 unavailable。路径属于 A、对象 sourceId 写成 B 的新增反例先失败，补回身份一致性判断后同组 14 项领域测试通过；两项最小修复均已独立窄复核。集成检查读取真实 MinIO 的 v1/v2 对象及 404，写入真实磁盘归档，并在隔离 PostgreSQL 内按既有 apply plan 清表重建，核对学习事实及各版本原件字节；这不是产品级恢复执行器或生产恢复演练。

**用户检验与回退：**页面入口为 `/learn/courses/<courseId>`；需要已登录且拥有课程、开发库应用 0028，材料练习需材料解析就绪，辅导需 Worker/模型配置可用。依次开始练习、提交自报结果、查看资格/原因、再次练习同题，并使用当前课程的 hint/explain 辅导；预期自报结果不被冒充客观核验，历史帮助不因新 attempt 消失。页面交互、视觉和真实使用仍待用户检验。回退关闭新入口/评价展示，保留 schema、已保存事实及版本引用，不 DROP 0028 的事实表或伪造旧记录资格。本批未提交、推送、部署或执行生产迁移。

**修改：**`packages/contracts/src/opening/learning.ts`、`packages/domain/src/opening/assistance.ts`、`packages/database/src/repositories/opening-learning.ts`、`apps/web/src/features/opening/learning/observation-service.ts`、`read-service.ts`、`apps/worker/src/jobs/tutor-turn.ts`、`retest-candidate.ts`。

**新增：**`packages/contracts/src/opening/learning-attempts.ts`；`packages/domain/src/opening/evidence-eligibility.ts` 与 `.test.ts`；`packages/database/src/repositories/opening-learning-attempts.ts`；`tests/integration/opening-learning-attempts.test.ts`。

**接口/数据：**服务端分配 attemptId，关联 problemId/item version、requirementKey、开始/提交时刻和 source version 引用。追加 `opening_learning_attempts` 表；观察保存当时身份/版本快照，帮助增加 attempt 关联；第 3.4 节 historyRevision 在本片建立。纯函数返回第 3.2 节资格，不替换原始判断事实。

- [ ] V2 先覆盖无 problemId、版本未知、两题同 session、同题重新 attempt、提交前后帮助、不同判分来源。
- [ ] 迁移只回填可证明的身份和版本；不能从当前可变 problemRef 推断历史版本，无法证明的保留 null/unknown 并说明原因。
- [ ] 帮助写回与观察提交明确服务器时间及同一尝试的事务顺序；对于并发送达且先后无法证明的情况返回 unknown，客户端声明 independent 不覆盖已知曝光。
- [ ] 用相同 fixture 验证写入、read-service、Worker 的资格及 reasonCodes 完全一致；共享版本上下文来自 repository，UI 不另写规则。
- [ ] 修改 `packages/database/src/repositories/opening-backup-sources.ts` 及显式表/列导出查询，将尝试、版本引用、帮助关联、historyRevision 与被引用历史源版本纳入同一备份。沿用现有 versioned finalKey 和完整性计算，旧版原件不能套用当前版本的 sha/bytes；验证引用到的历史对象实际可取回。原已丢失的历史原件标为 unavailable，不伪造已完整恢复；新增事实启用前完成 B01–B05、B08–B09 和最小干净恢复。

**完成与回退：**记录保存与资格评价可独立成功；旧记录不被错误升级。回退只能关闭新评价展示，保留事实及兼容读取，不能恢复会伪造历史版本的写入。

### S3：追加式纠错与有效观察

**2026-09-28 进展：**追加纠正、撤回、有效头、跨课程归属、重放与并发锁序、修订链隐私及备份恢复已接通；迁移为 `0029_opening_observation_revisions.sql`，已用于隔离测试库和独立本地开发库。49 个不同的定向数据库/handler 场景通过（并非一次全仓测试），相关单元、包类型与本轮测试入口严格编译通过。独立审查发现的等值核验误清、旧补测依据污染和隐私写回竞态已修复并复核；“提交后得到帮助再纠正答案”的独立资格反例已修复，原尝试时间与 delayed 资格不因纠正获得新信用。UI 历史折叠的旧 head 显示问题已交界面线修复；按用户最新要求，界面继续迁入指定 V2 紧凑工作台，不把旧外观作为最终交付。浏览器与实际使用仍待用户验收。回退只能关闭纠错入口并保留 0029、完整修订链及有效头读取；不 DROP 历史，也不回退到全版本双计摘要。

**修改：**`packages/contracts/src/opening/learning.ts`、`apps/web/src/features/opening/learning/observation-service.ts`、`packages/database/src/repositories/opening-learning.ts`、`apps/web/src/app/api/opening/observations/route.ts`。

**新增：**`packages/database/src/repositories/opening-observation-revisions.ts`；`tests/integration/opening-observation-revisions.test.ts`。

**接口/数据：**`reviseObservation({ rootObservationId, revisesObservationId, revisionKind: 'replace' | 'retract', reason, clientKey, expectedHead, replacement? })`；actor 来自服务端身份。root 行持有有效头，修订行保留旧内容、当时版本与 historyRevision；撤销产生 tombstone，不删除历史来伪装纠正。

- [ ] V3 先证明当前拒绝修订的行为不满足需求；同时写重放、越权、同 root 并发和过期 expectedHead 用例。
- [ ] 在同一事务按现有隐私锁顺序、historyRevision 行、root 行的固定顺序更新；锁后重新确认重放，然后检查 expectedHead，追加修订并更新有效头。
- [ ] 修正答案/归属属于同一根；真正的新练习新增观察根；不同 requirement 不合并。撤销后摘要不计该根，审计历史仍可查且服从隐私删除。
- [ ] 重算受影响技能/要求和候选依据；已经完成的补测保持终态，待开始建议重新判断适用性，不用旧的 every() 永久保留已被纠正的错误。
- [ ] 修订链、有效头、操作重放和历史源版本同时完成备份往返；验证恢复后同 key 重试仍不重复修订。

**完成与回退：**B06–B07、E01/E02 通过；每根最多一个有效版本。关闭纠错入口可回退，不能启用忽略修订链的旧摘要或丢弃修订历史。

### S4：补测业务状态、周期与任务联动

**修改：**`packages/domain/src/opening/retest-policy.ts`、`packages/contracts/src/opening/planning.ts`、`packages/database/src/repositories/opening-retests.ts`、`opening-retest-task.ts`、`opening-plans.ts`、`opening-reminders.ts`、`apps/web/src/features/opening/learning/retest-service.ts`、`apps/worker/src/jobs/retest-candidate.ts`、`remind.ts`。

**新增：**`packages/contracts/src/opening/retest-activity.ts`；`packages/domain/src/opening/retest-activity.ts` 与 `.test.ts`；`packages/database/src/repositories/opening-retest-activities.ts`；`tests/integration/opening-retest-lifecycle.test.ts`。

**接口/数据：**新增 `opening_retest_activities` 保存第 3.3 节业务字段、taskId、候选来源、cycleId、版本与决定。`transitionRetest(activity, command, context)` 为纯状态规则；repository 同事务写观察/活动/task。现有 job 仅承担运输与执行，使用活动引用；迁移提供旧 jobId→activityId 的稳定映射和旧接受路由兼容。

- [ ] V4 先覆盖未来接受项误到期、终态重复提醒、任务 done 无观察、skipped/snooze、取消/提交竞态及 policy 升级重复候选。
- [ ] 迁移旧 payload 中可证明的候选、接受结果、taskId 与时间；task done 但无观察时 completed/unverified，不推断正确；无法协调的关联标记待核对而非再次入队。
- [ ] 按第 3.3 节落实四类时间、状态和新周期条件；生成端与接受端均通过唯一约束/事务保证最多一个当前业务对象。
- [ ] 通用任务写入口通过同一个应用服务协调活动；同库写入不另加 outbox。外部提醒继续复用现有作业能力并在发送前重读权威状态。
- [ ] 当前 `listAcceptedSkillLabels` 类读取不得继续充当到期集合；来源/要求更新显示依据变化，任务硬截止仍由用户或明确来源确认。
- [ ] 将业务活动与终态加入备份清单，保留必要旧 job 业务映射但不恢复运输 job；验证恢复后已完成/拒绝项不重建或重发。

**完成与回退：**C01–C05、E03–E04 通过，提醒从业务状态推导。可停止自动生成/提醒并保留任务；不回退到把所有 accepted 都当 due 的读取。

### S5：评价开关、资产操作与运行中作业

**2026-09-29 材料传递来源切片：**本片技术实现与非浏览器检查完成，实际助手流程仍待用户检验；完整 S5 的复选框与任务账本不提前提升。追加 `0033_opening_context_provenance.sql`，以 nullable `context_source_refs` 保存实际送入模型的材料、入选历史和有效记忆的来源及版本；NULL 表示未知，[] 表示已知无材料来源。候选继承完整来源，删除记忆记录继承材料的排除；旧未知 assistant 及其派生记忆停止进入模型和备份，不清除用户可读原文。发送前复用预算调用的 beforeSend 检查 epoch，完成回合继续使用既有事务 CAS。

**检查与审查：**真实 PostgreSQL 反例先复现 T1(A)→无选材/无引用 T2→记忆 M→排除 A 后 M 仍进入上下文，再最小修复转绿。A 单元 29/29；最近 10 个数据库文件首轮 55/56，既有 S2 竞态 fixture 补齐课程和 turn/session 绑定后，原失败文件 2/2。B 单元 92 项分组通过；备份新套件最终 13/13、既有 records/json/snapshot/compose 四文件 32/32，包含真实 MinIO 与加密归档写读。Sol 独立审查发现的 UUID 大小写二次过滤导致学习事实丢失问题已用三个真实数据库断言复现、修复并窄复查通过。追加 memory/review handler 18/18、task-acceptance handler 6/6；其中注册 403 来自测试误用发布模式，改回测试环境 OPENING_RELEASE=0，未改变认证；补测 fixture 仅在目标 scope 显式 opt-in。database/domain/worker/web 相关类型检查、新增及修改测试入口严格编译、局部 lint 与 diff 检查通过。Worker 的 npm Bash 包装不可用，使用直接 tsc；不声称完整 npm gate 或全仓验证通过。

**备份、限制与回退：**导出保留完整来源及同源多版本，当前排除事实在导出和恢复预检重新生效；仅从新字段引用的历史版本也进入清单，缺失元数据仍标 unknown。上述检查覆盖归档写读、恢复结构校验与 apply plan，不是产品恢复执行器或干净数据库恢复。真实 Provider、Worker 运行效果及浏览器尚未验收；本片不覆盖纯对话删除 journal、预览/恢复卡的隐私展示、资产四类操作、主动保存临时片段和设置/课程状态的完整备份恢复。回退必须保留 0033 字段、NULL 隔离与当前排除事实；必要时暂停保存回合的模型作业，不 DROP 字段、不将 NULL 回填为 []。未执行 commit、push、merge、部署或生产迁移。

**2026-09-30 课程操作与状态备份切片：**本片技术完成，待用户浏览器检验；完整 S5、原验收复选框和 43 项任务账本不提前提升。本轮由两条 `gpt-6-astra / high` 支线实施，`gpt-6-sol / ultra` 独立审查，`gpt-6-sol / high` 补组合检查；这是实际派单参数，不推断底层模型部署。

- **A／课程操作：**`course-membership.ts`、auth 课程服务、courses GET/PATCH 路由及 `features/courses` 控件/客户端/模型。课程列表可切换进行中/已归档，详情可设置跟随账号或进一步关闭、归档/恢复、移出单课程关系。账号总关闭优先，保留原件、其他课程关系、观察和已接受任务；复用 0032 启用时间触发器，不倾倒旧建议。新增 `tests/integration/course-lifecycle.test.ts` 及两个 client/model 单测。
- **B／状态备份：**Opening 导出/compose/预检/apply plan 纳入 `workspace_preferences`、`courses` 及实际已导出 source 的 `course_asset_memberships`。新 `opening-backup-course-records.ts` 保留启用时间微秒；新 `backup-learning-state.ts` 校验导入关系和当前关闭/归档/启用水位。旧格式缺表时不写这些状态，内含课程满足依赖，外部课程仍需目标身份核对。当前状态必须由 owner-scoped 数据库读取；相冲突的旧状态由既有恢复预检拒绝，不静默改写归档。

**实际检查与修复链：**A 的新增课程 integration 首轮 4 失败/1 通过，补归档写入、归档列表和课程限制投影后原命令 5/5；既有 unlink 首轮即通过。课程近 unit 4 文件 13/13。B 状态 unit 首轮 18/25 失败后转绿；新增数据库状态测试有效 RED 3/3 后转绿。旧 records/json/snapshot/compose 组因新增三表与旧固定清单预期不符为 30/32，保留原 22 表断言并精确更新新表预期后原命令 32/32；history 真实归档往返 5/5。仅修正不合法的测试上传状态和被现有跨工作区 trigger 拒绝的夹具，没有绕过保护。

独立审查确认并修复三项实质问题：课程设置重读失败保留旧 effective；账号 NULL（未明确选择、实际关闭）可能被旧备份开启；Date 毫秒截断可能放行微秒级启用水位倒退。第一项修后 client/model 6/6、web tsc/lint；NULL 场景实际 RED 3/30→GREEN 30/30。微秒场景 domain RED 2/35→GREEN 35/35，真实 PostgreSQL RED 1/4→GREEN 4/4，实测 `.155133Z` 原先截为 `.155Z`，现归档写读保留六位精度并拒绝 1 微秒倒退。B 最终近 unit 6 文件 65/65；最终 domain/database 类型检查、修改文件 lint/diff check 通过。Sol 对三项修复均作增量复查，其余指定范围未发现确定实质缺陷。

本轮主要命令（PowerShell 7；隔离集成使用 `OPENING_TEST_DB=1`、`OPENING_RELEASE=0`、`NODE_ENV=test` 和 `127.0.0.1:15432/aistudy_opening_test`）：

```text
node node_modules/vitest/vitest.mjs run --project integration tests/integration/course-lifecycle.test.ts
npx vitest run --project unit packages/domain/src/opening/backup-learning-state.test.ts packages/domain/src/opening/backup-apply-plan.test.ts packages/domain/src/opening/backup-policy.test.ts packages/domain/src/opening/backup-compose.test.ts packages/database/src/repositories/opening-backup-records.test.ts packages/database/src/repositories/opening-backup-records-lineage.test.ts
node node_modules/vitest/vitest.mjs run --project integration tests/integration/opening-learning-state-backup.test.ts
node node_modules/vitest/vitest.mjs run --project integration tests/integration/opening-learning-history-backup.test.ts
node node_modules/vitest/vitest.mjs run --project integration tests/integration/opening-backup-records-repository.test.ts tests/integration/opening-backup-records-json-repository.test.ts tests/integration/opening-backup-records-snapshot-repository.test.ts tests/integration/opening-backup-compose-repository.test.ts
node node_modules/vitest/vitest.mjs run --project unit apps/worker/src/jobs/remind.test.ts apps/worker/src/jobs/retest-candidate.test.ts
node node_modules/vitest/vitest.mjs run --project integration tests/integration/opening-learning-preferences-consumers.test.ts tests/integration/opening-learning-consumers.test.ts tests/integration/opening-reminders.test.ts tests/integration/opening-retest-lifecycle.test.ts --no-file-parallelism --maxWorkers=1
node node_modules/typescript/bin/tsc --noEmit -p apps/web/tsconfig.json
npx tsc -p packages/domain/tsconfig.json --noEmit
npx tsc -p packages/database/tsconfig.json --noEmit
```

最后两组消费者检查用于补 S4/S5 重叠路径的证据缺口，分别为 Worker 25/25 和数据库 46/46；其余未变化的既有有效结果复用。类型检查使用直接 tsc，不冒充 npm Bash 包装门禁；生产包 tsconfig 排除测试文件，没有声称全部 integration 入口经过独立严格类型编译。未运行浏览器、全仓检查或构建。

本片结束已运行一次 `graphify update .`，退出码 0，更新为 14,591 节点、32,865 边、665 社区，生成物未暂存。限制：缺少 SQL parser，34 个 SQL 文件未索引；8 个 JSON/config 文件未提取节点；社区划分变化导致部分旧标签待刷新，未调用 LLM 重新标注。

**用户检验与边界：**仅启动隔离 Next dev，保留 `aistudy_opening_e2e` 既有数据；`http://127.0.0.1:3100/login`、`/register`、`/opening/courses` 已 HTTP 200，未登录 `/api/courses` 为 401，HTTP 结果不等于浏览器通过。登录测试账号后，准备课程及同一材料的两门课程关系，检查课程限制保存/刷新、归档后可从已归档列表找回、恢复仍保留记录，以及移出一门课程不删除原件/另一门关系。设置重读错误应清空旧生效状态、禁用保存并可重试。待用户浏览器验收。

Opening 本片只覆盖 source 关系，不含 document/block/card 正文与关系，也没有完整恢复执行器或干净环境恢复演练；未来执行器仍须在事务中重查当前状态/删除记录，恢复期间不派发外部任务。真实 Provider、Worker 运行效果和实际恢复后的提醒行为未验收。资产永久删除/停止供模型使用的完整操作闭环、临时片段主动保存及其他 S5 要求继续待办，不进入 S6 扩张。未新增迁移、未运行生产迁移，未执行 commit、push、merge 或部署；回退保留已有设置/归档/隐私事实及恢复保护，不删除字段或回退启用水位。

**2026-09-30（Asia/Shanghai）材料操作与关联片段：技术完成，待用户浏览器验收。**本条是该切片的最新交接，不提升完整 S5、验收复选框或原账本（仍为 15 verified / 28 planned）。用户明确选择：主动保存的临时对话片段保留来源关联，原材料的隐私限制继续约束笔记。两条 `gpt-6-astra / high` 支线实现，`gpt-6-sol / ultra` 独立审查及窄复查，`gpt-6-sol / high` 核对组合差异；均为实际派单配置。公共导出由 A 单一写入，数据库检查按短窗口串行执行。

- **A／材料操作：**`opening-source-actions.ts`、`opening-source-actions-privacy.ts`、sources/privacy/course-membership 仓储、`source-service.ts`、impact/actions/deletions 路由与 inbox 材料控件；`0034_opening_source_actions.sql`。确认前展示全部课程引用（包括归档课程）；停止供模型使用保留原件和关系；删除移除全部关系并限制可追溯回答/记忆/关联笔记的正文读取。对象清理回执独立于 source 行，可刷新后重试；实际协调 upload copy、parse、attach 与删除，保留当前/历史对象及签名上传链接租期的清理信息。删除事实是 `asset_deleted_at`，不是待清理数组。Opening 备份携带删除事实，不携带 object keys 或上传租期，旧包不得削弱当前永久删除。
- **B／关联片段：**`opening-ephemeral-provenance.ts`、`opening-note-provenance.ts`、`native-note-privacy.ts`、library/native backup 仓储、tutor/snippet 契约与服务、snippets 路由、assistant 消息模型和保存对话框；`0035_opening_note_provenance.sql`。临时回执只存身份与来源版本，不存正文、prompt 或回复。预览/编辑/取消只在页面状态中；确认时仅保存选定/编辑的片段。来源来自服务端回执，修改笔记不解除关联。AI 排除后仍可本人阅读已有笔记，但新保存/导出/恢复不能绕过排除；永久删除来源后限制正文、历史修订、搜索和修订提案。原生备份保持关联并重新检查目标工作区当前隐私事实。

**检查与失败修复：**材料动作初始 5 项因方法缺失失败；实现后扩展至真实 PostgreSQL/MinIO 与 copy/parse/attach 竞态 12/12。过程中修正测试的非公开导入和阻塞 PID 预期，使用真实锁队列而非 sleep。既有来源隐私/写回/Worker/备份回归 23/23、源动作 handler 4/4；材料和备份最近单元共 93 项通过（分组重叠不重复累加）。真实 MinIO 完成合成 staging/current/historical 对象 PUT→存在→删除→不存在，未清空桶。

B 的既有 AI 输入严格校验最初不接受 provenanceId，扩展该边界并保留角色/大小/未知字段限制后服务端/契约/AI 单元 32/32；原生隐私/领域单元 7/7、UI 五文件 79/79。note/snippet/native/library 组合最终 27/27；先前失败分别涉及 append-only 修订夹具清理、原生包携带无法恢复的 Opening source 关系，以及跨工作区测试提前撞 ID 冲突。修正隔离夹具与不支持的关系导出，保留约束；跨工作区用新文档/块/修订 ID 和 reject 策略证明来源拒绝且零写入。ephemeral handler 子套件 15/15，覆盖五类结果、20 表正文标记/数量扫描、console 与恢复卡；它所在的早期联跑命令因 note 反例整体失败，不把该整条命令记为通过。note 后由上述成功组合及本次审查修复回归覆盖，未重复未变化的 ephemeral 检查。

**独立审查发现两项并已修复/复查：**

1. 按 ID 读取/审核/冲突解决修订提案会绕过关联笔记的删除限制。`revision-proposals.ts` 现在在同一事务先锁 workspace，再复用 `openingNoteReadable`；覆盖 create/list/get/review/resolve、所有快照与 terminal replay。真实同命令 RED 7 失败/16 通过→GREEN 23/23，包括四种状态和 get/review/resolve 的 pg_locks 确定性交错，断言提案/文档/blocks/revisions 无写入；既有 proposal handler 4/4。保留 AI-only 排除时的本人阅读与操作、普通软删的终态重放。新增测试入口严格 TS 曾有一个 Promise 联合推断错误，改为 `track<unknown>` 后 0 diagnostics，不改变测试行为。
2. 确认输入固定 max(1000) 与合法课程引用数量不一致，1001 引用的 exclude/delete 固定 400。`sources.ts` 仅移除该无业务依据的上限，保留每项 UUID、strict、版本、授权与服务端集合重查。新增 `source-actions.test.ts` 实际 RED 2/3→新契约 3 项与既有 client 4 项共 7/7；第 1001 个非法 UUID 仍拒绝。删除确认文案同步明确关联片段笔记及修订正文受影响。

Sol 实际读取最终差异、新增测试与必要调用链，确认两项修复无新增可触发实质缺陷。截至本片各检查对应的代码版本，database/AI/contracts/domain/web 类型检查、所属改动文件 lint/diff 通过；新增/改动测试入口另作严格编译。之后并行修改的组合验证边界见下文，不用旧结果替新代码背书。未运行全仓 test/build/CI 或浏览器。以下为主要实际命令；B 通过 `buildOpeningE2eEnvironment()` 构造环境并覆盖到 `aistudy_opening_test`、`OPENING_TEST_DB=1`、`OPENING_RELEASE=0`、`NODE_ENV=test` 后以 spawnSync 运行列出的 Node 子进程参数，未对预览库运行这些测试：

```powershell
$ErrorActionPreference = 'Stop'
& '.local/opening-e2e/check-service-tests.ps1' --project integration tests/integration/opening-source-actions.test.ts tests/integration/opening-source-actions-race.test.ts --maxWorkers 1 --no-file-parallelism
& '.local/opening-e2e/check-service-tests.ps1' --project handler tests/integration/handler/opening-source-actions.test.ts --maxWorkers 1 --no-file-parallelism
& '.local/opening-e2e/check-service-tests.ps1' --project integration tests/integration/opening-tutor-privacy-input.test.ts tests/integration/opening-tutor-provenance.test.ts tests/integration/opening-privacy-writeback-race.test.ts tests/integration/opening-worker-privacy-race.test.ts tests/integration/opening-context-provenance-backup.test.ts --maxWorkers 1 --no-file-parallelism
node node_modules/vitest/vitest.mjs run --project unit packages/contracts/src/opening/source-actions.test.ts apps/web/src/features/opening/inbox/source-actions-client.test.ts
# B 实际 Node 子进程命令；须在上述隔离环境中执行。
node node_modules/vitest/vitest.mjs run --project integration tests/integration/opening-note-provenance.test.ts tests/integration/revision-proposal-repository.test.ts
node node_modules/vitest/vitest.mjs run --project handler tests/integration/handler/revision-proposals.test.ts
node node_modules/vitest/vitest.mjs run --project integration --project handler tests/integration/opening-note-provenance.test.ts tests/integration/handler/opening-snippets.test.ts tests/integration/native-backup-roundtrip.test.ts tests/integration/library-repository.test.ts
node node_modules/typescript/bin/tsc -p packages/database/tsconfig.json --noEmit
node node_modules/typescript/bin/tsc --noEmit -p apps/web/tsconfig.json
node node_modules/eslint/bin/eslint.js packages/database/src/repositories/revision-proposals.ts tests/integration/opening-note-provenance.test.ts
```

**环境、用户检验与回退：**0034/0035 已在隔离测试库及本地预览库 `aistudy_opening_e2e` 经既有迁移器验证，预览迁移前后均为 36 users / 2 courses，没有重置数据或生产迁移。已有真实 PostgreSQL SELECT、Redis PONG 和 MinIO 健康/对象操作证据；本片最后 `/login`、`/opening/library?tab=materials`、`/opening/library?tab=notes`、`/opening/assistant` 在 `http://127.0.0.1:3100` 均 HTTP 200，仅代表服务可达。早前一次 Next dev 渲染出现 JSON EOF，后续入口读取已成功，未据此进行无依据的业务修复。模型端口 18081 最后实测未监听，真实模型流程 BLOCKED；没有启动 mock 来冒充实际模型验收。

用户登录已有本地账号，准备同一材料在两门课程的关系（其中一门归档），在材料页检查影响列表、停止供模型使用保留原件、删除的跨课程效果及清理回执/重试。模型环境准备好后，在助理“不保存本轮”中完成两轮，选早期消息片段，验证预览/编辑/取消不生成笔记、确认只保存片段并能打开；之后对原材料做 AI 排除/删除，核对本人阅读与正文限制的区别。已有修订提案在来源永久删除后读取/审核/冲突解决应不可用且不产生新修订。交互、视觉、响应式、真机及真实效果均待用户浏览器验收。

原生包仍不含 Opening 原件；本轮不是全平台恢复执行器或干净环境恢复演练。已下载、外部、在途副本不属于对象清理保证。回退必须保留 0034 删除事实/待清理回执和 0035 来源关联，不能去掉正文读取/导出/恢复限制；已删除对象字节不能靠代码回退恢复。不得修改已应用迁移的正文/checksum（0034 首条历史注释不代表当前删除语义）。本轮团队未执行 commit/push/merge/deploy；期间观察到分支 HEAD 由外部推进至 `dc5f176`，已按新基线保留内容。package/lockfile/CI/唯一任务账本未改，暂存区为空。

本片最后仅运行一次 `graphify update .`，退出码 0：代码图为 14,819 节点、33,600 边、718 社区，生成物未暂存。限制：37 个 SQL 文件因缺少 tree_sitter_sql 未索引，8 个 JSON/config 文件未提取节点；社区变化后部分标签按 hub 命名，未调用 LLM 刷新标签或为文档重新提取语义。

**收尾时的并行任务边界：**发现同工作区的用户任务“优化模型路由与课程学习体验”正在修改 ephemeral/runtime/预算调用/公共导出、Today 界面，并新增 `0036_opening_ai_settings.sql`。这些不是本片改动，本片的已通过结果不等于它们的组合验证通过。已向该任务传达文件所有权、0034/0035 不可修改、测试库窗口已释放，以及新路由稳定后需覆盖 ephemeral/snippets 交叠回归；0036 的验证与预览应用由该任务负责，本片未声称已验证。Today 后续支线先协调其正在写入的 UI 文件；无材料记忆备份支线与之独立。模型与原生恢复的外部限制仍保留。

**2026-09-30（Asia/Shanghai）记忆删除备份与 Today 恢复提示：审查/修复。**A/B 实现及静态独立审查已完成；数据库检查与下述两处跨任务接入尚未完成，不记为技术完成，不提升完整 S5、验收复选框或原账本（仍为 15 verified / 28 planned）。本轮复用 A/B `gpt-6-astra / high`、独立审查 `gpt-6-sol / ultra`、集成交付核对 `gpt-6-sol / high`，按唯一文件所有权执行；未新增迁移、未改 0034–0036 或公共导出。

- **A／无材料记忆删除事实：**database 的 `opening-backup-records/sources/compose/current/prepare.ts`、新增 `opening-backup-memory-deletions.ts`，以及 domain 的 `backup-policy/validation/compose/apply-plan.ts` 和近测试。复用既有 `status='deleted'` memory 行投影仅含 ID/时间的 owner-scoped `memoryDeletions`，不读取正文，不新增 journal 表。DB 快照必带事实，归档字段可选以兼容旧包；含 memory 正文或新 metadata 的预检必须接入真实当前工作区事实，不能缺省为空。归档与当前删除事实叠加，并检查 compose/current/apply 边界漂移。新导出原本就过滤 deleted memory 正文，本次不是修复新导出泄露；没有生产恢复执行器，也未声称已复现实际恢复后的复活。公共记忆删除、原对话正文与 deleteSourceText 语义未变。
- **B／Today 恢复事实：**`today-service.ts/.test.ts`、`today-read.ts/.test.ts`、`today-resume-view.tsx`、`handler/opening-today-read.test.ts`。核对 owner、精确材料版本、上传/解析状态、版本可用性、永久删除及 chunk/page；失效选材不计为可恢复，位置不能恢复时清除派生页码，保留对话、用户原文和候选计数。AI-only 排除材料以 `manualSourceCount` 表示仍可本人手工阅读，不计为自动恢复。没有写回历史 turn。

**实际检查与修复链：**A 的新记忆用例 RED 12 失败/1 通过，compose/current 边界另 4 失败；贯通事实后最终 14 个近 unit 文件 185/185。domain/database 包 typecheck、26 个改动/新增文件分两组定向 lint/diff 通过。B 初始 RED 15 失败/9 通过→24/24；自动/手工分离后新增表达 RED 3 失败/34 通过→37/37；6 文件 lint、严格测试/import TS 与 diff 通过。B 的旧 SQL mock 无参 tuple 曾产生 2 个严格 TS 诊断，补 mock 签名后为 0。负责人另跑 web tsc，exit 0；四个受影响 backup integration 入口严格编译发现 `opening-learning-history-backup.test.ts:87` 的已知 fixture 表可能 undefined，原实现者仅补非空断言，重跑同四入口严格 TS 为 0 diagnostics、单文件 lint/diff 通过。该严格编译不等于运行 integration。

Sol 实际读取稳定 diff、未跟踪测试及必要调用链，核对墓碑→owner 快照→compose→预检/apply-plan、Today→实际恢复选择/页码校验，未发现本轮新增的可确认实质缺陷。Sol 集成核对未发现下述两处之外的确定静态接口遗漏；没有重复已有效的测试。主要实际命令（均在 pwsh 中以 `$ErrorActionPreference = 'Stop'` 开始）：

```text
node node_modules/vitest/vitest.mjs run --project unit packages/domain/src/opening/backup-memory-deletion.test.ts packages/domain/src/opening/backup-privacy.test.ts packages/domain/src/opening/backup-apply-plan.test.ts packages/domain/src/opening/backup-compose.test.ts packages/domain/src/opening/backup-context-provenance.test.ts packages/domain/src/opening/backup-learning-state.test.ts packages/domain/src/opening/backup-policy.test.ts packages/domain/src/opening/backup-source-deletion.test.ts packages/domain/src/opening/backup-learning-history.test.ts packages/database/src/repositories/opening-backup-compose.test.ts packages/database/src/repositories/opening-backup-current.test.ts packages/database/src/repositories/opening-backup-sources.test.ts packages/database/src/repositories/opening-backup-prepare.test.ts packages/database/src/repositories/opening-backup-prepare-failure.test.ts
node node_modules/vitest/vitest.mjs run --project unit apps/web/src/features/opening/planning/today-service.test.ts apps/web/src/features/opening/planning/today-read.test.ts
npm run typecheck -w @aistudy/domain
npm run typecheck -w @aistudy/database
node node_modules/typescript/bin/tsc --noEmit -p apps/web/tsconfig.json
```

严格 backup 测试编译使用 tsconfig.base.json 和四个 roots：`opening-memory-deletion-backup.test.ts`、`opening-context-provenance-backup.test.ts`、`opening-backup-compose-repository.test.ts`、`opening-learning-history-backup.test.ts`；TypeScript Program 设 noEmit、incremental:false、composite:false、jsx:ReactJSX。

**尚未完成：**隔离测试库 `127.0.0.1:15432/aistudy_opening_test` 仍由并行用户任务“优化模型路由与课程学习体验”持有，尚未明确释放；本团队未抢用、清库或另起服务。Today handler 的 11 项及 A 的 memory-deletion/privacy/context-provenance/compose/learning-history integration 尚未运行，不宣称通过。窗口移交后按既有隔离环境串行执行最近套件，保留 `aistudy_opening_e2e` 预览数据。

两个跨任务文件已交其唯一 owner 补齐，本团队未越权写入：① `TodayDashboard` 正常态走 `today-overview.tsx` 的 `TodayLearningContext`，尚需消费 manualSourceCount 并将自动材料数写为“可恢复 N 份”；`TodayResumeBody` 的新文案不代表正常页面已显示。② `opening-learning-state-backup.test.ts` 的 archive(snapshot) 已带 memoryDeletions，但 validate/apply 调用尚需传真实当前 snapshot.memoryDeletions，不能从旧 archive 取或补空数组；其 ai_settings 往返检查由模型路由任务负责。上述两处完成后只补必要受影响检查，再完成本片最终交接与一次 Graphify 更新。

**用户检验与后续：**待正常态接入完成，在 `/opening/today` 用已有材料、阅读位置和已保存对话检查恢复卡；在材料页对测试材料 AI 排除或永久删除，再回 Today，预期自动可恢复数量/页码准确、手工阅读提示准确且原对话仍可打开。页面交互、视觉/响应式、真实模型和实际恢复演练均未验证，继续待用户检验；本轮没有运行浏览器、全仓检查、生产迁移、commit/push/merge/deploy。无需数据库迁移回滚；代码回退不得去掉当前删除事实叠加保护或伪装旧调用已安全兼容。只读定位另确认 S5 仍缺“归档后对已接受补测事项显式请求单项提醒”的入口；现有批量提醒继续受归档/设置/启用水位限制。该项作为下一最小切片，不因此将完整 S5 记为完成，也不复制新的 backlog。

**2026-09-30（Asia/Shanghai，本轮增量交接）记忆删除备份与 Today 恢复提示：技术完成，待用户浏览器验收。**本条更新上一条尚未完成项；不提升完整 S5、原账本或用户验收状态。原备份/服务差异已由 Sol 独立审查；随后补齐的 Today 正常态 UI/client 差异也已由 `gpt-6-sol / ultra` 实际只读审查，未发现本轮新增的确定实质缺陷。

- **真实隔离数据库检查：**负责人串行执行 memory-deletion/privacy/context-provenance/compose/learning-history 五个 integration 文件，35/35；随后 `opening-learning-state-backup.test.ts` 6/6，exit 0（11:12:25 开始，6.91 秒）。后者仅修正六处预检/apply 的当前 `memoryDeletions` 接线，保留并行模型任务的 AI 设置往返、拒绝密钥及微秒启用水位用例。结果仅覆盖这些实际路径，不代替尚未新增的 AI 设置 schema 反例或恢复执行器。
- **Today handler：**实际首次 9 通过/2 失败；失败一为 assistant `context_source_refs=NULL` 代表未知来源，应隔离而非计入候选；夹具先验证 0，再显式写 `[]` 验证精确 1。失败二为版本字符串被数据库约束提前拒绝，改用可持久化但超出材料 int 范围的 `2147483648` 并断言读回，再验证不可恢复。生产读取与约束未削弱。原命令复查 11/11、exit 0。
- **正常态接入：**`today-overview.tsx/.test.ts` 已消费 `manualSourceCount`，将自动材料标为“可恢复 N 份材料”。RED 3 失败/5 通过→8/8；与单提醒 UI/client 组合四文件 81/81。API 表驱动数组展开触发严格 TS 失败后改对象行并断言 ZodError，单独 35/35；web tsc、五测试入口严格 TS 0 diagnostics、changed-file lint/diff 通过。后续并行模型任务明确复用本接入，不重复写入。

本次实际数据库命令均通过已检查的 `.local/opening-e2e/check-service-tests.ps1`，只指向 `127.0.0.1:15432/aistudy_opening_test` 且 `OPENING_TEST_DB=1`：

```text
& '.local/opening-e2e/check-service-tests.ps1' --project integration tests/integration/opening-memory-deletion-backup.test.ts tests/integration/opening-privacy.test.ts tests/integration/opening-context-provenance-backup.test.ts tests/integration/opening-backup-compose-repository.test.ts tests/integration/opening-learning-history-backup.test.ts --maxWorkers 1 --no-file-parallelism
& '.local/opening-e2e/check-service-tests.ps1' --project handler tests/integration/handler/opening-today-read.test.ts --maxWorkers 1 --no-file-parallelism
& '.local/opening-e2e/check-service-tests.ps1' --project integration tests/integration/opening-learning-state-backup.test.ts --maxWorkers 1 --no-file-parallelism
```

**环境与协调：**原角色句柄曾为 interrupted/notLoaded，负责人据实际状态取得短 DB 窗口；随后模型/课程任务恢复，已按新状态更正并在 6/6 进程退出后明确归还窗口。PostgreSQL 原有 pgdata 完整，初次服务启动遇崩溃恢复尚未就绪，读取日志确认恢复结束后 `pg_isready` 与既有 `services.ps1 start` 成功；未 initdb、reset、seed 或替换数据。Redis 16379、MinIO 19000 就绪，预览数据核对为 36 users / 2 courses。11:10 并行任务确认旧 Next 已无进程，使用既有环境单独启动 `next dev` 3100（不使用会 prepare/reset 的 server.mjs），`/api/health`=200、未认证 `/api/opening/ai-settings`=401；没有启动 Worker、模型 fixture 或真实供应商调用。HTTP 仅证明服务可达。三包 database/worker/web 的并行任务实际直接 tsc 分别在 11:14:01–11:14:11、11:14:11–11:14:22、11:14:22–11:14:28 完成，均 exit 0；后续受代码变化影响的包仍须补必要检查。

**用户检验：**登录已有本地预览账号，在 `/opening/today` 准备已保存对话、阅读位置及材料；AI 排除与永久删除后分别检查手工阅读提示、自动可恢复材料数/页码与原对话。记忆旧包恢复只完成预检/计划的真实 DB 边界检查，未完成生产恢复执行器或干净环境演练；真实模型、交互、视觉/响应式与设备效果均未验证。Graphify 的本片最终增量更新尚待当前提醒差异稳定后统一执行；没有 Git 或发布动作。

**正在推进的 S5 单项提醒：实现中／稳定 UI 已审查。**A (`gpt-6-astra / high`) 独占 contracts/planning、task version mapper、reminder repository/service/route、Worker remind/dispatch 及其近测试；B 的 TaskContext/client 提醒 UI 已冻结，Sol (`gpt-6-sol / ultra`) 已实际审查，无确定缺陷。单项请求携带 taskId/expectedVersion，只授权本次任务/版本/到期；不重开课程或账号自动开关，界面固定 in_app 且明确不发送外部推送。发现原仓储只写 job 未产出 worker 所需 outbox，正在同事务补既有 outbox；仅 remind 使用既有 outbox ID 区分合法恢复投递并维持同事件重派去重。静默期 queued 的后续投递也在补真实连通检查。receipt/unknown/failed 不得隐式重发；实时配置/任务状态/owner/隐私 epoch 保护保留。新后端与完整 DB/Redis 运输链路仍待验证和独立审查，不宣称提醒端到端完成，实际飞书 transport 未接通。

**2026-09-30（Asia/Shanghai，15:10 后交接）S5 单项到期提醒：技术完成，待用户浏览器验收。**本条更新上面的“实现中”状态，不提升完整计划、原账本（15 verified / 28 planned）或用户验收状态。两条 Astra/high 实现与 Sol/ultra 独立审查按文件所有权并行；模型角色曾返回上游拒绝，未计作执行，恢复后仍使用原模型配置。期间原模型/课程任务已完成自己冻结范围的交接，未把其改动当成本团队新产物。

- **行为与范围：**contracts 的 `planning.ts/planning-tasks.ts` 及近测试定义兼容的单项 `{ clientKey, channel?, taskId, expectedVersion }`；database 的 `opening-reminders/plans/retest-task` 保留真实版本、owner、到期与状态检查、隐私 epoch、事务锁和幂等。单项动作不重开账号/课程自动开关，也不恢复课程归档。web `reminder-service`、TaskContext 的 `task-reminder` 与 client API 提供明确 pending/冲突/未知结果；UI 固定 in_app，明确不发送外部推送。worker `remind/dispatch` 和 `index.ts` 的一行实时配置接线完成内部投递，保留其他 owner 的模型/计费差异。
- **真实连通：**新建与已知 suppressed 恢复同事务产生既有 outbox。仅 remind 使用 outbox 主键区分运输事件，同一事件重派不重复执行，新一次合法恢复不会撞上保留的旧 Redis completed ID。静默期通过绝对 `availableAt` 重排，dispatcher 停机后只等剩余时间；全天静默按既有定义次日复查。记录 CAS 失败不产生事件。receipt、unknown、failed 不隐式重发。
- **缺陷与复查：**原链路只写 job 不写 outbox，初始运输 RED 3 项，修后真实 DB/Redis 覆盖。旧 queued 行没有任何 outbox 的升级场景另得 unit 2 项及真实 Redis 1 项失败；在原 job 锁和事务内仅为显式、未发送 queued 行补一次事件，复查通过。Sol 独立发现 JSONB 的 `enabled: "false"` 被 Boolean 转成 true、非法静默分钟可能允许外发；readConfig 在持久化边界严格检查 boolean、recipient 与 0..1439 整数分钟，非法配置禁用。JSONB RED 为 unit 9 项/delivery 7 项失败，其中一个 JSON null 夹具误写 SQL NULL 提前撞 NOT NULL，改为 JSON 文本的 jsonb 转换；字符串启用值和小数静默值确实触发过发送替身。最终同近命令 unit30/30、真实 repo+delivery20/20。Sol 已定向复查这两项修复及其测试，未发现新确定缺陷。

**实际验证（重叠用例不累加）：**前轮提醒八个 unit 文件65/65，后续新增仓储分支由30/30覆盖；关闭/归档消费者40/40；reminder handler6/6。四个 integration 文件先57/58，唯一失败为旧消费者 fixture 未注入新实时配置依赖，补真实 repository 接线后原命令58/58；最新两文件 repo5+delivery15=20/20（session82609，exit0）覆盖后续修复。真实链路仅最终外部 send 使用测试替身，不宣称供应商通过。database 类型检查、两新增测试入口严格 TS 0 diagnostics、改动 lint/diff通过；此前对应 contracts/worker/web 检查复用，后续 S6 的 contracts/web 又按其实际变更复查。worker 的 npm 包装依赖 Bash，使用直接 tsc 等价编译命令，不冒充运行了 Bash 包装门禁。

```text
& '.local/opening-e2e/check-service-tests.ps1' --project integration tests/integration/opening-reminders.test.ts tests/integration/opening-learning-preferences-consumers.test.ts tests/integration/opening-reminder-delivery.test.ts tests/integration/opening-learning-state-backup.test.ts
& '.local/opening-e2e/check-service-tests.ps1' --project handler tests/integration/handler/opening-reminders.test.ts
& '.local/opening-e2e/check-service-tests.ps1' --project integration tests/integration/opening-reminder-delivery.test.ts tests/integration/opening-reminders.test.ts
node node_modules/vitest/vitest.mjs run --project unit packages/database/src/repositories/opening-reminders.test.ts
node node_modules/typescript/bin/tsc -p apps/worker/tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p packages/database/tsconfig.json --noEmit
```

全局 Vitest 配置本身 maxWorkers=1，integration/handler fileParallelism=false。每个数据库窗口均明确转交且进程退出后释放。中途服务再次停止、15432 ECONNREFUSED 导致0项执行，没有把随附“No test files found”当作文件缺失或通过，也没有盲重试；沿既有 pgdata 恢复，读取 PostgreSQL crash recovery 日志、pg_isready 成功后启动 Redis/MinIO再跑原命令，preview仍36 users/2 courses。先前失效会话19762未记为GREEN。纯 Next dev 预览重新在3100启动，未用 server/prepare/reset/seed，未启动真实 Worker、模型 fixture 或供应商；健康接口200，实际交互仍待用户。

**关联备份与隐私收尾：**领域 `backup-learning-state.ts/.test.ts` 补非null ai_settings 的共享 strict schema，absent/null兼容旧包；新增非法/密钥/额外字段7项真实RED→领域45/45，最新真实 learning-state-backup6/6，Sol窄审无确定缺陷。并行模型任务最新 ai-settings repository4/4、ephemeral handler18/18、snippets handler3/3；snippets曾保留旧断言，错误期待剔除未知历史后的新回复没有receipt。只修夹具：验证旧history没有送provider、新可信refs为[]，再显式构造旧NULL来源receipt，保留unknown409、foreign404及零笔记写入；其Sol已窄审。可编辑片段未新增逐字正文绑定；不声称后端能证明任意编辑文本与receipt逐字相同。

**用户验收：**登录本地预览后进入 `/opening/today`，选中已接受且到期的待办，确认“仅本次到期提醒”；预期只处理所选真实版本，自动开关和归档保持原状，草稿不变；版本冲突、未知结果不显示伪成功或自动重试。UI明确只是应用内提醒。真实 Feishu 适配器仍未接实际 transport，因此外部推送 BLOCKED；没有运行浏览器、真机或真实模型验收。无迁移、commit/push/merge/deploy。

**修改：**`packages/contracts/src/workspace-preferences.ts`、`packages/database/src/repositories/preferences.ts`、`apps/web/src/features/settings/settings-view.tsx`、`apps/web/src/features/opening/sources/source-service.ts`、`apps/web/src/features/opening/tutor/ephemeral-service.ts`、既有隐私准入/写回仓储及 retest/remind Worker。

**新增：**`packages/domain/src/opening/learning-preferences.ts` 与 `.test.ts`；`packages/database/src/repositories/opening-learning-preferences.ts`；`tests/integration/opening-learning-preferences.test.ts`。

**接口/数据：**`resolveLearningPreferences(account, course, archived)` 返回 assessmentEnabled、retestSuggestionsEnabled、automaticRemindersEnabled。设置由当前用户/工作区持有；课程配置只能进一步关闭，不能覆盖账号总关闭。复用 workspace_preferences 并增课程设置，不建全局策略平台。

- [ ] V5 覆盖“排队→关闭→Worker 发布”“接受任务→关闭→提醒作业运行”“归档→恢复归档”三类真实时间交错。
- [ ] 新用户或没有明确历史选择时默认不自动评价/补测；原有显式选择按兼容迁移保留。关闭后允许主动记录和显式手工任务；用户主动请求的一次核对可返回本次结果，但不重启长期自动评价。停止新自动候选、自动评价和相应自动学习提醒；普通手工任务按自身提醒设置处理。已接受任务保留且可完成，不静默取消。
- [ ] Worker 发布候选与提醒发出前读取当前设置/归档；候选发布在同库事务协调设置版本。外部调用在已授权发送后不可保证撤回，保留实际结果。重新开启不倾倒历史积压，由用户显式重算。
- [ ] 分清课程移除关系、课程归档、资产删除、停止供模型使用；删除前展示其他引用影响。归档保留原件/笔记/证据，停止该课程自动活动；已接受事项可由用户单独恢复提醒。
- [ ] 隐私排除覆盖历史对话、记忆和混合来源摘要，保留 RP1/RP2 的 epoch/CAS 保护；provenance 缺失时隔离相关派生内容。知识修订的追加历史不能成为拒绝隐私删除的理由。
- [ ] 验证不保存模式的浏览器存储、服务端会话/草稿、日志与恢复卡均不落正文；用户主动保存片段须走清晰的独立动作。设置及资产状态随备份迁移，并在恢复时叠加最新隐私事实。

**完成与回退：**D04、D06、E06 通过；关闭及归档对在途作业真实生效。回退保持关闭/隐私排除优先，不重启积压自动操作。

### S6：准确摘要、分页快照与成长展示

**2026-09-30 首片：201+ 观察摘要响应修复，技术完成，待用户浏览器验收。**A收尾提醒时，B按不重叠文件实现；Sol/ultra独立只读审查，Sol/high补唯一缺失的真实handler检查。原domain成长语义、用户既有课程UI/模型改动均保留。没有把本片当作完整S6完成。

- **真实RED→修复：**同技能/requirement的201条观察经过真实read-service/client，会在总evidenceIds与recentPerformance.evidenceIds触发Zod max(200)，另复现新增完整计数字段未支持与UI误用代表数组长度。首轮3失败/31通过。新增web-only `summary-response.ts`，在完整summarize之后最多选20个确定代表；ID、资格明细与近期代表对齐，保留至少一个近期代表及相关错误/unknown/不可用说明。状态、完整sampleCount、历史错误与unknown计数保持原值，不从样本重算；超过20才附兼容的recentPerformance.evidenceCount，小摘要保留旧形状。输入不原地修改，domain/Worker仍保留完整201个ID/资格与候选根身份。
- **精确十文件：**web learning的 `read-service.ts/.test.ts`、新增 `summary-response.ts/.test.ts`、`course-view.tsx/.test.ts`；contracts的 `learning.ts/learning-summary.test.ts`；client `learning-client.test.ts`；handler `opening-learning-read.test.ts`。course-view已由原模型/课程任务明确移交，本片仅显示完整近期计数与“代表证据”，保留练习、修订、材料/笔记入口。
- **实际GREEN：**五个unit文件58/58，contracts/web直接tsc均exit0，六个测试入口严格TS为0，十文件定向lint及末次受影响三文件复查、diff通过。Sol实际读取diff/新文件及domain、client、route消费路径，未发现确定缺陷。交付角色在明确DB窗口运行handler，一文件2/2、exit0，5.30秒；包含空/匿名/不存在课程，以及201有效头→纠正后物理202行但有效仍201、unknown不升级的真实DB+HTTP契约检查，随后确认进程退出并归还窗口。

```text
node node_modules/vitest/vitest.mjs run --project unit packages/contracts/src/opening/learning-summary.test.ts apps/web/src/features/opening/learning/read-service.test.ts apps/web/src/features/opening/learning/summary-response.test.ts apps/web/src/features/opening/client/learning-client.test.ts apps/web/src/features/opening/learning/course-view.test.ts
node node_modules/typescript/bin/tsc -p packages/contracts/tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p apps/web/tsconfig.json --noEmit
& '.local/opening-e2e/check-service-tests.ps1' --project handler tests/integration/handler/opening-learning-read.test.ts --maxWorkers 1 --no-file-parallelism
```

**用户检验与剩余范围：**进入 `/opening/courses/<courseId>` 的学习记录。准备同技能/requirement有201条有效观察的测试课程；本轮未向预览库注入该数据。预期页面可读、观察与近期数量完整，展开最多20条代表资格，反例不被升级，练习入口保留。待用户浏览器验收。数据库当前仍全量读有效头并逐项读资格；完整观察列表、分组聚合/资格投影、固定revision分页与规模实测仍未完成，不用响应有界代替它们。

**2026-09-30 第二片：固定版本历史分页，技术完成，待用户浏览器验收。**按用户加速要求，两条主实现与一条备份子任务并行，显式配置均为 `gpt-6-astra / high`；`gpt-6-sol / ultra` 独立审查与剩余数据库检查交叠。新建集成角色时触发并发上限，负责人直接完成唯一缺失的新 handler 检查，Sol 复核沿用实际证据；没有为凑角色重复检查。完整 S6 的资格投影、分组聚合和规模测量仍未完成，账本保持 15 verified / 28 planned，未提升用户确认状态。

- **A／快照与数据库：**新增 `0037_opening_learning_history_snapshot.sql`、contracts `learning-history.ts/.test.ts`、database `opening-learning-history-read.ts` 和 `opening-learning-history-cursor.ts`；窄改 `opening-learning-facts.ts`、`opening-learning-observations.ts`、`opening-observation-revisions.ts` 及必要公共导出。普通 workspace/owner 计数行先于原有学习锁；仅实际新增事实分配正水位，重放/回滚不推进，迁移旧行为0且移除写入默认值。先在完整链按固定R选头，再筛课程/要求及当前整链隐私，返回R内effectiveHeadId；原始根排序保留数据库微秒，隐藏边界仍能续页。游标有界且重新验证作用域/筛选/水位/边界，不充当授权凭证；复用既有privacy_epoch。最初只比较可见计数的方案在当前单调隐私入口下未证实泄漏，不将它记为已复现安全漏洞。
- **备份子任务：**修改 `opening-backup-records.ts`、`opening-backup-record-table-queries.ts`、domain `backup-compose-validation.ts`、`backup-policy.ts`、`backup-apply-plan.ts` 及近测试。新包保存并校验事实序号和owner计数器；只有新表与全部新字段均缺失才视为旧包，显式补零而不猜旧提交顺序。计数器在观察前恢复；仍叠加当前删除事实，不回放jobs/outbox。`opening-learning-history-backup.test.ts` 是既有文件的增量，保留原断言，不是新建替代。
- **B／用户入口：**新增 `history-service.ts/.test.ts`、`/api/opening/courses/[id]/observations/history/route.ts`、client `history-client.ts/.test.ts`、`course-history.tsx/.test.ts`、`course-history-state.ts/.test.ts` 和新 handler；窄改 `course-view.tsx/.test.ts`。课程页停止全量观察请求，默认50/最大200，支持手动续页/刷新以及全部、未指定、空串与精确要求筛选；保留摘要、练习、单根完整修订链和409保留草稿。可见性变化先清旧页/卡片，失败不回显旧敏感内容，异步旧结果不得混入新scope。

**检查、失败修复与独立审查：**契约11/11；分页、旧writer/修订三个integration文件26/26；历史备份与记录导出12/12；旧读取handler2/2、新历史handler5/5。真实交错证明A已分配未提交、B等待counter锁时，第三连接立即读旧R；A/B提交后旧cursor不纳入新事实。另覆盖201根、跨课程迁入/迁出、legacy0链、回滚/重放、微秒、撤回、隐私隐藏边界及伪造/错scope游标。微秒首次失败是夹具被驱动截成毫秒，改为显式text::timestamptz后原命令通过；备份首次9/12，分别补旧裸夹具counter0，以及将两个新恢复用例错误传入的空journal改为当前owner快照journal，具体拒绝为JOURNAL_DRIFT，没有放宽生产保护。八个测试roots严格TS最终0诊断；六处已创建夹具table非空断言及末尾空行只作最小修复。

备份子任务真实RED11项→近unit36/36；扩展19文件首次236/239，负责人实读发现旧lineage测试将先执行的memory tombstone查询误作正文导出。仅将选择器限定到正文导出别名，全部安全断言保留，单文件5/5、最终原19文件集合239/239、lint/diff通过。B旧页面真实RED1失败/10通过→五近文件65/65。

Sol实际读取核心/备份/HTTP/UI差异与未跟踪文件，发现单页历史没有后续分页请求，另一活跃标签成功排除材料后旧正文不会主动清除。交原B修复：`source-actions-client.ts/.test.ts`、`course-history-state.ts/.test.ts`、`course-history.tsx`，新增窄 `client/privacy-change.ts/.test.ts`。真实客户端链RED4失败/10通过→五受影响文件48/48；最终仅整理测试替身后state15/15、严格TS0诊断。有效成功exclude/delete才发无正文同页通知和BroadcastChannel固定字符串，controller立即清页/卡片并递增代际，旧append/refresh不能回填；409/500/非法成功响应及retry_cleanup不通知，普通focus不清草稿。Sol只复核七个修复文件及受影响链，无新增确定缺陷。contracts/database/domain/web所属包类型检查、相关lint/diff均通过，不代表浏览器通过。

主要实际命令（pwsh脚本首行均为 `$ErrorActionPreference = 'Stop'`；现有Vitest配置 `maxWorkers: 1` 且integration/handler `fileParallelism: false`）：

```text
pwsh -File .local/opening-e2e/check-service-tests.ps1 --project integration tests/integration/opening-learning-history-pagination.test.ts tests/integration/opening-observation-revisions.test.ts tests/integration/opening-learning-attempts.test.ts
pwsh -File .local/opening-e2e/check-service-tests.ps1 --project integration tests/integration/opening-learning-history-backup.test.ts tests/integration/opening-backup-records-repository.test.ts
& '.local/opening-e2e/check-service-tests.ps1' --project handler tests/integration/handler/opening-learning-history.test.ts --maxWorkers 1 --no-file-parallelism
node node_modules/vitest/vitest.mjs run --project unit packages/contracts/src/opening/learning-history.test.ts
$files = @(rg --files packages/domain/src/opening packages/database/src/repositories -g '*backup*.test.ts')
node node_modules/vitest/vitest.mjs run --project unit @files
node node_modules/vitest/vitest.mjs run --project unit apps/web/src/features/opening/client/privacy-change.test.ts apps/web/src/features/opening/inbox/source-actions-client.test.ts apps/web/src/features/opening/learning/course-history-state.test.ts apps/web/src/features/opening/learning/course-history.test.ts apps/web/src/features/opening/learning/course-view.test.ts
node node_modules/typescript/bin/tsc -p apps/web/tsconfig.json --noEmit --incremental false
```

**本地预览、用户检验与限制：**负责人确认仅0037待应用后，通过既有 `scripts/db-migrate.ts` 将其应用到本地 `127.0.0.1:15432/aistudy_opening_e2e`，迁移前后36 users /2 courses /0 observations一致，没有reset/seed或生产迁移。`http://127.0.0.1:3100` 的health、login、courses及一个实际课程页均HTTP200，仅说明入口可达。登录已有账号，进入课程的“学习记录与证据”→“已保存的观察 · 按固定快照翻阅”：当前预览可先检查空态；分页检验需准备至少51条测试观察及不同要求，预期首批50、续页无重复、筛选不串页、新作答/纠错待刷新进入新快照。单页展开卡片后，在同源另一活跃标签排除/删除其材料，预期旧页立即清空并重读；普通切回标签不丢草稿。浏览器不支持或禁用BroadcastChannel时仅保证同页通知，跨标签需显式刷新/后续请求，不覆盖跨设备、离线或休眠补发。

当前读取仍扫描并资格评估全部候选，尚未完成SQL资格投影/分组聚合或1千/1万/10万规模测量；响应有界不等于查询成本有界。没有生产恢复执行器，不保证恢复前cursor继续有效；真实模型、飞书、浏览器、真机和恢复演练未验证。本片不运行全仓test/build/CI，不执行commit/push/merge/deploy。回退可关闭新入口，但须保留新增字段、计数器及正确writer，不得恢复默认0或删除隐私/修订保护。下一片继续S6资格投影与分组摘要，完成共享数据接口后再并行消费方，S7/S8仍在原计划范围。
**本片收尾：**稳定差异与修复复核完成后，负责人仅运行一次 `graphify update .`，exit0：14,972节点、34,115边、719社区；38个SQL因缺tree_sitter_sql未索引，8个JSON/config未提取节点。185个社区按hub重命名，未调用LLM重标注或文档语义重提取。生成物未暂存；之后仅补本交接文字，不重复更新代码图。分支仍 `feat/opening-release`、HEAD `dc5f176`，暂存区为空；新历史测试进程已退出，隔离数据库窗口空闲归负责人。

**2026-09-30 第三片：资格投影、分组摘要与规模测量，实现中。**复用两条 `gpt-6-astra / high` 主实现：A 独占 database 的批量资格上下文、current-head 派生投影、分组聚合、语义水位接入及 `0038_opening_learning_eligibility.sql`/数据库导出；B 独占 contracts/domain 的聚合与页面契约、HTTP/client/UI 消费及其近测试。迁移编号已实读确认上一项为0037，尚未把0038记成已应用。共享契约只由B写、数据库水位与迁移只由A写，任务计划只由负责人写；A可把明确不重叠的外层业务writer交子Agent。测试数据库串行分配，稳定差异再进入Sol独立审查，不为增加Agent复制调查或重复有效检查。拟复用0037普通workspace/owner水位覆盖影响摘要的真实业务变化，投影重建不推进；固定历史R的比较允许非观察变化留下的序号空隙。完整接口、锁顺序和同步失效仍在本片实现与验证中。

**改前实际测量：**新增且默认skip的 `tests/integration/opening-learning-summary-performance.test.ts`，只在 `OPENING_SUMMARY_PERF=1` 和 `127.0.0.1:15432/aistudy_opening_test` 运行。1千合成观察、10个分组、800核验正确/200核验错误、每条独立attempt/problem/item、共享一个来源版本，走真实课程授权→证据读取→领域汇总→响应投影。首轮可见样本每请求6004 SQL（6002 SELECT及BEGIN/COMMIT），总耗时4307.549 /4172.646 /4666.063 /3959.623 ms，响应90843 bytes、200代表ID；证据读取占绝大多数。机器AMD Ryzen 7 H 260/16逻辑CPU、总内存16388202496 bytes，首轮开始空闲434872320 bytes；20ms采样应用RSS峰246820864–258977792 bytes，包含测试进程及导入开销，不是请求净内存。新连接首读也被seed温热数据库，不是物理冷缓存；10k/100k、EXPLAIN/扫描行、数据库内存、HTTP和并发仍未测，不据此承诺容量。

**测量修复与检查：**首次seed的JSON字符串被postgres.js再次编码，改为既有恢复路径使用的 `::text::json` 后通过；通过用例的日志被隐藏，改stdout后重跑得到上列可见指标。启用1k为1/1 passed，默认不设开关为1/1 skipped，单文件lint和严格TS为0。`gpt-6-sol / ultra` 独立实读harness、fixture及真实读链，发现finally只reset业务表/关连接，遗漏本次fixture的基础身份与课程。原作者仅改性能文件，按两个scope/owner定向清理并保证测量连接关闭失败时仍执行fixture清理/关闭；负责人实读修复。必要1k复查1/1 passed，users93→93、workspaces93→93、courses18→18、sessions50→50，未清理既有基础记录；新样本总耗时5434.060 /4427.985 /4163.715 /4253.665 ms，仍6004 SQL，响应91059 bytes。两次独立合成样本的响应字节不同，尚未单独归因，不能当作代码优化结果。最终单文件lint exit0、严格TS Diagnostics0。Sol已实读性能清理修复与关闭失败的finally路径，未发现确定问题；上述测量不代表新投影已经实现或通过。

实际测量命令为：在pwsh中首行设 `$ErrorActionPreference = 'Stop'`，设置 `$env:OPENING_SUMMARY_PERF = '1'` 和 `$env:OPENING_SUMMARY_PERF_RECORDS = '1000'`，运行 `& '.local/opening-e2e/check-service-tests.ps1' --project integration tests/integration/opening-learning-summary-performance.test.ts --maxWorkers 1 --no-file-parallelism --silent=false`。性能任务结束已关闭连接并释放数据库窗口，交A串行执行本片数据库检查。浏览器、真机及真实模型仍待用户/外部环境；未运行全仓test/build/CI，未提交、推送、合并或部署，原账本仍不提升。
**第三片实际推进（仍实现中）：**批量context近unit先捕获8头49读，改为集合读取后1/1通过、最多9读；这是模拟SQL边界的真实repository/evaluator测试，不冒充数据库负载测量。实际ID列表已改原生UUID数组参数，避免100k档展开参数超限；read-repair安装改为单条集合UPSERT，保留每root的旧head/inputR/policy比较及RETURNING安装数量。新0038经既有测试globalSetup仅应用于隔离test库，首个事实与投影同事务的真实integration1/1通过。邻近attempt和revision/privacy回归已有通过；新分组SQL尚在实现，两个response解析失败来自尚未落盘的历史成功/适用性完整计数契约，不作为通过。

共享契约已实际完成 `learning-summary-page.ts/.test.ts` 与opening/index导出：32/32、contracts tsc/lint退出0。拒绝路径真实RED为根aggregate默默剥离未知status字段，补strict后GREEN；updating明确没有旧组结论，携带pendingProjectionCount并固定evaluatedAt、snapshotRevision。其后继续domain/UI及必要完整计数字段。writer子任务八个业务文件及两个近测试15/15、lint0；Sol独立读取后发现snooze字符串格式不同但时刻相同会误增版本，已交原实现者加回归并最小修复，尚未记为修复完成。

**负责人改后复测：**同一性能命令、1千条/10组/原完整摘要链，实际exit0、1/1，测试3.57秒、总工具报告9.49秒，进程74598已退出。每请求11 SQL（9 SELECT、BEGIN/COMMIT）；application-first及三次warm总耗时479.523 /387.345 /371.800 /347.042 ms，证据读取419.763 /378.964 /366.220 /338.697 ms；响应91086 bytes、200代表ID，1000总数及200历史错误断言通过。开始空闲内存474714112 bytes，采样RSS峰274251776 bytes；不声称内存减少。相对于改前6004 SQL，这一实测支持消除逐观察数据库往返后的读取改善；仍非物理冷缓存、HTTP或新投影页验收，也未运行10k/100k。窗口已归还A，继续新分页/失效/并发回归；其他实现仅在测量结束后恢复类型与unit检查。
**201+ 摘要片收尾记录（历史）：**上述两片冻结并完成审查后，仅运行一次 `graphify update .`，session13163最终exit0：14,892节点、33,856边、693社区，生成物未暂存；37个SQL文件因缺少tree_sitter_sql未索引，8个JSON/config文件未提取节点，194个社区采用hub重命名，未调用LLM重新标注或重新提取文档语义。随后只补本交接文字，不重复更新代码图。当前分支仍`feat/opening-release`、HEAD `dc5f176`，暂存区为空。单独启动的Next dev（本地进程记录`s6-web-preview`）已验证 `/api/health`、`/login`、`/opening/today`、`/opening/courses` HTTP200；这不是浏览器或真实模型验收。现无活跃数据库测试，窗口归负责人；不启动后续迁移或修改既有0034–0036来伪装分页已完成。

**2026-09-30 第三片收尾整合（本轮同步前统一验证）：**第三片差异在提交前做了一次统一完整性验证，不替代各子任务原有窄范围结果，也不提升原账本。本地隔离环境（`services.ps1 start` 启动 15432/16379/19000）实际运行：9 个 TS 配置 typecheck 全部 0 诊断；全部 unit 288 文件 / 1988 项通过；integration 82 文件与 handler 30 文件经 `.local/opening-e2e/check-service-tests.ps1` 全部通过；worker/web 构建通过；全部新增/修改文件定向 lint 0 错误。过程中修复四处夹具与新语义的漂移，均为“夹具落后于有意行为变更”，非业务缺陷：①`source-service.test.ts` 假 SQL 补工作区修订计数行与资格失效查询（含嵌套模板片段透传）；②`ephemeral-privacy.test.ts` 对齐上下文选择（非空白查询只保留词法匹配 chunk）与历史 provenance 解析语义；③`opening-backup-compose-repository.test.ts` 备份表数 25→26（新增 `opening_workspace_history_revisions`）；④`opening-learning-history-backup.test.ts` 中 delivered help 现在也是学习语义事实、推进工作区修订，观察序号为 2–4、计数器为 4。另把 HEAD 上就已落后的 `identity-migration-compatibility.test.ts` 期望迁移列表补到 0038。`check-service-tests.ps1` 因 PowerShell 5.1 内联引号/JSON 解析不兼容改为 `print-isolated-env.mjs` 辅助文件（该文件在 `.local/` 不入库）；性能测试默认 skip 保持不变。浏览器、真机、真实模型、10k/100k 规模档与生产恢复演练仍待用户/外部环境；原账本不提升。

**修改：**`packages/contracts/src/opening/learning.ts`、`packages/domain/src/opening/learning-summary.ts`、`apps/web/src/features/opening/learning/read-service.ts`、`packages/database/src/repositories/opening-learning.ts`、`docs/product/UX_AND_AI_POLICY.md`。

**新增：**`packages/database/src/repositories/opening-learning-read.ts`、`opening-learning-projection.ts`；`tests/integration/opening-learning-summary-pagination.test.ts`。

**接口：**`readLearningSummary(scope, { courseId, groupCursor, limit })` 返回分组摘要、代表证据、完整可见计数及计算状态；`readObservationHistory(scope, { courseId, requirementKey, cursor, limit })` 返回第 3.4 节快照分页。历史默认 50/最大 200，摘要代表证据默认 20；这些只是响应控制值，不是学习判定阈值。

- [ ] V6 先覆盖 0/1/200/201 条、修订只计有效头、旧失败被纠正、不同要求仍失败、跨 owner、补录/修订/删除交错。
- [ ] 在数据库选择本页 skill/requirement 分组后，聚合这些分组的完整有效历史；不先 LIMIT 原观察再算摘要。SQL 输出完整计数及有限代表记录，历史使用独立 keyset 查询。
- [ ] 资格只由共用 evaluator 计算：建立可重建的窄 `opening_learning_eligibility` 派生表，记录有效头、policyVersion、源版本上下文与结果；写入/修订时同步更新，来源/规则变化重算受影响组。SQL 只聚合已验证投影，不再写第二套资格规则。
- [ ] 查询逐次检查投影与事实 revision、来源版本及隐私状态的一致性。落后时返回“更新中”与事实保存成功，不展示过期能力结论；隐私即时屏蔽不能等待重算。派生表可重建，不作备份中的唯一事实；整组摘要缓存等实测需要再增加。
- [ ] 首次历史读捕获已提交 historyRevision；分页重建该 revision 内有效头。加入事务 A 已分配版本未提交、事务 B 等待、首屏读/后续页的可控交错，证明不是单靠时间戳的伪快照。
- [ ] 输出分开展示 recentComparableEvidence、historicalSuccess、openChecks、applicability、nextAction。近期独立成功可体现成长；不同要求的失败不因窗口截断消失；一次观察不映射为“稳固”或掌握百分比。
- [ ] 用 1 千/1 万/10 万合成记录逐级测 SQL 计划、扫描行、响应字节、DB/应用内存、冷热延迟与重算耗时；记录机器规格再决定索引和预算，不先承诺容量。无用户材料进入负载样本。

**完成与回退：**B10–B12、E05 通过；代表证据有限而结论不丢有效反例。读路径回退可显示历史和更新中，不能回到全量返回 evidenceIds 或忽略修订的实现。

### S7：三类入口和能执行的日常安排

**修改：**`apps/web/src/features/opening/planning/today-view.tsx`、`apps/web/src/features/opening/assistant/assistant-view.tsx`、`apps/web/src/features/opening/inbox/source-viewer.tsx`、`apps/web/src/features/exploration/exploration-workspace.tsx`、`packages/contracts/src/opening/planning.ts`、`packages/domain/src/opening/day-planner.ts`、`apps/web/src/features/opening/planning/plan-service.ts`。

**新增：**`tests/e2e/opening-learning-continuity.spec.ts`。复用现有笔记/探索的真实服务，不把旧 mock 页面当作通过。

**接口：**计划器保留 `unscheduledTaskIds` 兼容字段并增加每项 `reasonCode` 与可解释缺口；任务先支持用户可修正的 remainingMinutes、是否可中断及最小完整步骤。估时范围/准备成本/依赖只在相应冲突用例成立时引入，不一次实现完整排程平台。

- [ ] V7 先运行“无课程读材料→做笔记→刷新找到内容”“关闭评价自由追问→返回原材料”“继续学习同时忽略建议”三条流程。
- [ ] 材料、笔记、助理切换保留位置和引用；恢复以服务端已确认水位为准，本地冲突草稿保留双方并解释；不保存模式排除恢复正文。
- [ ] 用结构性冲突输出解释未排入任务：依赖不满足、可用块不足、锁定安排冲突、明确截止无法满足。硬截止与睡眠/课程不被自动修改，用户选择缩小范围或移动可移动安排。
- [ ] 中断只更新剩余工作和下一步，做完步骤不能把整项任务 done；自由输入可用时间，不固化 5/15/30 分钟为业务类型。
- [ ] 在移动设备检查软键盘遮挡、窄屏长公式、引用点击、焦点顺序、错误/重试与触控。保存截图/trace 和手动操作记录；桌面通过不替代真机。

**完成与回退：**D04–D05 及三入口浏览器流程通过。新增排程提示可关闭，用户笔记、草稿、显式任务及截止不回滚丢失。

### S8：恢复演练、实际收益与下一轮排序

**复用/修改：**`packages/database/src/repositories/opening-backup-records.ts`、`opening-backup-record-table-queries.ts`、`packages/database/src/storage/opening-backup-manifest.ts`、`packages/domain/src/opening/backup-apply-plan.ts`、现有 backup restore/发布路径；原 Q03/Q01/Q02 evidence。遵循 [备份集成](2026-09-25-opening-backup-integration.md) 和 [备份发布](2026-09-25-opening-backup-publication.md) 的既有边界。

**产物：**一份实际恢复记录、一门真实课程和一条不启用评价的探索/笔记记录、下一轮优先级建议；不生成虚假的学会结论。

- [ ] V8 先完成含新 schema 的干净环境恢复，覆盖历史源版本、修订、终态、决定重放及最新删除叠加；损坏对象/缺密钥/删除水位缺失安全失败。外部模型、导入、邮件和提醒默认关闭。
- [ ] 在演练前记录使用者可接受的 RPO/RTO、优先资产、密钥责任与可承担成本；未确定不影响功能开发，但发布说明只能写“恢复目标未验收”。实际计时/核对丢失量，不用导出成功代替恢复。
- [ ] 核对既有 `apps/worker/src/runtime/budgeted-call.ts` 的 outcome_unknown/预算预留处理，并扩展同目录 `budgeted-call.test.ts`，按 D03 补跨取消/重试场景；外部执行未知不自动重发，逻辑 operation 与每次 providerAttempt 分开，重试费用包括未决敞口。
- [ ] 选择有材料及明确要求的一门课程，依次记录受提示练习、可比独立题、事先约定延迟的检验、后续真实任务再次使用；人工核对模型新题的目标与难度，未经核对不当评分基准。
- [ ] 同时记录无课程阅读/笔记成功路径。指标包括正确恢复所需时间、全部操作的成功/失败/取消、整理确认与提醒处理成本，以及合格/污染/未核验/未参加/取消的独立与延迟表现；报告分母和原始样本。
- [ ] 只报告可观察变化和限制，不把单人前后变化当因果证明。效果分析默认不额外收集正文，保留期及分析范围由使用者选择。
- [ ] 沿用 Q03→Q01→Q02 完成交付证据，逐项列 CI、真机、真实模型语义、恢复的通过/未运行。再评估保温、复学、更新影响、方法实验以及原 CAP 扩展的顺序。

**完成与回退：**D03、D07–D08 和真实使用证据清楚区分。恢复未完整验证则保持隔离；收益不明确时维持简单规则，保留数据并停止效果不明的自动建议。

## 5. 数据变更与交付规则

每个有持久字段变化的切片按以下顺序执行：扩展请求/响应适配 → 追加 schema/索引 → 可证明的兼容回填 → 更新备份显式表/列清单和导入依赖顺序 → 新旧格式往返测试 → 切换消费方。只有存在具体差异疑问时才做派生结果影子比较，不双写两份学习事实，不增加“先冻结再开发”的流程。

现有备份的固定清单不含 `opening_jobs`，chunks 查询主要取当前来源版本；因此 S1 的决定记录、S2/S3 的历史引用、S4 的业务活动不能假定自动进入导出。每片必须核对导出和恢复两端；旧格式缺失的信息读取为 unknown。保留当前完整性校验，禁止为纳入新表复制另一套备份协议。

数据库前向兼容优先；功能关闭只关闭读展示或自动行为，不删除新事实。应用回退版本必须理解修订、终态及隐私排除；不满足时保持安全降级并前向修复，而不是执行会丢失事实的 down migration。破坏性清理不在本轮范围。

每次实际实施记录：原任务 ID、改动/提交、环境、失败→原因→修复→同命令复测、准确结果、未运行项、CI/手动验收位置、schema 与回退说明。局部测试只能支持其覆盖的结论；原任务全部依赖与验收满足后才更新原账本。本文没有把任何计划复选框勾成已完成。

## 6. 近期执行入口与后续保留项

下一步从 S0 的现有修复交接开始，随后完成 S1 可用审核页与重试闭环，再进入证据数据变化。详细场景、来源覆盖与命令见 [验收附件](2026-09-27-learning-continuity-acceptance.md)。

FSRS 等调度实验只有在时间、去重、事实与评价边界可靠后再比较；历史回放按时间切分，先影子计算、再用户选择启用。复杂诊断先证明能减少一次无效解释。邮箱、钉钉、音视频与知识结构继续保留原 CAP 要求和依赖，后续投入不凭本计划自动扩张。
