# AIstudy Opening 程序整体样貌（全栈）评估与改进计划

**文档状态**：供审阅（非已批准实施合同）
**版本**：v2.3（2026-09-20）——在 v2.2 全栈样貌基础上**升维为系统演进蓝图**：新增第 13 节（Citation 长期身份 / 业务 Operation API / 可观测性与 SLO / 检索智能演进 / 安全基线补强），源自第四轮全栈深度研究报告并经源码交叉验证。修订记录见第 12 节
**工作区 / 分支**：`E:/Project/study-assistant-opening` · `feat/opening-release`（隔离基线 e7639c99）
**代码事实对应提交**：`40b3de6`（第 2/3/4/5 节全部 [V] 结论以此提交为准）
**本轮范围**：从「前端评估」扩展为**程序整体样貌（全栈）**——新增第 2 节架构分层与请求链路、第 3 节后端/数据/AI 层事实核查，前端结论并入其中
**产生方式**：只读源码核查 → 双模型交叉评审（GLM-5.3 / Kimi-K3）→ 三轮外部评审（未接触源码，核对公开文档）→ 对外部质疑逐条源码复核
**证据标记约定**：
[V] 本项目源码/文档直接核查（绑定 40b3de6）　[E] 外部评审提供、本文档仅转述的公开来源主张（未在本地复现，来源见附录 D）　[H] 设计建议　[T] 尚待验证　[C] 已发现冲突

> **给审阅者的说明**：本文档自包含。**第 2–3 节是程序整体样貌（全栈架构分层 + 端到端请求链路 + 后端/数据/AI 层事实）**，第 5 节为关键事实（含 F14），第 6–7 节为计划与创新（[H]），第 8–9 节为执行顺序与放行门槛，第 10 节为底线约束，第 11 节为决策项，第 12 节为评审采纳记录，**第 13 节为系统演进蓝图（首版之后的可观测性/检索智能/Citation 身份/扩规模判定矩阵）**。**首版边界仍以第 8 节为准；第 13 节的 R18 检索演进不作首版门槛。下一份最有价值的证据是第 8 节末尾的运行演示链路，而非第五轮评审。**

---

## 1. 项目概况

### 1.1 产品定位

AIstudy 当前处于「Opening 开学可用版」阶段：面向单一用户（大一学生）的个人学习助理，手机/电脑共用服务端 Web 应用。核心价值是**长期理解用户**（D），落地场景为课程学习（A）、计划执行（B）与大学生活（C）。

主导航为三个入口（已批准规格 `2026-09-12-opening-release-design.md`）：

```text
今天（恢复与开始）  ·  助理（材料辅导与交流）  ·  课程（长期上下文）
+ 收件箱（全局上传与待确认入口）
```

旧版「Learn / Explore / Library」工作台（2026-07 产品线）在 Opening 模式下由 middleware 重定向至 `/opening/today`，其领域逻辑（评估状态机、计划器、SRS）仍是可复用资产。

### 1.2 技术栈 [V]

| 层 | 选型 |
|---|---|
| 前端 | Next.js **15.5.21（锁文件确认）** · React 19.1.9 · TypeScript 5.8.3 · Tailwind CSS v4（@theme token）· lucide-react · BlockNote 0.52.1 |
| 契约 | Zod 4.0.17，`packages/contracts/src/opening/`，`.strict()` 模式 |
| 后端 | PostgreSQL + Drizzle · BullMQ/Redis worker · S3 兼容私有对象存储 · Next.js API 路由（模块化单体，独立 worker） |
| AI | 统一 provider 接口；付费调用默认关闭（`AI_DAILY_LIMIT_CENTS=0`）；fake adapter 仅用于测试 |
| 测试 | Vitest（unit/contract/integration/handler）· Playwright · 受保护独立测试库（`OPENING_TEST_DB=1`） |

**依赖安全注意** [E]：Next.js 官方 2026-08-25 安全公告列出的 15.5 维护线修复版本是 **15.5.24**（涉及 AVIF 图片优化与特定 Windows 托管场景）；**15.5.25** 是配合较新 `sharp` 重新启用 AVIF 优化的跟进版本，**二者性质不同，不得混称为「15.5.24/25 修复公告」**。锁文件确认当前为 15.5.21 [V]。「公告存在」「本项目受影响」「本项目已修复」是三个不同事实，R0 分别记录（G0）。

### 1.3 任务账本状态 [V]

`docs/superpowers/plans/opening-release/tasks.json` 共 37 项：**15 verified / 22 planned**。

- **verified（15）**：B00–B02 · F01–F03 · I01–I03 · T01–T03 · U01 · P01 · X01
- **planned（22）**：M01–M03 · L01–L03 · P02–P04 · U02–U04 · Q01–Q04 · C01–C03 · V01 · K01–K02

**边界提醒** [C]：`verified` 只证明任务列出的门禁通过；「已规划」不等于「已实现」。本项目尚未有 dev server 复现、用户访谈、真机与生产性能证据。

### 1.4 数据库迁移现状 [V]

已应用 0016–0022；其中 **0018 建有 `opening_jobs` / `opening_outbox` / `opening_budget_reservations` 持久化表**（与第 5 节 F11 直接相关）。当前工作区新增 0025（Opening Turn Intent Snapshot）；未来预留：0023（M02）· 0024（P02）· 0026（C01）· 0027（K01）· 0028（K02）。

---

## 2. 程序整体样貌（全栈）[V]

> 本节回答「这个程序长什么样、请求怎么流动」——不只前端。所有分层与链路均来自源码（commit 40b3de6）。

### 2.1 Monorepo 分层

| 包 / 应用 | 角色 | 关键内容 |
|---|---|---|
| `apps/web` | **BFF + UI**（Next.js 15 模块化单体） | `(opening)` 路由组 · `/api/opening/**` 20 个 API 路由（服务端 BFF）· `features/opening/**` 领域服务（tutor/sources/planning/learning/memory）· React UI |
| `apps/worker` | **异步执行器**（独立 Node 进程，BullMQ Worker） | `index.ts`（Worker 注册）· `jobs/`（处理器）· `parsers/`（材料解析）· `runtime/queue.ts`（队列） |
| `packages/contracts` | **共享契约**（Zod 4 `.strict()`） | `opening/{tutor, sources, planning, jobs, memory, learning, conversations, knowledge, capabilities...}` |
| `packages/database` | **持久化**（PostgreSQL + postgres.js + Drizzle） | `repositories/opening-*.ts`（约 15 个）· `migrations/0001–0024` · `storage/opening-s3.ts` |
| `packages/ai` | **AI 编排**（与 provider 解耦） | `opening/{context, citations, provider, usage, errors}.ts` · `providers/` · `roles.ts` |
| `packages/domain` `packages/ui` `packages/config` | 领域逻辑 / UI 原语 / 配置 | domain：legacy Learn/Explore/SRS 状态机；ui：`packages/ui/src/*` |

**依赖方向**：`apps/*` → `packages/{contracts, database, ai, domain, ui}`；`contracts` 被 web 与 worker 共享，是前后端唯一事实源。

### 2.2 一次提问的端到端链路（核心路径）

```text
浏览器 React（assistant-view）
  │  fetch POST /api/opening/conversations/{id}/turns  {conversationId, sourceIds, mode, text}
  ▼
[WEB 进程] Next.js API 路由 ── requireOpeningScope()（鉴权+workspace 作用域）
  │  tutor-service.ts  →  ① 写入 opening_turns（status=pending, 持久化）
  │                     ② 写入 opening_jobs（持久表，执行状态机）
  │                     ③ 写 opening_outbox → 触发 BullMQ 入队
  ▼
[REDIS] BullMQ 队列（瞬态调度；job 可被清理——业务状态不依赖它 [F11]）
  ▼
[WORKER 进程] apps/worker Worker 消费
  │  context.ts 组装上下文（会话历史 + 选中的 chunks + 记忆）
  │  budget 校验（dailyCapCents=0 时拒绝）→ provider.ts 调模型
  │  usage.ts 计费 → citations.ts 抽取引用
  │  → 回复写入 opening_turns（status=complete）+ opening_jobs 更新
  ▼
浏览器轮询 GET /api/opening/jobs/[id]（读 opening_jobs 持久表）
  → 完成后 GET turns 取回已持久化回复
```

**为什么这个分层对 R5 至关重要**：业务真相（轮次、回复、job 状态）全部落在 **PostgreSQL 持久表**（`opening_turns` / `opening_jobs` / `opening_outbox`），Redis 队列只是调度瞬态——这正是「队列清理后结果仍可恢复」[F11] 的架构基础。

### 2.3 后端 / 数据 / AI 层事实核查（本轮新增）

**鉴权与作用域**：每个 API 路由经 `requireOpeningScope(request)` → `requirePrincipal`（会话鉴权）→ 派生 `{workspaceId, ownerUserId}` 作用域；所有仓库 SQL 都带 `workspace_id = ${scope.workspaceId}` 过滤。**跨用户数据隔离在 SQL 层强制** [V]。

**幂等与并发**：
- `completeUpload` 幂等（重放测试 [V: F4]）；
- `replaceChunks` 在事务内 `FOR UPDATE` 锁源行 + 校验 `version` 未变，再 DELETE+INSERT chunk [V]——解析期间的并发更新被显式拒绝（`CONFLICT: source version changed during parse`）；
- `opening_jobs` / `opening_outbox` / `opening_budget_reservations` 持久表支撑「至少一次执行 + 业务幂等键」模式。

**AI 层**：`provider.ts` 统一 provider 接口（`createOpeningProvider({baseUrl, apiKey, model})`）；**预算闸门**：`dailyCapCents > 0` 且 `apiKey` 存在才创建真实 provider，否则 fake/拒绝 [V: apps/worker/src/index.ts:63]——付费调用默认关闭，与 1.2 一致。`citations.ts` 从回复抽取 `Citation`（含 `chunkId/sourceId/sourceVersion` [F6]）。

**解析器**：`apps/worker/src/parsers/` 按 MIME 分派（PDF 物理页 / PPTX slideLabel / 音视频 startMs-endMs [F6/RU-03]），产出 chunk 写入 `opening_source_chunks`。

### 2.4 数据模型核心表（0020/0022 等迁移）

| 表 | 关键约束 | 对引用/恢复的意义 |
|---|---|---|
| `opening_sources` | `version` 递增，`upload_state`/`parse_state` 状态机 | 版本化源头；对象键 `opening/sources/{id}/v{version}` [F12] |
| `opening_source_chunks` | `UNIQUE(source_id, source_version, page)`；`chunk.id = gen_random_uuid()` | **chunk ID 每次解析全新生成**（见 F14） |
| `opening_turns` | `status: pending/complete/failed/outcome_unknown` | 恢复权威数据（历史结果）[F9/F11] |
| `opening_jobs` | 持久执行状态机 | 恢复过程解释依据 [F11] |
| `opening_memory` + `opening_privacy` | privacy epoch | 删除写回拦截（但不阻止重新提取，见创新三） |

---

## 3. 前端现状 [V]

### 2.1 已实现

| 路由 | 状态 | 说明 |
|---|---|---|
| `/opening/today` | 静态占位 | 仅空状态文案，未连接任何 API |
| `/opening/assistant` | M1 薄聊天 | 会话发现/创建/恢复、材料勾选、物理页码输入、上传条、消息列表、引用纯文本；提交后仅刷新一次 |
| `/opening/courses`（+`[id]`） | 复用旧组件 | legacy 深色 token，与浅色壳层冲突；内链指向被重定向的 `/learn/*`（死链） |
| OpeningShell | verified（U01） | 桌面侧栏 + 移动三项目底栏；上传按钮侧栏与顶栏各渲染一次 |
| `/api/opening/**` | 20 个路由 | today · plans(+accept/reject) · tasks · timetable · jobs/[id] · sources(+complete/download/staging) · conversations(+resume/turns) · turns · memory(+decision) · observations · learning-sessions · retests · candidates |
| 旧工作台 | 被 redirect | `/learn` `/explore` `/preview*` → `/opening/today` |

### 2.2 视觉系统现状 [C]

三套视觉语言并存：① `globals.css` 全局深色（body 背景+前景）；② Opening Shell/助理组件浅色 zinc/white 硬编码（8 个文件）；③ 旧 features 与 `packages/ui` 深色 @theme token（30+ 文件引用）。结果：浅壳包深内容、前景色冲突、跨页不一致。

---

## 4. 核心问题清单 [V]

| 编号 | 问题 | 证据 |
|---|---|---|
| P-A | 主题三分裂（见 2.2） | `globals.css:3`；`opening-shell.tsx:15`；`course-detail.tsx` |
| P-B | Today 静态空状态，未连接已存在的 today/plans/tasks/sources API | `today/page.tsx` |
| P-C | 助理强制先选材料；模式显示英文枚举；提交后无 job 轮询、pending 需手动刷新 | `assistant-view.tsx:104`；`composer.tsx:58`；`assistant-view.tsx:37,52` |
| P-D | 上传：全量 `arrayBuffer()` 入内存；`fetch` PUT 无进度；未知 MIME 静默 fallback `application/pdf`；`beginUpload` 无去重 | `upload-strip.tsx:26,43,56`；`source-service.ts:21` |
| P-E | 课程详情内链死链（`/learn/*` 被重定向）；Shell 显示「当前课程：{URL uuid}」；CaptureLink 重复；助理页嵌套 `<main>` | `course-detail.tsx:64` 一带；`opening-shell.tsx:11,26` |
| P-F | 规格-实现漂移（5 处，见第 5 节末） | `interfaces.md` vs 实现 |
| P-G | 开发环境构建阻断（历史记录）：`/opening/*` 曾 HTTP 500 `node:crypto UnhandledSchemeError`，未复现未定位 | `UIUX-RESEARCH-EVIDENCE.md:106-115` |
| P-H | Composer 未处理中文输入法 composition，选词确认 Enter 会误发送 | `composer.tsx` |
| P-I | 时区缺陷：today 要求客户端传 `date`，无服务端「今天」推导；`timeConfig.timeZone` 已存在但未被消费。**修正**：`toISOString()` 固定取 UTC [V]，对中国（UTC+8）用户的错误窗口是**本地凌晨 00:00–08:00 显示「昨天」**（v1.0「晚间明天」的方向描述错误）；负时区用户才会在晚间遇到「明天」 | `today/route.ts`；`planning.ts:110` |
| P-J | 依赖安全：Next.js 锁定 15.5.21；官方 15.5 维护线有修复版本 15.5.24（详见 1.2） | 锁文件 [V]；官方公告 [E] |

---

## 5. 关键事实 [V]（v2.1 增补 F11/F12，v2.2 增补 F14）

双模型评审 + 两轮外部评审质疑后逐条源码复核（绑定 commit `40b3de6`）：

| # | 事实 | 影响 |
|---|---|---|
| F1 | `GET /api/opening/today` 必须带 `date` 参数（缺省 422），返回 `{date, acceptedVersion, blocks, hardBlocks}`，不是 `interfaces.md:236` 的 `PlanDraft\|null` | Today 客户端按实际返回写 zod；登记规格偏差 |
| F2（v2.1 再修订） | `POST /api/opening/plans`（propose）返回 **201 + 完整 PlanDraft**（含 `id`/`version`/`baseVersion`）。**同一会话内 propose→accept 可以走通，且无新后端依赖** [V]。缺失的是**跨会话/跨设备恢复**：无任何「按状态查询 draft」的路由。**注意：客户端持久化 propose 响应最多解决同一浏览器的恢复，不能兑现跨设备承诺**——跨设备必须存在服务端可发现、可授权读取的草稿记录（实现方式不限于新增独立路由，可扩展现有路由） | R2b 定稿为两步：同会话闭环（先行，无 P02/P03 硬依赖）→ 跨设备恢复（需服务端草稿发现，见 D14 之外的新实现决策） |
| F3 | `GET /api/opening/jobs/[id]` 返回 `{id, status, error:{message}\|null, updatedAt}`，与 9 字段 `jobRecordSchema` 不一致 | 面向 UI 的公开响应不必等于内部记录：定义**共享严格 `JobStatusResponse`**（仅 UI 所需字段）；前端禁用 `jobRecordSchema.parse`；内部错误与可展示错误分离 [E: OWASP] |
| F4 | `completeUpload` 服务端已幂等（`source-service.ts:23` + 重放测试）；重复建 source 的根因是 `beginUpload` 每次调用必 `sources.create` | 两个问题分开：①「同一次上传点击的重试」→ 操作级幂等；②「不同时间上传相同内容」→ 内容级去重，客户端 hash 仅作线索，不能跳过服务端授权与内容校验 |
| F5 | `turnInputSchema.sourceIds` 无 `.min(1)`（`tutor.ts:22`）；服务端全链路接受空来源 | R4a 唯一阻断点在前端一行 if；**空来源 ≠ 无上下文**：若系统仍注入课程/记忆，界面须如实说明 |
| F6 | `Citation` 契约含 `chunkId/sourceId/sourceVersion/label`；`message-model.ts` 视图层丢弃了它们 | R6a 把完整 citation 传到视图层 |
| F7 | `getDownloadUrl` 返回 `attachment` disposition；parseState=failed 时 uploadState 仍为 uploaded，原件可看 ✓ | 「新标签打开」不会自动变成预览 [E: MDN]——第一版交互按「查看引用信息 + 下载原件」验收 |
| F8 | `sourceMimeSchema` 支持 video/mp4、video/webm、message/rfc822；V01（音视频理解）未 verified | **发布规则：可选格式 = 契约允许 ∩ 服务端当前启用 ∩ 对应处理链路已验收**；仅保存不解析的格式必须上传前告知。`File.type` 为空 ≠ 非法文件 [E: MDN]——前端只做预检查，服务端验内容 |
| F9 | `TurnRecord.status` 含 `pending/complete/failed/outcome_unknown`，`listTurns` 返回完整轮次；Tutor job 另有 `queued/running/succeeded/failed/cancelled/outcome_unknown` 状态 | 重开会话可从服务端读到未完成轮次；结果未知必须与确定失败分开呈现，并与 Tutor job 状态关联 |
| F10 | 锁文件确认 `next: 15.5.21` | R0 安全切片（G0）；升级限于 15.5 维护线 |
| **F11（v2.1 修订）** | `GET /api/opening/jobs/[id]` 当前读取的是 Tutor 专用 PostgreSQL 持久表 **`opening_tutor_jobs`**（0017 迁移）；通用 `opening_jobs`/`opening_outbox`（0018）服务 parse/retest/remind 等后台任务，二者不是同一条链路，也不是 Redis 记录 | 队列记录清理不会抹除业务状态，但恢复测试必须分别覆盖 Tutor 与通用后台任务。Tutor 恢复权威数据为 `opening_turns` + `opening_tutor_jobs`；通用后台任务为 `opening_jobs` + `opening_outbox` |
| **F12（v2.1 新增）** | 存储对象键**已按版本寻址**：`opening/sources/{sourceId}/v{version}`（`opening-s3.ts` 的 `n()`），新版本上传**不会覆盖旧版本对象**；但 `getDownloadUrl` **硬编码取当前版本**（`storage.finalKey(id, source.version)`），下载路径未参数化被引版本 | 「有 sourceVersion」与「能取得那个版本的原件」之间隔着一个精确小缺口：R6a 需给下载通路加服务端校验的版本参数，或明确降级为「无法核验旧引用」。**「同一文件重新解析是否改变 chunk ID/定位」已在本轮闭合 → 见 F14（会改变）** |

| **F14（v2.1 本轮新增，闭合遗留 [T]）** | `opening_source_chunks` 的 `UNIQUE(source_id, source_version, page)` 约束 + `replaceChunks` 在事务内**先 DELETE 该版本全部旧 chunk 再 INSERT**（新 `chunk.id` 用 `gen_random_uuid()` 生成）→ **同一 source_version 重新解析会改变 chunk.id 与定位**，且 citation 里的旧 `chunkId` 会失效 | 引用长期可核验的**真实架构约束**：chunk.id 不稳定（非内容哈希）。R6a 的「下载对应版本原件」可用 `source_version` 闭合（版本字节保留 [F12]），但「定位到旧 chunk」在重解析后**不可保证**——v1/v2 测试必须覆盖「重新解析同一版本」场景，并在 citation 失效时降级为「版本原件仍可下载，但精确位置无法重建」 |

**规格-实现漂移登记（P-F，5 处）**：① today 返回形状；② jobs/[id] 返回形状；③ `sources/[id]/link-course` 规划未实现；④ `POST /api/opening/ephemeral` 规划未实现；⑤ `GET /api/opening/courses/[id]/learning` 规划未实现。

---

## 6. 改进计划（v2.1 定稿版）

> 执行顺序见第 8 节 G0–G5 退出条件表。**v2.1 明确首版边界**（见第 8 节末）与「能力启用后适用」的验收分层（见第 9 节）。

### G0 —— 安全与可验证基线

**R0 · 依赖安全核查与升级**
- 四项证据分别记录：① 官方公告及其修复边界（15.5.24 修复；15.5.25 为 AVIF 跟进，性质不同 [E]）；② 实际 next / sharp 锁定版本；③ 实际部署环境与受影响条件（Windows 漏洞有 Pages/App Router 混用等前置 [E]）；④ 升级后回归结果
- 约束：安全补丁不与主题重构、大版本迁移同 PR

**R11 · 复现并修复开发环境构建阻断**
- `next dev` 复现 → import trace → 二分（嫌疑：`features/opening/runtime.ts` 引 database 被客户端链拉入；修复方向 `server-only` 或斩断引用）→ 回写证据文档
- 验收：两条路由 200 渲染；`next build` 通过

**R15 · 请求体大小防线**（三层，G0 级）
- 入口层限制（提前拒绝明显超限）+ 应用层实际读取字节上限（chunked 无 Content-Length [E: RFC 9112]）+ 业务字段限制；超限 413；**必须测试无 Content-Length 头的请求** [E: OWASP]

**R10-min / R14-min · 最小契约清单与对账**
- 每次改接口同步补契约、错误语义与测试；P-F 五处偏差登记（附录 D 精确化同步完成）

### G1 —— 可靠提问与恢复

**R4a + R13 + R16（同一验收切片）· 可正常提问**
- 无材料可发送（删 `assistant-view.tsx:104` 强制判断；上下文呈现「自由交流 / 已选材料：…」）
- 中文选词 Enter 不误发：`compositionstart/end` + `isComposing` 结合，目标浏览器实测 [E: MDN]；换行行为明确
- 模式中文化：hint=给一点提示 · explain=完整解释 · listen=先听我说 · think_together=一起想办法
- 服务端接受空来源 [V: F5]；回复不声称阅读了不存在的材料；若上下文不止对话本身，界面如实说明

**R5 · 可恢复的操作生命周期**（v2.1 定稿五要素）

**① 恢复的权威数据**（定稿）：
```text
用户提交的轮次（opening_turns，含 pending 状态 [V: F9]）
→ 持久化的业务操作记录与执行状态（opening_jobs 持久表 [V: F11]，非 Redis）
→ 一次或多次执行尝试
→ 已落库的最终回复（恢复依据；队列状态仅用于解释过程）
```
队列层 ID 防重不承担长期业务幂等（BullMQ job 可被清理 [E]）——业务幂等由 `clientKey` 与持久表约束承担。

**② clientKey 绑定完整意图**：同一意图 = 会话 + 材料选择（含需固定的材料版本）+ 辅导模式 + 问题文本。同一句「解释一下」选不同材料不是同一请求；服务端已接收、客户端未收到响应时刷新页面不得产生新业务操作。同 key 不同参数明确冲突 [E: AWS 幂等 API 设计]。

**③ 结果不确定的退出策略**（`outcome_unknown` 必须可结束，不无限「正在同步」）：
- 能回查已有结果记录时：核对原调用与已落库轮次，不重新生成（若轮次已 complete [V: F9]，直接展示）
- 无法回查时：停止高频轮询，保留「结果无法确认」，允许用户离开；用户明确选择重新生成 = **新尝试**（新 clientKey、预算校验、明示可能重复执行或产生额外费用）
- 禁止超时自动改名为「失败」；`error: null` 只是没有错误信息；404 不得未经判断等同失败

**④ 任务状态 × 网络状态分离**（v2.0 表格保留：已提交/正在处理可离开、断网不自动重生成、unknown 不伪装失败、成功未同步则重读结果、失败按类型决定能否安全重试）

**⑤ 故障注入验收**（四个场景，比十种 loading 文案更能证明完成）：

| 人为故障点 | 应证明的行为 |
|---|---|
| 服务端已接受请求，响应未到达浏览器 | 重试/恢复找到原轮次，不新建重复轮次 |
| provider 可能已完成，worker 落库前退出 | 进入可解释的不确定状态，不盲目再次调用 |
| 回复已落库，队列未记录完成 | 恢复时仍可取得回复，不因队列状态重复生成 |
| 队列记录清理后重开会话 | 已保存结果仍可读取；未解决操作有明确解释 |

- 实现约束：单一在途轮询；前台/网络恢复时立即校准；暂不引入 SSE/WebSocket/新状态框架
- **最小可观测性** [H]：记录业务关联标识、执行尝试次数、状态转换、时间、可展示错误码、费用状态；**默认不记录完整对话、材料正文、签名 URL** [E: OWASP Logging]——同一份日志服务「恢复为什么失败」与「隐私数据去了哪里」

**R12 · 修复课程详情 legacy 死链**；**R9a · 修复「当前课程：{uuid}」**（并行小阻塞）

### G2 —— Today 恢复入口（含基础恢复卡）

**R2a · Today = 恢复入口**
- 首屏优先级：**需要用户处理的阻塞事项 → 继续上次 → 下一项已接受安排 → 其他资料信息**
- 「继续上次」保留课程、材料版本、阅读位置与用户最后确认的下一步
- 按 F1 实际返回写客户端；四档空状态（新用户/有材料无计划/服务失败/未登录·会话过期）
- 「待确认材料数」暂不上首屏（link-course 未实现，首页不得出现无法兑现的承诺）；可改为「解析失败 n 份」等真实可处理状态
- 时区：「今天」权威来源 = 用户 IANA 时区（`timeConfig.timeZone` 消费化 [V]）；验收含中国凌晨、负时区晚间、跨午夜、夏令时边界
- 计划语义：提议/接受/执行/重排是四件事；接受不自动获得任意修改未来日程的权限；重排显示差异并遵守 `hardBlocks`

**R2c（v2.1 新增）· 基础恢复卡（创新一最小版，归入 G2 而非 G5）**
- 呈现：上次停在（课程/材料/位置）+ 当时留下的问题 + 用户确认过的下一步 + [继续] [查看原材料]
- 第一版只依赖：已保存会话 + 材料定位 + 用户明确确认的「下一步」；**不依赖完整记忆系统，不等待 G4 视觉治理**
- 收尾轻动作（离开前形成线索，非每次弹窗强制确认）：一轮学习结束处附「下次从这里继续：……　[保存这一步] [修改]」，不处理可直接离开
- 约束：系统总结必须有来源；无证据不写「你已经理解」；临时对话不生成持久恢复卡；来源删除/版本失效时不偷偷恢复旧内容
- 三个可直接检验的目标：恢复内容有明确来源；不因重复生成改变原意；**provider 不可用时仍能恢复到这一步**
- 验证：打开应用到实际恢复学习的操作数与耗时 + 用户确认「这是不是你想继续的」；若不够，定位缺的是材料位置、题目条件还是下一步本身

### G3 —— 可信材料闭环（范围定稿）

**G3 退出条件（v2.1 定稿）**：
1. R8-pre + 上传阶段一（可靠上传）+ 阶段二（操作幂等）
2. **资料列表交付**：上传结束后关闭页面，再从全局资料入口进入，仍能找到该资料、看到其真实处理状态，并取得原件（路由名不必是旧版 `/opening/inbox`，但这条用户旅程不能消失）
3. R6a（含版本语义，见下）

**明确不作为 G3 退出条件**：内容级去重（阶段三）、大文件优化、复杂页内查看器——分别在对应条件满足后交付。

**上传阶段一（可靠上传）**：XHR 直接发 Blob（不必先 `arrayBuffer()` [E: MDN]，但验证 staging/代理/SDK 是否整文件缓冲）；真实字节进度；状态机 `上传字节中 → 传输完成 → 服务端确认 → 解析中 → 可使用`；**上传 100% ≠ 材料可用于辅导**；MIME 静默 fallback 删除，`accept` 按 F8 发布规则；`crypto.subtle.digest()` 不支持流式 [E: MDN]，hash 策略实测；「512MB 必 OOM」修正为「高峰内存风险，实测或限制发布范围」

**上传阶段二（操作幂等）**：`beginUpload` 解决「同一次点击重试创建多个 source」（F4）；签名过期按实际存储验收（S3 请求开始时检查过期 [E: AWS]，本项目是「S3 兼容」，不假设行为相同）

**R6a（版本语义定稿）**：
- 点击引用 → 至少看到资料名称、**引用版本**、定位信息，并可下载原件
- **存储层已按版本寻址 [V: F12]**：给下载通路增加服务端校验的版本参数（`sourceId + version` → 校验该版本对象存在且未失效），或明确降级文案「无法核验原引用」——**两选一，禁止悄悄打开最新版**
- **chunk ID 不稳定（已闭合 [V: F14]）**：同一 `source_version` 重新解析会 DELETE 旧 chunk 并生成全新 UUID → 旧 citation 的 `chunkId` 失效。**「下载对应版本原件」可靠（版本字节保留），「定位到旧 chunk」在重解析后不可保证**——citation 定位失效时降级为「版本原件仍可下载，精确位置无法重建」，不得静默跳到新版本位置
- 直接测试：**回答引用 v1 后上传 v2，再点击原回答中的引用**；另加**同一版本重新解析后点击旧引用**两个场景
- 三层区分：有引用 ≠ 位置正确 ≠ 内容支持结论；建立少量人工核对样例集（物理页码 / PPT 标签 / 版本更新 / 无支持材料）

### G4 —— 完整视觉与移动体验

**R1（两层）**：基础可读性修复可提前；完整治理（保留 @theme token 名 + CSS 变量覆盖 + `@theme inline` [E: Tailwind]；globals.css 作用域化；弹层/编辑器/移动键盘/焦点不遮挡均在检查范围 [E: WCAG]）；触控 44px 为产品目标，规范表述用 WCAG 2.2 AA 24px 最低值 [E: W3C]；默认明暗见 D1
**R9b/R9c** · 侧栏独立工具区（不改 `openingNavigation()` 三项契约）· CaptureLink 去重 · 嵌套 `<main>` 修复 · 移动顶栏按断点组织
**R7a** · 课程页签壳（概览/材料与笔记）

### G5 —— 价值增强切片（每项以真实可用契约为前置）

**R2b** · 计划闭环定稿两步：① 同会话 propose→accept 先行（路由已存在 [V: F2]，**P03（提醒）不是必要前置** [H]；P02 账本门禁验证的 409/幂等语义在依赖其行为前先跑其测试）；② 跨设备恢复 = 服务端草稿发现记录（实现方式：扩展现有路由或新增，进入 R2b 时决策）
**R4b** · ephemeral「这次不保存」：覆盖会话库之外全部路径（队列载荷、日志、缓存、衍生记忆）；不承诺第三方零留存
**R7b** · 学习记录/知识结构页签：依赖 L01/L02/K01 verified
**R6b** · 页内查看器：按版本授权的流式/短时访问优先；blob 仅限经验证小文件；上传文件不因「来自用户」视为安全 [E: OWASP]
**删除语义发布**（新，见第 7 节创新三与 D14）

### 明确不做（防止范围蔓延）

掌握率仪表盘 / 假进度 / 打卡 / 负罪感文案；首屏知识图谱、复杂趋势图；assistant-ui / TanStack Query / 新 UI 套件；全量重写 legacy；没有可用功能的纯视觉占位入口；**以及第 8 节首版边界之外的所有项**。

---

## 7. 价值创新方向（五项，v2.1 深化为可测实验）

> [H] 差异化设计建议。**重点已从「吸收建议」转向「决定哪些这轮不做」**：前两项优先，四、五按依赖排后。

### 创新一：学习恢复卡 + 本轮上下文记录（基础版已归入 G2 / R2c）

恢复卡呈现与约束见 R2c。**延伸实验——本轮上下文可检查记录**：

```text
本轮上下文
高等数学 · 讲义 v3，第 8–9 页 · 已确认偏好 1 条
查看详情   调整下一轮
```

- 关键区分：发送前显示「**计划使用**」；执行后显示「**实际送入模型的上下文记录**」（引用与版本）；不把「已选资料」「实际检索到的」「最终被引用的」混为一谈，不声称知道模型内部依赖
- 最小实现只记录现有调用边界中的引用与版本，不复制材料、不新增模型调用
- 验证：故意选错课程 → 用户排除 → 核查下一轮请求确实不携带该课程上下文（比问「你觉得透明吗」直接）；同时是减少跨课程记忆误用的实用入口

### 创新二：证据型微学习闭环（帮助阶梯可递减，不是每轮自动出题）

```text
先独立尝试 → 需要时给一个提示 → 再需要时展示关键一步 → 最后才展开完整解释
```

- **不强制走完阶梯**：用户选「完整解释」就直接解释；选「先听我说」不突然插入测验——学习实验必须尊重现有辅导模式
- 保存的是「这次尝试前展示过哪些帮助；在什么条件下完成；下次独立尝试表现如何」——**记录给过哪些帮助，不推断用户脑中依赖了多少**
- 依据：检索练习研究 [E: PubMed 21252317]；无护栏 GPT 损害撤除后表现的实验 [E: PubMed 40560616]；教学设计 RCT 报告积极效果 [E: Harvard SERL]——提示阶梯本身是**本项目的待测假设**，不是已证结论
- 依赖：L01/L02 窄切片；验证用同类新题，区分未展示答案前的尝试与看过解释后的完成

### 创新三：可纠正、有期限的记忆 + 删除语义定稿

每条记忆最少区分：内容 / 来源 / 用户确认状态 / 适用范围 / 有效期限；呈现为可操作条目。临时困难、一次情绪表达、模型推断不直接变成长期人格结论。

**v2.1 新增——删除语义必须在发布前选定**（三个不同承诺）：
- 仅删除当前记忆条目；
- 不再从指定旧来源自动重建这条记忆（需保留最小来源排除信息并在后续提取时检查；不为实现删除把完整敏感内容复制进永久日志）；
- 连同来源对话或资料一起删除。

**两个独立验收场景**（并发控制正确也可能只覆盖第一个）：
1. 删除时旧 worker 被 privacy epoch 阻止，不写回（已有机制）
2. **删除后，新 worker 用新 epoch 重读仍保存的对话，不得重新提取出相同记忆**（privacy epoch 不自动阻止「新任务重新推断」[T]——这是删除的产品语义问题，不是并发问题）

依赖：M01/M02；不绕过隐私任务先做可编辑面板。验证：设置一条可纠正的错误偏好 → 修改后建议真正变化 → 删除后不再出现。

### 创新四：可协商的「最小计划」

「今天只剩 25 分钟，要保留哪一件？」→ 建议保留 / 可以顺延 / [接受这个调整] [修改]。重排呈现简短差异；不动 `hardBlocks`；拒绝后不换措辞施压。
- 依赖：P02（同会话先行已无硬依赖，见 R2b）；P03/P04 是否前置已重新核对（见 R2b 定稿）
- 验证：**「计划接受与实际开始之间出现断点，原因待核查」**（v2.1 修正：不再写「= 建议不现实」——可能是计划不现实、临时事务、入口难找，或线下已做而系统未记录，不能从一个行为指标推断原因）

### 创新五：可执行的能力清单（服务端强制，不只控制按钮）

共享定义：是否启用 / 输入与上限 / 写入哪些数据 / 可展示状态 / 重试条件 / 验收证据。驱动上传格式、按钮可见性、禁用原因与契约测试。
- **v2.1 底线：能力关闭必须在服务端生效；前端隐藏入口不是关闭能力** [E: OWASP 逐端点访问控制]
- 区分三个标志，不用一个布尔值含混表示：这版是否发布 / 当前用户是否允许 / 当前是否因预算或运行状态不可用
- 验证：切换能力配置后，界面入口、服务端拒绝语义、自动化测试保持一致

---

## 8. 执行顺序（v2.1 定稿：按退出条件组织）

| 阶段 | 纳入任务 | 核心交付与退出条件 |
|---|---|---|
| **G0 安全与可验证基线** | R0、R11、R15、R10/R14-min | 构建问题确认存在与否；构建路径可验证；请求大小防线与依赖安全四项证据；最小契约清单 |
| **G1 可靠提问与恢复** | R4a+R13+R16 切片、R5 五要素、**R17 最小可观测性（OTel trace 贯穿 Web→Worker→AI）**；并行 R12、R9a | 中文不误发；无材料可交流；**四个故障注入场景通过**；刷新/离开/断网/换设备可找回原操作；不盲目重复模型调用；**ask 链路可被一个 trace_id 串联** |
| **G2 Today 恢复入口** | R2a、时区修复、**R2c 基础恢复卡**、可选 R7a | 打开应用可明确继续什么；恢复卡有来源、不重复生成、provider 不可用仍可恢复；「今天」跨设备一致 |
| **G3 可信材料闭环** | R8-pre、上传阶段一+二、资料列表与全局入口、R6a（版本语义） | 上传不重复建记录；处理阶段可信；**关闭页面后能从资料入口找回资料与原件**；引用对应正确版本（v1/v2 测试通过）；不支持的能力提前说明 |
| **G4 完整视觉与移动体验** | R1 两层、R9b/R9c、页面细节 | 统一主题与弹层；各断点入口清晰；移动输入、焦点、触控可用 |
| **G5 价值增强切片** | R2b 两步、R4b、R6b、R7b、创新二~五切片、删除语义发布、**R6a-CitationIdentity 稳定身份（13.2）**、**R18 检索 gold set（13.5，后续再排 hybrid/rerank）** | 每项以真实可用契约为前置 |

**首版放行边界（v2.1 定稿）**：

> **可靠提问与恢复 + Today 基础恢复入口 + 已验收格式的可靠上传和资料列表 + 可信引用访问 + 基础移动可用性。**

完整双主题、内容级去重、大文件优化、复杂查看器、完整记忆面板、知识结构——分别在对应条件满足后交付，不捆绑成一个庞大的 Opening 放行包。

流程纪律（v2.0 保留）：① R10/R14 贯穿每个切片；② verified 定义不变，**另附证据类型标签**（代码检查/自动化/浏览器/真机/真实模型）；③ 2C2G 资源限制下一次推进一个完整闭环，重验证串行。

**首个运行证据（G0/G1 期间产出，优先于任何后续评审）** [T]：

> 中文输入一个问题 → 服务端接收 → 中途断网或关闭页面 → 重新进入后找回原轮次 → 得到一次已持久化的回复 → 引用仍指向准确版本。

---

## 9. 首版放行验收（v2.1 定稿：分「始终适用」与「能力启用后适用」）

**始终适用（未发布能力记「不适用」，不能记「通过」）**：

| 场景 | 必须证明 |
|---|---|
| 中文连续输入与选词 | 候选词确认不发送；换行与发送行为一致 |
| 提问后刷新、关闭、换设备 | 原轮次可恢复；不重复创建业务操作（含四个故障注入场景） |
| provider 超时或结果未知 | 不伪装成确定失败；不盲目重发付费请求；unknown 有退出策略 |
| 上传断网、重复点击、签名失效 | 能恢复或清楚失败；不产生难以解释的重复资料 |
| 上传后关闭页面再进入 | 从资料入口可找回资料、真实状态、原件 |
| 引用资料更新/删除/无权限；v1 引用遇 v2 上传 | 不偷偷打开最新版；不能核验时明确说明 |
| AI 预算为零 | 明确显示未启用/受限；不用 fake 回复伪装成功 |
| 手机键盘弹出与页面缩放 | 输入区、发送按钮、当前焦点仍可操作 |
| 跨用户越权（负向） | 用户 A 的 sourceId/turnId/citation 配用户 B 会话 → 403/404；旧签名 URL 过期；已删除来源的引用明确失效（13.6） |

**能力启用后适用（对应能力 verified 前记「不适用」）**：

| 场景 | 必须证明 |
|---|---|
| 删除记忆时 worker 仍在执行 | 旧记忆不重新进入有效读模型（epoch） |
| 删除后新 worker 重读旧对话 | 不重新提取出相同记忆（删除语义，见第 7 节创新三/D14） |
| 长期记忆面板 | 修改后建议真正变化；删除后不再被引用 |
| 「这次不保存」 | 队列/日志/缓存/衍生记忆全路径不落盘 |

- Playwright 属浏览器仿真 [E: Playwright]；真实手机输入法、软键盘、大文件须人工验收；性能参考 CWV p75 阈值 [E: web.dev]，单用户阶段不得伪装统计结论
- 真实学习价值另做小规模使用验证：相近难度新任务、恢复时间、独立完成与延迟表现；不用聊天次数/打开天数代替学习效果

---

## 10. 底线约束

**AI 可用性与预算不能被「假成功」覆盖。** 双证据线：确定性工程验证（fake adapter）与受控真实验证（授权预算内；未做就标待验证）。界面区分「未启用 / 预算限制 / 服务错误 / 结果不确定」。

**隐私与提示注入防线不等待完整记忆功能。** 一旦保存真实对话与资料：明确保存范围、删除行为、日志边界、模型可执行操作。资料不能自行触发计划接受、记忆写入或连接授权；这些变更走确定性服务端校验与明确用户动作 [E: OWASP LLM]。

**可观测性不成为第二份用户内容库** [H]：日志记录关联标识、尝试次数、状态转换、可展示错误码、费用状态；默认不含完整对话、材料正文、签名 URL [E: OWASP Logging]。

**能力关闭在服务端生效**：前端隐藏不是关闭（见创新五）。

---

## 11. 需要审阅者决策的问题（v2.1）

| # | 决策 | 建议默认值（[H]） |
|---|---|---|
| D1 | 默认明暗主题 | 首次跟随系统，允许覆盖并保持；先统一 token，不阻塞闭环 |
| D2 | 「资料与笔记」定位 | 独立工具入口，不升第四主导航 |
| D3 | 首页第一画面 | 「继续上次」优先；阻塞事项置顶；不默认每次生成新计划 |
| D4 | jobs 返回形状 | 共享严格 `JobStatusResponse`（内部 JobRecord 不直接暴露；错误不泄露内部实现） |
| D6 | 页内原件查看器通路 | 按版本授权的流式/短时访问优先；blob 仅限经验证小文件 |
| D7 | 移动入口 | 底栏三入口；顶栏一个主上传动作；按断点组织避免重复 |
| D8 | 错误语义展示 | 分离执行/网络/错误详情；unknown 提供「检查结果」+ 显式「重新生成」（新尝试、预算校验、明示费用风险，见 R5-③） |
| D9 | 时区权威来源 | 用户 IANA 时区（服务端 `timeConfig.timeZone` 消费化） |
| D10 | 首版格式与大小 | 按「契约 ∩ 启用 ∩ 链路验收」发布；仅保存不解析的格式上传前告知 |
| D11 | 真实模型验收方式 | 授权预算内小规模受控验证；未执行保持 blocked |
| D12 | 暂不发布的隐私能力清单 | 长期记忆面板等在 M01/M02 verified 前不发布 |
| D13 | 依赖安全公告跟踪 | G0 一次性核查（15.5.24 修复 + 15.5.25 AVIF 跟进，性质分开记录 [E]）；是否建立定期跟踪另行决定 |
| **D14（v2.1 新增）** | 删除语义 | 首版选定三选一（仅删条目 / 禁止旧来源重建 / 连来源删除），如实说明；「不再重建」需最小来源排除信息 |
| **D15（v2.1 新增）** | 跨设备草稿恢复实现 | 扩展现有路由按状态查 draft，或新增最小发现路由——进入 R2b 第二步时定 |
| **D16（v2.3 新增）** | Citation 长期身份迁移 | 采纳 13.2 CitationIdentity（locator+contentHash，chunkId 降级）；迁移采 expand/contract 不覆盖旧数据 |
| **D17（v2.3 新增）** | 可观测性栈选型 | OTel + 自建（Grafana/Prometheus）或托管（Sentry/Datadog 等）——G1 R17 实施前定，默认最小自建 |

---

## 12. 评审方法学与采纳记录

### 11.1 三轮过程 [V]

1. **初版建议（R1–R11）**：主会话只读代码审阅，任务书 `.tmp/frontend-recommendations-2026-09-20.md`。
2. **双模型交叉评审**：`.pi/agents/glm-reviewer.md`（lant/glm-5.3）与 `.pi/agents/k3-reviewer.md`（lant/kimi-k3），只读工具集，独立核查。关键分歧点独立一致。
3. **外部评审第一轮**：纠正 v1.0 两处关键判断（F2 前身、时区方向），引入 G0–G5 闭环组织、五项创新、双证据线。
4. **外部评审第二轮（本版输入）**：定稿范围与依赖，指出 v2.0 五处内部冲突、R5 缺「恢复权威数据」层、两个新 [T] 契约问题（引用版本可取得性、删除后重新提取）、证据体系精确化要求。

### 11.2 v1.0 → v2.0 采纳记录（摘要）

propose 返回完整 PlanDraft（源码确认 [V]）· 时区方向纠正 · R15 三层重写 · D4 共享响应契约 · accept 发布规则 · 「必 OOM」措辞修正 · R5 四层生命周期 · R4a/R13/R16 合并 · R0 安全切片 · R6a 下载语义 · 引用三层可信 · Today 优先级排序 · 主题两层拆分 · 悬空编号修正 · 闭环交付重构 · 五项创新 · 双证据线。

### 11.3 v2.0 → v2.1 采纳记录（本轮）

| 第二轮外部评审意见 | 复核/处理 |
|---|---|
| R2b「依赖 P02/P03 verified」与创新四矛盾 | **定稿**：同会话闭环无硬依赖（路由已存在 [V]）；P03 非必要前置 [H]；P02 门禁语义在依赖前先跑其测试 |
| 客户端持久化不能兑现跨设备恢复 | **采纳并源码确认**：propose 返回完整 PlanDraft [V]，但跨设备需服务端可发现草稿（F2/D15） |
| G3 范围冲突（阶段三「可延后」却列入退出条件） | **修正**：G3 退出条件明确只含阶段一+二+资料列表+R6a；阶段三不作为门槛 |
| 恢复卡位置（创新一高优先却整体放 G5） | **修正**：R2c 基础恢复卡归入 G2；材料定位能力在 G3 补齐 |
| 隐私验收范围矛盾（验收节 vs D12） | **修正**：验收分「始终适用」与「能力启用后适用」；未发布能力记「不适用」不记「通过」 |
| 资料列表交付在重构中丢失 | **采纳**：G3 退出条件补「上传→关页→全局入口→找回资料+状态+原件」 |
| R5 缺恢复权威数据层 | **源码闭合**：jobs/[id] 读 PostgreSQL `opening_jobs` 持久表而非 Redis [V: F11]；权威数据定稿为轮次+持久化回复；clientKey 绑定完整意图；outcome_unknown 退出策略；四个故障注入验收 |
| 引用版本可取得性 [T] | **源码闭合一半**：对象键已按版本寻址 [V: F12]；缺口=下载未参数化版本；新增 v1/v2 直接测试；重新解析与 chunk 定位关系仍 [T] |
| 删除后重新提取 [T] | **采纳**：删除语义三选一（D14）；两个独立验收场景入第 9 节 |
| 15.5.24 与 15.5.25 性质区分 | **采纳** [E]：1.2/R0/D13 已分开表述 |
| 附录 D 精确化 | **采纳**：补来源-主张对应（附录 D）；代码事实绑定 commit 40b3de6 |
| 能力清单服务端强制；三标志区分 | **采纳**：创新五底线 + 第 10 节 |
| 可观测性最小日志 | **采纳**：R5-⑤ + 第 10 节 [E: OWASP Logging] |
| 上下文记录 / 帮助阶梯 / 离开前保存线索三个实验 | **采纳**：分别并入创新一/二/创新一（R2c） |
| 「接受却未开始 = 不现实」的因果推断 | **修正**：改为「断点原因待核查」 |
| 首版边界收敛 + 运行演示优先于第四轮评审 | **采纳**：第 8 节首版边界 + 首个运行证据链 |

**未采纳/待定**：无整体拒绝项；D15（草稿发现实现方式）按评审建议留待 R2b 实施时决策，不提前虚构方案。

### 11.4 v2.1 → v2.2 变更记录（本轮：扩展为全栈样貌）

| 变更 | 依据 |
|---|---|
| 新增第 2 节「程序整体样貌（全栈）」：Monorepo 分层表、一次提问的端到端请求链路图 | 源码核查（commit 40b3de6）：`apps/web` `apps/worker` `packages/{contracts,database,ai,domain,ui}` 分层、`runtime.ts` 作用域模型、`apps/worker/src/index.ts` Worker 注册 |
| 新增第 3 节后端/数据/AI 层事实：鉴权作用域（SQL 层 workspace 隔离）、幂等与并发（replaceChunks 事务 FOR UPDATE）、AI 预算闸门、数据模型核心表 | `opening-source-chunks.ts:9`、`apps/worker/src/index.ts:63`、`0020` 迁移 |
| **闭合遗留 [T]**：chunk ID 稳定性 → 新增 F14（`UNIQUE(source_id,source_version,page)` + DELETE+INSERT + `gen_random_uuid()` → 重解析改变 chunk.id） | `opening-source-chunks.ts:9`、`0020_opening_source_chunks.sql:12` |
| R6a 补「同一版本重新解析后点击旧引用」测试场景与定位降级约束 | F14 |
| 标题与定位从「前端现状评估」扩展为「程序整体样貌（全栈）评估」 | 用户要求：不只对焦前端 |

### 11.5 v2.2 → v2.3 变更记录（本轮：全栈深度研究报告升维）

第四轮输入是一份**全栈深度研究报告**（「系统/产品能力深度评估与全栈优化报告」，采用「通用三规模框架 + 用本文档 v2.2 校准」两层方法）。该报告**不推翻本文档的 G0–G5 与结论**，而是把计划从「前端/功能修复」升维为「系统演进蓝图」，补上了本文档最弱的三块：**可观测性（OTel/SLO）、检索智能（gold set/hybrid/rerank）、Citation 长期身份**。新增第 13 节承载这些内容，并按可源码验证性逐条标注 [V]/[E]/[H]。

**源码交叉验证结论（commit 40b3de6）**：

| 报告主张 | 核验结果 [V] | 与本文档关系 |
|---|---|---|
| 建 `UNIQUE(scope_id, idempotency_key)` + `intent_hash`（同 key 不同参数→409） | **已有先例**：`0012 learning_events`、`0019/0024 opening` 迁移均含 `UNIQUE(workspace_id, client_key)`（8–200 字符校验） | R5-② 的 clientKey 可**直接复用既有模式**，非凭空新增 |
| 把 turn 规范为业务 Operation API（含 operationId 恢复入口） | `POST /api/opening/turns` 已返回 `{jobId, turnId}` 201 | 恢复入口已存在，只需规范化状态机（增 `cancelled`）与幂等语义 |
| Citation 改为稳定 locator+hash | 当前 Citation 仅 `chunkId/sourceId/sourceVersion/label`，**无 locator/hash** [F6/F14] | 报告的 CitationIdentity 正是 F14 缺口的解法 → R6a 升级 |
| 先做 OTel 端到端证据链 | 源码**无 OTel/tracing** | 确认为缺口 → 新增 R17 |
| 负向授权测试（跨用户 403/404） | 有 `access-middleware.test.ts`（CSRF/origin），**未见跨用户负向测试** | 确认为缺口 → 并入第 9 节验收 |
| 检索先 gold set → hybrid → rerank，不急着上 Vector DB | 源码**无 embedding/vector/hybrid/rerank** | 确认当前非向量检索 → 新增 R18（G5+，不作首版门槛） |
| Next.js 15.5.21 < 15.5.24（Maintenance LTS 修复基线） | 锁文件 15.5.21 [V: F10] | 强化 R0 为 **P0**（与既有结论一致，报告独立佐证） |

**采纳原则**：报告的「判定矩阵」（何时拆微服务/上 K8s/自托管 LLM）全部采纳为「**现在不做**」的显式依据，与本文档「明确不做」清单一脉相承。

---

## 13. 系统演进蓝图（全栈升维，源自全栈深度研究报告）

> 本节是第四轮全栈研究报告带来的**升维内容**：把视角从「页面/功能修复」抬升到「系统能不能被证明可靠、可观测、可恢复、引用可核验」。**本节不改变 G0–G5 的首版边界**（第 8 节），而是为其补充三块系统性能力，并给出首版之后的演进方向与「什么时候才许扩规模」的判定矩阵。证据标记沿用全文约定。

### 13.1 最重要的架构结论：现在不拆

报告用三规模框架（小型单体 / 中型微服务 / 大型分布式）校准后判定：当前 AIstudy 是「**小型到中型之间的模块化单体 AI 产品**」，形态为 `模块化单体 Web/BFF + 独立异步 Worker + PostgreSQL + Redis/BullMQ（瞬态调度）+ S3 兼容对象存储 + AI Provider 抽象`。**业务事实源是 PostgreSQL，不是 Redis**（与 F11 一致）。

> **先把模块化单体做成「可靠、可观测、可恢复、契约稳定、引用可核验」的系统，再依据真实负载、团队边界和故障隔离需求拆服务。**

**显式「现在不做」清单**（报告判定矩阵，与第 6 节「明确不做」互补）：Kafka、多 Region active-active、Service Mesh、按微服务拆库、大规模 Kubernetes、独立 Vector DB、自托管 LLM、在线强化学习推荐——**均因「尚无证据表明其解决的问题已存在」而暂缓**。未来真需拆时，第一批候选是资源特征明显不同的三个领域：**Source Ingestion、AI Model Serving、Retrieval**。

**升级触发信号**（只有实际指标触发才扩规模）[H]：Web 与 Worker 扩容诉求差异巨大→独立 deployment；Parser 拖垮主队列→Ingestion service；ANN p95/Recall 不达标→独立 Search service；AI 成本成主要 COGS→Model routing/自托管；单 PG 持续高水位→read replica/partition；单区域 outage 不可接受→multi-AZ；团队发布相互阻塞→按域拆服务。

### 13.2 Citation 长期身份（F14 缺口的解法，R6a 升级）[H]

F14 已证明 `chunkId` 在重解析后失效（DELETE+INSERT+新 UUID）。报告给出的解法是把「检索 chunk」与「引用身份」解耦：

```text
CitationIdentity {
  sourceId
  sourceVersion
  locator {                      // 长期可核验的定位
    type: "pdf_page" | "slide" | "time_range" | "text_range"
    page?: 8
    slideLabel?: "12"
    startMs?: 25300  endMs?: 42100
    charStart?: 1200  charEnd?: 1480
  }
  normalizedContentHash          // 内容级核验
  chunkId?                       // 仅作当前索引内部优化 ID，不作长期真实性依据
}
```

**关键区分**：`chunkId` 可重建（检索优化），但「引用的是哪个版本、哪个物理位置、哪段内容」由 `sourceVersion + locator + contentHash` 保证可核验。**迁移策略（不覆盖旧数据）**：`add stable_locator nullable → 新 citation 双写 → backfill 可重建记录 → UI 优先 stable_locator → 验证旧记录 → chunkId 降为 optional internal`。这接管并升级了 R6a 的「v1/v2 测试 + 重解析降级」——降级文案从「无法重建」细化为「版本原件仍可下载，内容由 contentHash 核验，精确 chunk 定位已失效」。

### 13.3 业务 Operation API 契约（R5 的规范化）[H]

把现有 `POST turn → {jobId, turnId}` + 轮询 `jobs/[id]` 规范成 UI 不感知 BullMQ 的**业务 Operation API**：

- **状态机**（至少）：`pending / running / succeeded / failed / outcome_unknown / cancelled`——在现有 `pending/complete/failed` [F9] 上补 `running`（执行中）与 `cancelled`（用户可取消）。`outcome_unknown` 语义同 R5-③（provider 可能已收请求但 worker 落库前崩溃，不得轻率重复收费调用）。
- **幂等契约**：请求头 `Idempotency-Key` + `intent_hash = hash(canonical_request_body)`，落 `UNIQUE(scope_id, idempotency_key)`——**复用既有 `UNIQUE(workspace_id, client_key)` 模式 [V]**。逻辑：`无 key → 创建 operation + side effect`；`同 key + 同 intent_hash → 返回已有结果`；`同 key + 不同 intent_hash → 409 IDEMPOTENCY_CONFLICT`。`intent_hash` 绑定完整意图（会话+材料+版本+模式+文本，同 R5-②）。
- **版本与兼容**：Monorepo 内部同版本部署的契约可继续 `.strict()`；但**跨设备/独立版本 App/第三方 API** 需显式 `/api/v1/` 版本 + CI 跑 contract diff（breaking-change detector 阻断不兼容 merge）——因为 `.strict()` 客户端面对服务端新增字段可能严格失败。这回应并扩展了 F3/D4。

### 13.4 可观测性与 SLO（本文档最弱的缺口，新增 R17）[H]

源码确认**无 OTel/tracing** [V]。报告强调「**还没有指标 ≠ 指标差**」——当前最需要的不是猜瓶颈，而是建立能回答这条链路的证据：

```text
用户动作 → HTTP 请求 → DB/Queue → Worker → Retrieval → Provider → DB 持久化 → UI 恢复
```

- **R17 · 最小可观测性切片（建议提至 G1/G2）**：OpenTelemetry 端到端 trace（Web→Worker→AI 一个 `trace_id` 串联）；统一 correlation identifiers：`trace_id / request_id / operation_id / turn_id / conversation_id / source_id+version / model_invocation_id / deployment_version`。日志遵守第 10 节 allowlist（不含对话正文/材料/signed URL/令牌 [E: OWASP Logging]）。
- **SLO 拆解**（不只是 uptime）：`Ask SLI = 成功恢复到 complete turn 的有效提交比例`；进一步拆 `Availability / Latency / Recovery / Citation-verifiability` 四个 SLO。
- **低流量告警纪律**：**不套大站 burn-rate Pager**（低流量下单个失败即噪声爆表 [E: Google SRE]）；改用 **synthetic probe + 完整旅程检测 + 明确错误事件**。五屏 Dashboard：User Journey / HTTP / Async（queue depth, oldest age, retry, DLQ）/ DB（pool wait, locks, slow query）/ AI（TTFT, tokens, cost, provider error, citation score）。

### 13.5 检索与生成质量演进（G5+，不作首版门槛，新增 R18）[H]

源码确认当前**无 embedding/vector/hybrid/rerank** [V]。报告给出的演进顺序（**不是「换更强模型」**）：

| 优先级 | 改进 | 原因 |
|---|---|---|
| P0 | Citation Identity 稳定化（13.2） | chunkId 失效破坏历史引用 [F14] |
| P0 | Retrieval gold set（100–500 条高质量题集） | 没有 gold set 就无法判断检索是否真的改善 |
| P1 | Sparse + Dense Hybrid | 教材术语/公式编号/专有名词比纯向量更稳 |
| P1 | top-K Reranker + Context budget | 先提高送入 LLM 的上下文质量、控成本 |
| P1 | Citation support verifier | 防「有引用但引用不支持结论」（三层区分 [R6a]） |
| P2 | Query rewrite / 缓存 Embedding/Retrieval | 复杂问题或成本上升后再做 |
| P3 | 自托管/量化 LLM、在线学习 | 仅当 token 成本/反馈规模足够才经济 |

**A/B 纪律**：North Star 与 Guardrail 并存（如 Retriever A/B：primary=Recall@K/answer success，guardrail=retrieval latency）；**低流量阶段不做 50/50 A/B**（统计功效不足），改用固定 gold set + repeated task evaluation + owner allowlist。恢复卡/提示阶梯的验证指标沿用第 7 节创新一/二。

### 13.6 安全基线补强（并入 G0/R0 与第 9 节验收）

- **R0 升级 P0**：报告独立佐证 Next.js 15.5.21 低于 2026-08-25 官方 Maintenance LTS 修复基线 **15.5.24** [E]（与 F10 一致）。
- **负向授权测试（并入第 9 节「始终适用」）**：跨用户负向用例——`用户A sourceId + 用户B session → 403/404`；`A citation 指向 B version → 拒绝`；`旧 signed URL → 过期`；`已删除 source → citation 明确失效`。源码确认此类跨用户负向测试缺失 [V]。
- **间接提示注入（Indirection Prompt Injection）**：上传的 PDF/检索内容可能携带攻击指令，模型得到的材料**一律视为不可信数据而非可信指令**；敏感操作（计划接受/删除/写记忆/授权第三方）走「LLM proposes → deterministic policy engine → authorization → user confirmation → execute」，不由模型文本决定（与第 10 节底线一致，报告补充了 RAG poisoning 攻击面 [E: OWASP LLM]）。

---

## 附录 A：关键文件索引 [V]（commit 40b3de6）

```text
壳层与导航   apps/web/src/features/opening/shell/{opening-shell.tsx, navigation.ts, navigation.test.ts, empty-state.tsx}
助理        apps/web/src/features/opening/assistant/{assistant-view, composer, message-list, upload-strip, source-page-controls, turn-errors, message-model}.tsx/ts
API 客户端   apps/web/src/features/opening/client/api.ts
Opening 路由 apps/web/src/app/(opening)/opening/{today, assistant, courses, courses/[id]}/page.tsx · layout.tsx
Opening API apps/web/src/app/api/opening/**（20 个 route.ts；plans 返回 201+PlanDraft；jobs/[id] 读持久表）
作业持久化   packages/database/src/repositories/opening-tutor-jobs.ts · migrations/0018_opening_*.sql（opening_jobs/outbox/budget_reservations）
存储        packages/database/src/storage/opening-s3.ts（对象键 n(sourceId, version) = opening/sources/{id}/v{version}）
来源服务    apps/web/src/features/opening/sources/source-service.ts（complete 幂等；download 绑定当前版本）
契约        packages/contracts/src/opening/{tutor, sources, planning, jobs, memory, learning, foundation}.ts
UI 原语     packages/ui/src/{card, drawer, empty-state, field, status-badge, app-shell}.tsx
样式        apps/web/src/app/{globals.css, tailwind.css}
legacy 对照 apps/web/src/features/courses/{course-list, course-detail}.tsx · features/learn/ · features/explore/ · features/library/
```

## 附录 B：引用文档

规格：`docs/superpowers/specs/2026-09-12-opening-release-design.md` · `2026-09-14-learning-capability-expansion.md`
计划：`docs/superpowers/plans/opening-release/{interfaces.md, 07-experience.md, tasks.json}` · `docs/superpowers/plans/2026-09-19-opening-grok-execution.md`
产品约束：`docs/product/UX_AND_AI_POLICY.md`
研究：`docs/design/UIUX-RESEARCH-EVIDENCE.md` · `docs/design/DAILY-USE-UX-RESEARCH.md`
历史对照：`docs/product/PRD.md` · `docs/plans/2026-08-02-frontend-core-loops-design.md`

## 附录 C：术语

| 术语 | 含义 |
|---|---|
| Opening release | 2026-09 批准的开学可用版；今天/助理/课程三入口 |
| 薄聊天（thin chat / M1） | U03 早期切片：saved 模式对话 + 材料选择 + 页码 |
| TurnInput / TutorMode | 提问输入契约；模式 hint/explain/listen/think_together |
| outcome_unknown | job 结果不确定（计费/落库未知）；有退出策略（R5-③），UI 不显示为失败 |
| privacy epoch | 记忆删除后的隐私代数，worker 写回前校验；**不自动阻止新任务重新提取**（见创新三） |
| 物理页 vs slideLabel | PDF 物理页码 ≠ PPTX 逻辑页标签（RU-03） |
| PlanDraft | 协商计划草稿：{id, date, version, baseVersion, status, blocks, unscheduledTaskIds} |
| JobStatusResponse | 提议的共享 UI 响应契约（D4） |
| G0–G5 | 第 8 节按退出条件组织的交付阶段 |
| [V]/[E]/[H]/[T]/[C] | 本地核查（绑定 40b3de6）/ 外部来源转述 / 设计建议 / 待验证 / 冲突 |

## 附录 D：外部来源对照 [E]（转述自两轮外部评审；采纳前请按链接复核）

| 主张 | 来源 | 支持的结论 |
|---|---|---|
| Next.js 2026-08-25 安全公告：15.5 修复版本 15.5.24（AVIF 图片优化、Windows 托管场景）；15.5.25 为配合较新 sharp 重新启用 AVIF 的跟进 | nextjs.org/blog/august-2026-security-release | 1.2、R0、D13 |
| HTTP/1.1 chunked 传输无 Content-Length | RFC 9112（rfc-editor.org） | R15 |
| REST 安全：逐端点访问控制、明确请求大小限制、错误不泄露内部实现 | OWASP REST Security Cheat Sheet | R15、创新五、F3 |
| 文件上传：类型限制与隔离、不因「来自用户」视为安全 | OWASP File Upload Cheat Sheet | R6b、F8 |
| LLM 提示注入：分层防御（指令/数据分离、最小权限、输出处理） | OWASP LLM Prompt Injection Cheat Sheet | 第 10 节 |
| 日志：避免记录令牌/敏感个人信息/未同意收集的信息；用交互标识关联操作 | OWASP Logging Cheat Sheet | R5-⑤、第 10 节 |
| `Date.toISOString()` 固定 UTC；`Intl.DateTimeFormat` 支持时区 | MDN | P-I、D9 |
| `Blob.type` 可能为空串；浏览器不可靠地由内容判型 | MDN | F8 |
| `crypto.subtle.digest()` 不支持流式输入 | MDN | 上传阶段一 |
| `KeyboardEvent.isComposing` 识别组词期键盘事件 | MDN | R13 |
| `XMLHttpRequest.send()` 可直接发送 Blob | MDN | 上传阶段一 |
| `Content-Disposition: attachment` 使浏览器下载而非内联预览 | MDN | F7、R6a |
| BullMQ：job 可被清理（auto-removal）；stalled job 可重新入队；可重试任务须幂等——**不证明外部模型调用天然防重复计费** | docs.bullmq.io（auto-removal-of-jobs / stalled） | R5-①③、F11 |
| AWS：幂等 API 同标识不同参数应识别冲突；考虑幂等记录保留期；S3 预签名在请求开始时检查过期 | AWS Builders' Library / S3 预签名文档 | R5-②、上传阶段二 |
| Zod：strict 对象 / unknown keys 策略；字段少 ≠ 宽松 | zod.dev | D4/F3 |
| Tailwind：引用其他变量的主题值用 `@theme inline`；`@theme` 须在顶层 | tailwindcss.com（theme variables） | R1 |
| WCAG 2.2 AA：目标尺寸最低 24×24 CSS px（有例外）；焦点不得被遮挡 | W3C WAI（target-size-minimum / focus-not-obscured） | R1、G4 |
| Playwright 是浏览器环境仿真，不等于真机 | playwright.dev（emulation） | 第 9 节 |
| Core Web Vitals 良好阈值：LCP≤2.5s / INP≤200ms / CLS≤0.1（p75） | web.dev（vitals） | 第 9 节 |
| Next.js 支持客户端组件与库按需加载 | Next.js lazy loading 指南 | 第 9 节 |
| 检索练习优于重读（Roodenrys 等 2012） | PubMed 21252317 | 创新二 |
| 无护栏生成式 AI 损害撤除后表现；教学护栏缓解（2025 高中数学） | PubMed 40560616 | 创新二 |
| 教学设计 AI 辅导 RCT 报告积极效果 | Harvard SERL | 创新二 |
| Human-AI 交互指南：能力边界、纠错、细粒度反馈 | Microsoft Research | 创新三 |

---

*本文档为分析记录与建议，不代表功能已实现或已验收；[E] 类主张以对应官方来源为准。下一步不是第四轮评审，而是第 8 节「首个运行证据」链路的实测。*
