# Opening 前端整合：现状分析与分阶段实施计划

> **For agentic workers:** 按切片执行；每片先写失败回归、再实现、再复跑。本文是基于当前工作树的计划，不是完成证明。实现时采用 subagent-driven-development 或 executing-plans；不得覆盖其他未提交修改。

**Goal:** 保留「今日 / 助理 / 课程」三个入口，把 Opening 从零散页面整合成视觉一致、材料与对话可恢复、操作结果可解释的学习工作台。

**Architecture:** 继续使用现有 Next.js App Router、Opening API、数据库与 worker；复用现有会话发现、任务轮询、解析与版本下载能力。新增 Opening 专属课程视图和材料面板，不重写旧平台，不引入新状态框架。只对已识别的前端闭环缺口补接口，不预先建设大而全的工作台后端。

**Tech Stack:** TypeScript、React、Next.js、Tailwind CSS、lucide-react、Zod、Vitest、Playwright。

## 0. 基线、范围和证据边界

- 核查日期：2026-09-22；工作区：`E:/Project/study-assistant-opening`；HEAD：`8d616c0`，叠加大量既有未提交修改。HEAD 单独不能代表本文分析对象。
- 用户选择「视觉与操作一起改」，本轮进一步要求「根据已有信息重新分析和计划」。本轮不修改业务代码、不提交、不部署、不触发真实模型调用。
- 依据：当前源码、`AGENTS.md`、`apps/web/AGENTS.md`、`docs/product/UX_AND_AI_POLICY.md`、既有 `docs/design/2026-09-20-opening-frontend-review-plan.md` 与 `docs/superpowers/plans/opening-release/continuation-status.md`。
- graphify 查询已执行，但子图被截断；最终结论以直接源码和浏览器观测为准。
- 只读委派失败（run `run_38106da6-ea9a-425e-ae16-93792b407da2`，返回 `no actionable model-project issue`），没有可用独立评审；本文是主会话复核，不宣称双审。
- Chromium/Chrome headless 实际登录预览账号，检查桌面 1440×900 与移动 390×844。截图已保存到系统临时目录；当前模型不能读取图片，因此视觉结论仅依据源码、DOM、computed style 和尺寸测量，不宣称看图验收。
- 未检查真实对象存储、worker、解析器和模型调用的运行健康；未实际上传、提交问题或创建课程。不能将 GET 200 当作完整可用。

### 全局约束

- UI 变更仅 Tailwind 工具类，图标 lucide-react；不新增原生 CSS 文件或 inline style，不全局翻转旧平台主题。
- 新建/修改模块遵守单文件 200 行上限；`assistant-view.tsx` 当前已超过上限，只按本次涉及的状态职责拆分。
- 保留 scope/权限、同源校验、幂等、隐私过滤、引用版本和错误语义。
- 不在真实失败时自动切换 mock。不把演示流程作为“已能操作”的验收替代品。
- 不增加知识图谱、掌握率仪表盘、提醒、完整记忆中心、复杂 PDF 阅读器或新的主导航。
- 当前 `OPENING_RELEASE=1` 也会禁用注册，不能仅视为视觉开关；不得为新 UI 绕过注册或身份限制。

## 1. 先纠正旧结论

| 旧说法 | 当前证据 | 本次处理 |
|---|---|---|
| Today 完全静态、没有接入数据 | `today/page.tsx:27` 已读取授权 scope 和最近会话；有继续入口 | 保留，补空态行动和材料状态，不从零重写 |
| 助理必须先选材料才能提问 | `assistant-view.tsx:105` 区分自由交流，提交允许空 sourceIds | 保留自由交流入口，不强迫上传 |
| 没有任务轮询/刷新恢复 | `assistant-view.tsx:32,143,185` 已有单一 job 轮询与 pending-job 发现 | 补故障恢复/上下文正确性，不重复搭建 |
| 未知 MIME 静默视为 PDF | `inbox/upload-state.ts:25` 未识别格式返回 null | 保留，修复 accept 与实际能力不一致 |
| 引用身份全丢失、只能拿最新版原件 | `message-list.tsx` 已保留 sourceId/chunkId/sourceVersion；`source-service.ts:30` 支持按版本下载 | 主要补客户端读取与可点击操作 |
| 所有 /learn/* 都被重定向形成死链 | middleware 只匹配精确 /learn、/explore 和 /preview*；浏览器点击新建课程真实进入 /learn/courses/new | 定性为“串入旧工作台”，不是一概死链 |
| 切换 OPENING_RELEASE/清缓存已修复 node:crypto | 历史 import trace 指向共享 domain barrel 的服务端依赖；本轮只验证 Opening 页面未报错 | 开关是避开旧入口，不是依赖边界修复证明 |

旧评估文档保留作历史依据，其行号、现状表和待实现项不能直接继续执行。

## 2. 已确认的问题

### A. “太散”有具体结构原因

1. **浅色壳套深色内容（高优先级）**：OpeningShell 为 zinc-50/white；课程复用 `features/courses/course-list.tsx`，使用 `text-text` 等旧 token。`tailwind.css:12` 的 text 为 `#f5f7ff`。浏览器课程标题计算颜色为 `rgb(245,247,255)`，main 透明，导致极浅文字落在浅色背景。不是单纯审美偏好。
2. **跨产品入口**：课程列表新建、空态新建、详情返回/目标/知识库链接指向旧 `/learn`、`/library`。实测点击新建后出现 Learn/Explore/Library/Preview 旧导航。
3. **壳层主次混乱**：`opening-shell.tsx:21,31` 重复上传入口；同一个 CaptureLink 携带 `mt-8` 进入顶栏；`aria-current` 存在但没有对应选中样式；课程标题直接输出 URL ID。
4. **嵌套布局增加空隙和语义冲突**：壳层已有 main 和 padding，课程复用组件又渲染 main、max-width 和 padding；助理的 h-full 没有明确聊天工作区高度约束。
5. **开发术语暴露**：助理标题为“M1 薄聊天”，模式为英文枚举，历史截断文案描述服务端实现而非用户可理解的限制。

### B. “无法操作”是多个流程断点，不是所有按钮都没有实现

1. **新用户没有直接下一步**：实测 Today 的 main 内没有链接；只有空态解释，需靠外围导航自己找入口。服务失败态也只有“稍后重试”。已有会话时的继续按钮应保留。
2. **上传结果不可见**：UploadStrip 完成后仅刷新一次 sources；SourcePageControls 只显示 uploaded+ready，其余全部隐藏。解析慢、失败和仅保存的文件在界面上都近似“没上传”。已有 `sourceStatusLabel()` 尚未在此消费。
3. **没有持续材料刷新**：聊天 job 轮询不等于材料解析轮询。需独立按 source 的 uploadState/parseState 跟踪，不误用 tutor 专用 jobs 接口。
4. **格式承诺不一致**：文件选择器允许 audio/*，但 resolveUploadMime 不接受音频；当前 parse worker 对 PPT 与图片等走 unsupported，而 UI 未提前说明“可保存但不能提取文字”。PDF/PPTX 路径仍依赖外部解析器，存在代码不等于环境已可用。
5. **对话选择权缺失**：初始化自动选 `listed[0]`，无会话列表或新建入口；新会话固定标题、courseId=null。需要新建/切换/返回的产品操作，而非只保存后端 ID。
6. **加载错误混在一起**：材料加载失败会阻止后续会话加载；listTurns 的失败被转为空数组，pending-job 的失败被转为 null。应区分未加载、无内容和读取失败，避免空态伪装成功。
7. **恢复上下文有残留风险**：refreshConversation 仅在 sourceIds 非空、页码非空时覆盖，不能正确清空已有选择。新增切换会话前必须先回归此行为。
8. **重试意图不完整**：Composer 的逻辑指纹只有 mode+text，未包括会话、来源与页码；改变材料后重试应验证是否属于新意图，不直接沿用旧 key。刷新后恢复与未知结果需保留服务端权威状态。
9. **引用看得见但打不开**：当前引用渲染 span，不提供资料信息或版本原件下载；后端版本能力已经部分具备。
10. **课程页数据来源混杂**：CourseDetail 调用 useStudyProvider，后者基于 createMockProvider 再叠加部分持久化。不能把这些学习目标和模式状态未经核查作为 Opening 的真实学习事实。

## 3. 目标体验（C：视觉和操作同一切片交付）

保留三入口，各自只承担一种主职责：

| 入口 | 首屏要回答的问题 | 核心操作 |
|---|---|---|
| 今日 | 我现在从哪里开始/继续？ | 新用户“开始提问”，次要“上传材料”；老用户“继续上次”；真实阻塞项旁提供可执行操作 |
| 助理 | 我在用什么材料、哪个会话，当前请求怎样了？ | 新建/切换对话、输入、材料面板、状态恢复、引用详情与下载 |
| 课程 | 这门课有哪些真实会话和可用信息？ | 列表→创建→详情→带课程上下文进入助理，全程留在 Opening |

### 布局与视觉方向

- 延续现有浅色 zinc + indigo，而非同时重做品牌/暗色模式。统一内容页标题、边界、输入、主次按钮、空态/错误态；Opening 专用组件不消费旧深色 token。
- 桌面固定侧栏；顶栏展示当前页或真实课程名称和上下文工具，不再重复全局主按钮。
- 今日为收敛的行动页；助理为主对话区 + 可折叠材料面板，输入区与消息滚动区职责清晰；课程使用相同页面头和列表密度。
- 移动保留三项底栏，材料改为可关闭面板；输入区不被底栏或软键盘覆盖。触控目标 44px；焦点可见；loading/status 有 live region；不能只靠颜色表达状态。
- 两条合法主流程并存：① 直接提问；② 上传→处理→选择→提问。用户无需创建课程才能启动。
- 加载失败保持原数据与输入，并给出“重新加载/查看已有结果/下载原件”等与实际 API 对应的操作；没有重试接口就不造“重新解析”按钮。

### 明确不先做

- 不默认建设演示模式，不伪造 AI 回复、学习记录或任务。
- 不因首页需要“待确认”卡就先扩展记忆/计划系统。当前 Today 数据加载未提供 pendingConfirmations，不把分类函数的分支视作已接通能力。
- 不将 opening source 等同旧 course asset。课程材料持久归属缺少明确连接接口，本轮先提供课程会话与显式材料选择；永久“归档到课程”另行立契约和授权测试。

## 4. 分阶段实施清单

所有阶段均按：失败回归→最小实现→相同检查通过→浏览器验收；不在第一阶段结束时宣称完整主流程已恢复。

### S0：固定真实运行和验证基线

**文件**：修改 `playwright.config.ts`、`tests/e2e/opening-shell.spec.ts`；新增 `playwright.opening.config.ts`、`tests/e2e/opening-workflow.spec.ts`。必要的依赖边界修复只在复现后限定到 `packages/domain/src/index.ts`、`opening/retest-policy.ts` 或具体客户端导入点。

- [ ] 建立隔离的 Opening E2E 配置：显式 OPENING_RELEASE=1，独立测试数据库、端口和 Next 输出目录；沿用 reset 脚本安全保护，禁止给预览开发库执行 reset。
- [ ] 将 shell 旧文案断言改为行为验收（例如空态有“开始提问”操作），先证明缺失行为确实失败；更新测试不是删掉断言。
- [ ] 实际检查 PG、S3、Redis、worker、解析器及模型配置；记录缺失服务。仅用本地无敏感小样本验证存储/解析；真实付费模型验收按已有预算授权执行，不擅自触发。
- [ ] 冷启动 Opening 路由并执行生产构建；若 node:crypto 再现，按 import trace 修复 browser/server 边界，不能用关入口/禁用 webpack 错误伪装修好。

**出口**：可重复启动，隔离测试不会重置用户预览数据；每项外部能力有“实测/阻塞”记录。

### S1：统一壳层 + Today 行动入口

**修改**：`features/opening/shell/opening-shell.tsx`、`shell/empty-state.tsx`、`app/(opening)/opening/today/page.tsx`、`features/opening/planning/today-read.ts`。
**新增**：`features/opening/shell/page-header.tsx`、`features/opening/today/today-view.tsx`；测试 `tests/e2e/opening-workspace.spec.ts`。路径均相对 `apps/web/src`，tests 除外。

- [ ] 写回归：新用户可以直接进入助理，空态与读取失败不同；桌面上传入口去重，活动项有视觉与语义状态，页面只有一个 main。
- [ ] EmptyState 支持真实行动链接；错误页提供重新加载；复用已实现最近会话读取和 conversation 参数。
- [ ] 去掉开发代号和 UUID 标题；页面标题由真实数据/路由元信息提供，加载时展示中性占位。
- [ ] 统一壳/页面头/按钮/状态规则，以局部 Tailwind 组件复用，不新增 CSS 文件或全局主题迁移。

**出口**：桌面/移动首次进入无需猜入口；旧平台视觉不受影响。

### S2：材料从上传到可提问的可见闭环

**修改**：`features/opening/assistant/upload-strip.tsx`、`source-page-controls.tsx`、`features/opening/inbox/upload-state.ts`、`features/opening/client/api.ts`。
**新增**：`features/opening/inbox/source-panel.tsx`、`use-source-status.ts`、`upload-transport.ts`，相邻 `*.test.ts`；`tests/e2e/opening-materials.spec.ts`。

- [ ] 写状态表回归：pending、解析中、ready、failed、unsupported 均显示；仅 ready 可选；页面重开仍看见原件。
- [ ] 用现有 listSources 读取持久状态，有未终结材料时限频刷新；离开取消，回到前台/联网时校准；读取失败显示重试而非“无材料”。
- [ ] 上传前验证格式和大小（现合同图片 20MiB、文档 50MiB）；文件选择器与解析能力文案一致。旧 PPT/图片仅存储的限制须提前明确；音频不误导为当前支持。
- [ ] 传输进度显示真实字节，服务确认与解析阶段独立；散列仍遵守服务端合同，不宣称已有流式哈希；文件上限与内存峰值实际检查。
- [ ] 下载入口消费现有版本下载 API。失败/不支持解析时仍允许取得已保存原件；无解析重试契约时只提供已有的恢复行为。

**出口**：上传→页面关闭→重新进入→查看状态→ready 后选择，无需靠刷新碰运气；解析失败不消失。

### S3：助理工作区与可靠恢复

**修改**：`features/opening/assistant/assistant-view.tsx`、`composer.tsx`、`message-list.tsx`、`message-model.ts`、`turn-errors.ts`、`app/(opening)/opening/assistant/page.tsx`、`client/api.ts`。
**新增**：同目录 `use-assistant-session.ts`、`job-poller.ts`、`conversation-list.tsx`、`citation-details.tsx`、相邻模型测试；`tests/e2e/opening-assistant.spec.ts`。

- [ ] 先回归：材料读取失败仍能读取会话；会话切换清空旧材料/页码；结果/状态读取失败不等同无记录；相同意图重试不重复提交，不同上下文不复用意图 key。
- [ ] 提取已有 poller 和 session 编排，保留已测试的终态/单一在途逻辑；不引入 SSE/新状态框架。
- [ ] 新建/切换对话、URL 恢复、课程上下文贯穿 create/resume；无会话时不强制先保存空会话。
- [ ] 模式中文化：“给一点提示 / 完整解释 / 先听我说 / 一起想办法”；保留原 wire enum。
- [ ] 保留输入草稿；接受、运行、失败、网络读取失败、结果未知各自有清楚解释；未知结果不自动再次调用模型。
- [ ] 引用可展开名称、版本、定位并下载对应版本；缺失/删除/授权失败明确展示，不静默改为最新版本。
- [ ] 聊天独立滚动、输入区域可用；若新增 Enter 发送必须同步加 composition 防误发，不能将当前 textarea 没有快捷键直接认作已有 IME bug。

**出口**：自由交流与带材料交流均有完整 UI 状态；刷新期间已接受请求不会被当成新请求，引用可实际取得原件。

### S4：Opening 原生课程切片

**修改**：`app/(opening)/opening/courses/page.tsx`、`courses/[id]/page.tsx`。
**新增**：`app/(opening)/opening/courses/new/page.tsx`、`features/opening/courses/course-list.tsx`、`course-create.tsx`、`course-detail.tsx`、`course-api.ts`、`course-model.ts`，相邻测试；`tests/e2e/opening-courses.spec.ts`。

- [ ] 失败回归：列表→创建→详情→返回均在 /opening；课程标题可读；创建失败保留表单；重复 slug 有可理解反馈。
- [ ] 复用真实 `/api/courses` GET/POST 和详情 API，校验响应；不凭空新增 `/api/opening/courses`。
- [ ] 移除 Opening 对旧 CourseList/CourseDetail 的直接 UI 复用，旧路由组件保留原行为；Opening 不使用 mock provider 提供正式课程目标。
- [ ] 课程详情展示真实课程信息和已保存 courseId 对话，进入助理时带入课程；来源可在助理显式选择，但不声称已完成永久课程材料归属。
- [ ] 不暴露未接通的目标/知识库/知识结构页签；课程名称必须可从授权服务读取，不展示裸 ID。

**出口**：课程链路不逃逸旧工作台，不混入演示学习事实，不改变旧平台行为。

### S5：组合验收与交付证据

**修改/新增**：上述 `tests/e2e/opening-*.spec.ts`；新增 `docs/superpowers/evidence/2026-09-22-opening-frontend/verification.md`（实现验收时创建，不提前写通过）。

- [ ] 页面截图及 DOM 检查：1440×900 / 390×844，长文件名/长中文消息/多材料/错误态；焦点、对比度、触控、滚动、弹层关闭。
- [ ] 真机或可验证移动键盘测试：仅缩 viewport 不能声称软键盘已验收。
- [ ] 可控 stub 测试检验前端状态机；真实存储/worker/模型链路另外记录，两类证据不互相替代。
- [ ] 断网、重开页面、会话过期、解析失败、读取失败、来源版本不可用、课程保存失败；检查没有假成功、假空态和盲目重复生成。
- [ ] 完成浏览器/类型/构建后保存与工作树或交付 SHA 绑定的证据；未验证项目保留 blocked。

## 5. 验证命令与安全前置

现有集中单元检查：

```bash
npm test -- --project unit apps/web/src/features/opening
npm run typecheck -w @aistudy/web
npm run lint -- apps/web/src/features/opening
npm run build
```

提示：根 lint 脚本已携带 `eslint .`，上述 lint 仍可能扫描全仓；实施时可改用 `bash scripts/run-heavy.sh eslint apps/web/src/features/opening 'apps/web/src/app/(opening)'` 做定向检查，并在交付前跑全仓门禁。不得把定向检查描述为全仓通过。

新增 Opening 配置后的浏览器验收：

```bash
# E2E_DATABASE_URL 只能指向独立、允许销毁的本地 E2E 库。
# playwright.opening.config.ts 必须设置独立端口和构建输出，不能撞预览服务器。
OPENING_RELEASE=1 npm run test:browser -- --config playwright.opening.config.ts tests/e2e/opening-workspace.spec.ts tests/e2e/opening-materials.spec.ts tests/e2e/opening-assistant.spec.ts tests/e2e/opening-courses.spec.ts
```

现有 API/存储复核可从 `tests/integration/opening-sources-storage.test.ts`、`tests/integration/handler/opening-tutor.test.ts` 开始；实施前读安全 guard，显式选择隔离测试库，不运行默认指向不明库的 reset/migration。

## 6. 本轮已经运行的检查（不是计划中的预期输出）

1. 真实浏览器登录并进入 Today、Assistant、Courses；本轮采集 `pageerror` 为空。课程等待数据加载后显示真实空列表。
2. 授权 GET `/api/courses` → `200 {"courses":[]}`；sources、conversations → `200 []`。
3. 点击“新建课程”真实进入 `http://localhost:3000/learn/courses/new`，显示旧工作台导航；不是 404/重定向死链。
4. 课程 h1 computed color：`rgb(245, 247, 255)`；main background：透明，外壳浅底。
5. 390×844 助理无水平溢出，发送按钮位于可见区，按钮高度 40px；不等于软键盘/全部状态验收。
6. 运行：

```bash
npm test -- --project unit apps/web/src/features/opening/assistant/assistant-view.test.ts apps/web/src/features/opening/assistant/source-page-controls.test.ts apps/web/src/features/opening/planning/today-read.test.ts apps/web/src/features/opening/inbox/upload-state.test.ts
```

实际输出：`Test Files 4 passed (4)`、`Tests 23 passed (23)`、`Duration 2.69s`。调度器提示 `[heavy-task] flock unavailable; running without cross-process locking.`，本轮没有同时运行其他重型检查。

7. 本轮未运行完整 E2E、生产构建、真实上传解析或模型调用。截图文件：系统 Temp 下 `opening-analysis-today.png`、`opening-analysis-assistant.png`、`opening-analysis-courses-ready.png`、`opening-analysis-assistant-mobile.png`，仅作临时采集，不当作持久验收证据。

## 7. 实施顺序与风险

顺序：S0 → S1 → S2 → S3 → S4 → S5。S4 独立课程视图可与 S2/S3 并行，但 assistant 课程上下文接线与最终合并必须串行核验。

- **兼容风险**：避免全局修改旧主题、coursePath 或旧 UI，防止修 Opening 时破坏 legacy。
- **安全风险**：引用下载仍经授权版本接口，不能直接暴露存储 key；不改 Origin 策略解决本地跨域问题。
- **数据风险**：不向用户预览库灌 fixture/reset；当前计划不要求 migration。永久材料归属另立数据库任务。
- **运行风险**：前端不能补出未运行的解析器/模型；外部能力阻塞必须显式说明，不能自动启用 mock。
- **工作树风险**：大量功能已在未提交文件中；执行前保存 scoped diff/备份，不 reset/rebase/批量覆盖，不擅自提交已有修改。

**放行定义**：新用户可在同一套 Opening 界面开始提问或上传；文件状态可见且可恢复；会话可新建、选择和继续；课程不串入旧导航；失败有诚实反馈及可执行下一步；真实闭环未验证时不能报告“前端已全部可用”。
