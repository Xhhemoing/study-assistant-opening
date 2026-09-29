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

采用课程/owner 作用域内的普通 `historyRevision` 计数行：写事实/修订时在同一事务锁定并递增，事件保存所得 revision；事务回滚不推进。首屏在短一致读事务取已提交 revision；随后游标携带此 revision 和排序边界，只取其以内每个根最后有效修订。不用 `nextval()`、客户端时间或单独 snapshotAsOf 日期推断提交先后，不保持跨 HTTP 长事务。这是普通数据版本与事务，不是新的冻结基线、哈希或门禁。

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

**2026-09-30（Asia/Shanghai）材料操作与关联片段：实施中。**用户已明确选择：主动保存的临时对话片段保留来源关联，原材料的隐私限制继续约束相关笔记，不创建绕过原限制的无来源副本。A 负责材料引用影响、停止供模型使用、资产删除与部分对象清理重试，唯一迁移编号 0034；B 负责无正文临时来源凭据、显式保存为关联笔记、原生笔记读取及备份/恢复保护，唯一迁移编号 0035。两个数据库迁移只在隔离测试库验证，源操作与关联笔记尚未完成审查/集成；原账本和验收复选框不提升。公共导出由 A 单一写入，测试数据库按短窗口串行使用。

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
