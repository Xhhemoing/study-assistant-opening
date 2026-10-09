# Research hardening (post-opening) — RP7, DL11, BC1, TZ01

> 2026-10-09（CST）依据 Paula 调研附件 [`docs/quality/2026-10-09-loop-review-research.md`](../../../quality/2026-10-09-loop-review-research.md) §5「优先级最高的大问题与具体方案」落为任务级硬化切片。PM 指定账本 id：**RP7**、**DL11**、**BC1**、**TZ01**（**禁止**复用历史 id **B01**——B01 仍是已 verified 的质量基线任务，本文件不改其状态或语义）。各任务验收条目（Acceptance）写入本文件；静态推导与反例仍需运行证据，不把审查推断当已复现缺陷。

**Purpose:** 开学版功能面大体具备之后，把下一阶段重点从「再加聊天页 / 换 Agent 框架」转向研究指出的四类硬化：同一 tip SHA 上的发布证据索引、排程器对最早可执行时间（`notBefore` / `notBeforeAt`）的尊重、预算调用方与账本契约一致性、以及本地日界与课表/工作区时区共用同一解释。

**Global constraints:**

- 不改动 `apps/web` 产品代码除非某任务明确列出 Modify；本计划文件与 `tasks.json` 入账本身不触碰产品实现。
- 不把 **Q03**、**RP5** 标为 verified：Q03 仍是独立的 packaging/restore active 轨道；RP5 仍是 CI 门禁 active 轨道。GHA watch 继续交给其他 agent。
- 不重开已 verified 的 DL1–DL10 / RP1–RP6 / B00–B02；本批次只新增上述四 id。
- **BC1 ≠ B01**：B01（`00-quality-baseline.md`）保持历史 verified 不动；预算契约硬化只用 **BC1**。
- 复用既有 domain / contracts / budget / day-planner，不新造并行预算模型或调度器服务；凭据与密钥不进入证据索引 JSON。
- 浏览器与真实账户联调按 `AGENTS.md` 由用户负责；Agent 只跑最接近改动的单元/契约/handler/integration 测试。

**Out of scope（整文件）:** §5.5 学习证据分层整合、§5.6 生活闭环减负策略、npm audit 逐项修复、`npm audit fix --force`、新 Agent 编排框架、生产切换。上述可另开计划，不占用本四 id。

---

### RP7: Release evidence index bound to the same quality SHA

**Owner:** INTEGRATOR. **Depends:** RP5（CI 门禁先收敛到可引用的 quality 运行；本任务不代替把 RP5 标 verified）。
**Plan source:** 调研 §5.1 P0。
**Goal:** 为发布候选建立「同一 tip SHA」的证据索引：索引列出该 SHA 上要求的自动化/人工证据路径，并绑定该 tip 的 GHA `quality`（或等价门禁）运行 URL；无证据 = unknown，旧提交通过 = stale，运行中 = pending，失败保留定位入口。
**Why:** 「任务 verified」「CI 通过」「真实环境可用」「用户验收完成」是不同事实；不能把整项目标成已交付。需要索引，而不是再造一层复杂工作流引擎。

**Approach:**

- 新建（或约定路径的）发布证据索引文档/JSON：每条最少含 `commitSha`、`checkName`、`runId`、`environment`、`completedAt`、`result`、`artifact`（相对路径即可）。
- 索引绑定**一个** tip SHA：该 SHA 的源码与所有要求的证据一致；影响范围内的新提交后重跑相关检查，不得直接继承旧总绿灯。
- Q03 的打包/恢复证据以**当前证据文件**逐条核对是否已覆盖，不因 Q03 仍 active 就否定已有恢复实现，也不在本任务把 Q03 标 verified。
- 凭据、token、连接串不进入状态 JSON。

**Create / Modify（实现时由 INTEGRATOR 选定具体路径，本行可更新）:** 例如 `docs/superpowers/evidence/<date>-opening-release/release-evidence-index.md`（或同目录 JSON）及对 Q03 readiness / `docs/operations/ci.md` 的交叉引用；不改应用路由。

**Interfaces:** 无运行时 API；验收以索引文件 + 绑定的 GHA URL + tip SHA 三者一致为准。

- [ ] 索引模板字段齐全（见上），缺证据时显式 `unknown` / `stale` / `pending`，失败条目保留 run 定位入口。
- [ ] 选定一个 tip SHA：索引中所有自动化证据的 `commitSha` 与该 tip 一致（或标明 stale 并说明需重跑）。
- [ ] 写入该 tip 的 GHA quality（或当前门禁 job）运行 URL 与 `runId`/`result`。
- [ ] 列出 Q03/RP5/Q01 相关证据路径的占位或已有路径；**不**在本任务改 Q03/RP5 账本状态。
- [ ] 回归：不把本计划合并或索引文件存在当作「门禁已通过」或「可生产切换」。

**Acceptance:** 发布候选可指着「一个 SHA + 一份索引 + 一条 quality URL」核对证据集合；依赖范围内新提交后不能静默沿用旧绿灯。

**Out of scope:** 生产切换；强制推送；把 Q01/Q02/Q04 标 verified；代替 RP5 修 CI 失败根因；依赖漏洞 `npm audit fix --force`。

---

### DL11: Day-planner respects `notBefore` / `notBeforeAt`

**Owner:** DATA（实现可与 AI 协作领域测试，账本 owner 为 DATA）. **Depends:** DL3（补测投影已提供 `recommendedAt` / 重测闭环；本任务补「最早可执行」在分配空档时的约束）. 与 P04a 日草案共用 `planDay` 时，实现后应被草案路径自然消费，不另开依赖阻塞入账。
**Plan source:** 调研 §5.2 P1；语义对齐 [`2026-09-27-learning-continuity-implementation.md`](../2026-09-27-learning-continuity-implementation.md)（`notBeforeAt` = 协议允许的最早测量时刻；`recommendedAt` = 建议）。
**Goal:** `planDay`（及同等排程入口）在真正分配开始时间时尊重最早允许时刻：跳过或推迟早于 `notBefore` / `notBeforeAt`（实现字段名与现有 `retest.recommendedAt` 对齐）的补测/任务，避免「今天到期」就被排到上午。
**Why（调研已确认的源码推导，仍需领域测试）:** `packages/domain/src/opening/day-planner.ts` 中 `isRetestNotYetDue` 用 `recommendedAt > dayEnd` 过滤非当天补测，但分配空档时寻找 `candidate.start + duration <= min(candidate.end, due)`，**没有**取 `recommendedAt`（或 `notBefore`）与候选开始时间的最大值。反例：`recommendedAt=今天16:00`、耗时 20 分钟、上午 09:00 有空档 → 可能被排到 09:00。

**Approach:**

```text
start = max(slot.start, task.notBefore, planningNow)
end   = start + duration
要求 end <= min(slot.end, task.dueAt)
```

- 选未来空档后，原空档前缀留给其他任务，避免下午补测浪费上午时间。
- 兼容 confirmed deadline、preferredOrder、不可拆分任务与固定安排。
- 提交复测结果时服务端再次核验最早允许时间；前端禁用按钮不构成保障。
- 字段映射：优先复用 DL3 的 `retest.recommendedAt` 作为 earliest-allowed；若契约后续引入显式 `notBeforeAt`，与 recommended 区分时按 continuity 计划语义处理，本任务不预占迁移编号。

**Modify:** `packages/domain/src/opening/day-planner.ts`、对应 `day-planner` 单测；必要时契约/任务投影只读字段说明（INTEGRATOR 合入公共导出）。
**Interfaces:** `planDay` 对带 earliest-allowed 的任务按上式选 start；无法安排时保留明确未排原因，不改任务完成状态。

- [ ] 领域单测（红→绿）：下午补测不早排；仅上午空档时未排且原因明确；存在下午空档时正确安排。
- [ ] 晚测不阻塞其他可在上午完成的任务；恰好到期边界；超过截止；无可用时间。
- [ ] 并发接受旧草稿时，计划提案不自行修改任务完成状态（锁定现有边界）。
- [ ] 回归：DL3「`recommendedAt` 晚于日末则整日跳过」行为仍在；普通 `dueAt` 截止语义不变。
- [ ] 验证：`node node_modules/vitest/vitest.mjs run --project unit packages/domain/src/opening/`；相关 typecheck。

**Acceptance:** 排程结果不早于 earliest-allowed；不可排时原因可解释；服务端提交路径仍可独立拒早测。

**Out of scope:** 自动改 confirmed plan；新调度器服务；把「建议」写成硬 `dueAt`（DL3 已否决该语义）。

---

### BC1: Budget contract — discovery/settings vs ledger

**Owner:** AI+DATA. **Depends:** DL7（就绪清单、设置页额度、惰性对账与本地日归账已落地；本任务硬化**调用方/fixture/错误映射与账本**的契约一致性）.
**Id note:** **BC1**（budget-contract）。**不要**使用或改写 **B01**（B01 = `00-quality-baseline.md` 历史质量基线，已 verified，本任务与之无关）。
**Plan source:** 调研 §5.4 P0。
**Goal:** 统一「发现/设置层可见状态」与「预算账本」对 `budget_disabled`、每日额度、未知预留释放/对账的契约：生产调用方与测试 fixture 共用同一套必填字段与错误族，失败可释放/已知结算/未知待对账三类分清，重复执行最终状态与一次成功一致。
**Why:** 历史 CI 暴露过缺单次预算、费用明细、错误分类不符、失败/重试后占用等多类问题；不能靠删断言变绿。需先按真实错误族分组，再在最新候选 SHA 上复现后决定修生产还是 fixture。

**Approach — 共同契约（与现有命名兼容，不并行造模型）:**

- 允许能力、单次费用上限、工作区余量、预计最大调用次数、provider 执行凭证、实际费用确认状态。
- 失败三类：未发出请求 → 释放对应预留；已发出且费用已知 → 按事实结算；已发出但费用未知 → 保留待对账，不以 0 费用强行清空。
- 发现/设置层：`budget_disabled`、有效日额度、今日已用/剩余与账本统计同源（延续 DL7 `resolveEffectiveDailyCap` / readiness）。
- 先在最新候选 SHA 重跑失败族，再改代码；不放宽安全门禁。

**Modify（范围示意，实现时收窄）:** `packages`/`apps` 内预算调用链、费用回执、错误映射、相关 worker/queue 与 fixture；契约字段变更须经 INTEGRATOR 批准后再改公共导出。
**Interfaces:** 与现有 budgeted-call / opening-budget / ai-settings 对齐的稳定业务错误码；禁止把禁用能力/额度不足映射成泛化 INTERNAL。

- [ ] 错误族分组记录：生产缺参 vs fixture 未跟强制字段 vs 错误映射 vs 回执维度 vs 请求前后异常 vs 重复/迟到回调。
- [ ] 最低测试矩阵：缺单次预算时 provider 调用数 = 0；禁用能力返回稳定业务错误；合法 fixture 含全部必需字段。
- [ ] 两并发请求不能同时消费同一余额；取消与迟到结果竞争不双扣/双退。
- [ ] provider 成功但本地持久化失败可恢复；usage 不完整时保留对账；未知费用确认后只收敛一次。
- [ ] 回归：DL7 有效额度、惰性清扫、`budget_disabled` 安全默认不被本任务回退。

**Acceptance:** 发现/设置与账本对禁用、日额度、未知预留的语义一致；门禁失败时修根因或 fixture，不删保护断言。

**Out of scope:** 改 B01 基线任务；新建第二套预算表；`npm audit fix --force`；放宽或删除安全门禁以换绿灯。

---

### TZ01: Local day-boundary (IANA timezone)

**Owner:** DATA+AI. **Depends:** DL7（预算已要求按用户本地日归账；本任务把**日界解释**提升为跨模块契约，并覆盖排程/课表展开）.
**Plan source:** 调研 §5.3 P1；可参考 DL7 已写的「北京时间 00:30 与 07:59 计入同一天」验收缺口是否在实现中闭合。
**Goal:** 每次计划/预算日界请求携带本地日期与工作区 IANA 时区（例如 `Asia/Shanghai`），由**一处**计算 `[dayStart, nextDayStart)`；存储用绝对时间，展示与课表展开按工作区时区。非法日期报可理解输入错误，禁止 NaN/无限边界悄悄退化成不约束。
**Why:** `resolveDayEndMs` 在未传 `options.dayEnd` 时，取最早 free 开始的 UTC 日期并拼 UTC 日末，不保证等于学生本地日结束——属跨模块契约风险（调用端可能已显式传值，故不武断标成「所有用户已错」）。

**Approach:**

- 统一 day-boundary helper：输入 `(localDate, timeZone)` → `[dayStart, nextDayStart)` 绝对时刻。
- 预算日界、`planDay` 日末、课表展开、提醒本地日共用同一解释（与 DL7 默认 `Asia/Shanghai` 对齐处写清）。
- 性质测试：上海与负偏移时区；跨夜安排；季节偏移；课程例外；紧邻不重叠块；重复/重叠 free 块不增加虚假容量（重叠块要求为验收建议；未独立确认的实现细节不写成已证实缺陷）。

**Modify:** domain 日界/day-planner 相关纯函数与单测；预算归本地日逻辑与 DL7 对齐处；必要时 API 请求携带 `timeZone`/`localDate` 的契约说明。
**Interfaces:** 单一 `resolveLocalDayBounds(...)`（名称实现时确定）供 plan 与 budget 调用。

- [ ] 单测：`Asia/Shanghai` 下 00:30 与 07:59 属同一本地日；UTC 日界不得把二者拆进两天。
- [ ] 单测：负偏移时区、跨夜块、非法日期 → 明确错误而非静默不约束。
- [ ] 排程与预算在未显式传 `dayEnd` 时仍落到工作区时区本地日末，而非裸 UTC 日末（若保留显式覆盖，文档化优先级）。
- [ ] 回归：DL7 对账「只按创建时间归入本地日」不被破坏；提醒 worker 时区来源一致。

**Acceptance:** 课表、预算 caps、日计划对「哪一天」的答案一致；典型上海日界用例有自动化锁。

**Out of scope:** 改用户设备系统时区；多时区同时办公的完整产品设计；重开 DL7 已 verified 状态。

---

## 与既有任务的关系

| 既有 | 关系 |
|---|---|
| **RP5**（active） | RP7 依赖其 quality 运行可引用；**不**在本文件把 RP5 标 verified；GHA watch 仍由其他 agent。 |
| **Q03**（active） | **保持独立** packaging/restore 轨道；RP7 索引可引用其证据路径，但不合并或关闭 Q03。 |
| **DL3**（verified） | 提供补测 `recommendedAt` 与闭环；DL11 在分配空档时补 earliest-allowed。 |
| **DL7**（verified） | 提供额度/对账/本地日归账基础；BC1 硬化契约一致性，TZ01 硬化日界跨模块解释。 |
| **P04a**（verified） | 日草案消费 `planDay`；DL11 落地后应自动受益，不作为阻塞 dependsOn。 |
| **B01**（verified） | **不动**。预算契约任务 id 仅为 **BC1**。 |
| **Q01/Q02/Q04**（planned） | 仍按 RP5→Q03 证据满足后再推进；本文件不改其 dependsOn。 |

**建议实现顺序:** RP5 收敛（他队）∥ 领域 DL11 → TZ01（共享日界）→ BC1（可与最新 SHA 失败族复现并行）；RP7 在可引用的 tip quality 运行出现后写入索引。
