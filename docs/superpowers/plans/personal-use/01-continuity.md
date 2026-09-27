# Personal-use Continuity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从一门真实课程、一份材料、一个卡点恢复到原会话；隔天或停用后回来能辨认来源并继续，不被旧建议拦住。

**Architecture:** 基于现有保存轮次、材料版本和 owner scope 增加只读接续投影，继续动作复用 `ConversationResume`。Today 展示原问题、材料身份和恢复入口，候选建议折叠展示；不生成总结，不引入新的任务系统或持久表。

**Tech Stack:** TypeScript、现有 Next.js App Router／React、PostgreSQL repository、Zod、Vitest、Playwright、Tailwind CSS、lucide-react。

## Global Constraints

- 本文件是未来实施计划；本轮仅写计划，不改业务代码、不提交、不部署。既有 CAP01–06 扩展范围保留，不把个人使用切片当完整发布验收。
- PU00 基线证据、PU01 契约冻结先完成；PU02 → PU03 串行。同一文件只有一个 owner；不得覆盖当前他人未提交修改。
- 所有命令通过 `pwsh`；每个脚本首行 `$ErrorActionPreference = 'Stop'`；文件读写显式 UTF8。以下命令都从仓库根目录执行。
- Node.js 20+；采用 React 18 兼容写法；新改代码文件均 ≤200 行。仅 Tailwind 工具类，不新增 CSS／内联 style；需要图标时只用 lucide-react。
- 本切片无 migration、无模型调用、无新记忆写入，不自动创建、接受、删除、跳过任务或重排已接受计划。未知事实使用 null，不推断“已理解”。
- 失败须记录 failure → cause → fix → recheck；同一失败命令复跑，不能只重试。未运行、跳过、环境阻塞与失败分别记录。
- 先记录本切片文件清单与基线 diff，再在独立工作区实施；提交/PR 由集成人员依安全 Git 流程统一办理。

## 当前事实与证据边界

| 已检查路径 | 当前事实与本切片处理 |
| --- | --- |
| `apps/web/src/features/opening/planning/today-service.ts` | 已有 owner-scoped 最近会话、用户原文、source_versions、current_page；不是固定空首页。SQL 目前位于 web，本次新投影 SQL 放 database。 |
| `apps/web/src/features/opening/planning/today-read.ts` | 已有 continue/confirm/empty/error/loggedOut 五态；confirm 仍携带 continueItem，但页面 confirm 分支未展示它。 |
| `apps/web/src/app/(opening)/opening/today/page.tsx` | 静态分支显示 courseId/sourceVersions/currentPage，confirm分支提前return且不画continue；确认链接可指向JSON API。这是源码风险，尚未运行复现。 |
| `packages/contracts/src/opening/conversations.ts` | `ConversationResume` 已有有界历史、引用、课程、材料选择、页码/chunk；不含可证实的“用户确认学习下一步”。 |
| `apps/web/src/features/opening/tutor/tutor-service.ts`、`packages/database/src/repositories/opening-conversation-selection.ts` | 恢复会话已校验 owner、材料授权、排除项与当前版本；恢复不是新提交。复用而不复制 tutor 状态机。 |
| `apps/web/src/features/opening/sources/source-service.ts` | `getDownloadUrl(principal,id,version?)` 已校验版本对象并返回 mismatch；下载 API 返回票据，UI 必须取票据后打开 URL，不能把 JSON 当原件。 |
| `packages/contracts/src/opening/learning.ts`、`packages/database/src/repositories/opening-learning.ts` | LearningSession/Observation/HelpExposure 已有结构和证据等级；一次问题文本不证明尝试、帮助已送达、卡点解决或掌握。 |
| `apps/web/src/features/opening/assistant/assistant-view.tsx` | 已恢复 conversation/pending-job、saved/ephemeral 分流；文件超过200行。此切片不修改该文件，也不以接续为由开展大重构。 |
| `tests/integration/opening-conversation-resume.test.ts`、`tests/e2e/opening-workflow.spec.ts` | 已有恢复/真实上传链路用例；本次只核查源码，没有重跑，不能据此宣称当前服务链路或完整R2c通过。 |

产品依据：`docs/design/2026-09-20-opening-frontend-review-plan.md` G2/R2a/R2c、`docs/product/UX_AND_AI_POLICY.md`、`docs/product/PRD.md`。Graphify query 已用于定位，随后核查源码；图与旧任务状态均不替代当前运行证据。上述界面分支问题须PU03红测及浏览器复现后才记为已复现缺陷。

**原任务映射：** RP6 → PU02/PU03（真实接续入口）；RP3/T03 → 复用发送去重、pending-job和恢复通道；RP4 → 复用版本下载及失效说明；U03 → Today实际接线；L01 → 保留证据边界，不增加掌握或正式正确结论。

**R2c 边界：** 本轮交付来源明确的原问题与回原会话动作；未找到现有“明确确认学习下一步”的等价结构，不把 memory/task accepted 冒充此语义。保存/修改用户手填断点属于独立后续增量，不阻塞此次只读接续；完整R2c仍未关闭。

## PU01 待冻结的只读接口（先于 PU02；此处为完整建议）

契约唯一 owner 为 PU01；拟新增 `packages/contracts/src/opening/continuity.ts`、`packages/contracts/src/opening/continuity.test.ts`；修改既有 `packages/contracts/src/opening/index.ts` 与 `packages/contracts/src/index.ts`，仅由 PU01 操作。实现 Zod strict schema 和以下类型；不得由两 agent 分别增加同名 DTO。

```ts
export type ContinuityMaterial = {
  sourceId: string; sourceVersion: number; name: string | null;
  physicalPage: number | null; chunkId: string | null;
  availability: "current" | "version_changed" | "position_unavailable" | "unavailable";
};
export type ContinuityCheckpoint = {
  conversationId: string; title: string;
  course: { id: string; title: string } | null; occurredAt: string;
  question: { turnId: string; text: string } | null;
  materials: ContinuityMaterial[];
  confirmedNextStep: null;
};
export type OpeningContinuityRead = {
  checkpoint: ContinuityCheckpoint | null;
  pendingSuggestions: { count: number; recent: Array<{
    id: string; conversationId: string; createdAt: string; kind: "memory" | "task";
  }> };
};
```

- UUID/ISO日期复用 foundation schema；materials≤32，recent≤3，count≥0；question.text≤280且明确是用户原文截取；拒绝额外字段和负版本。
- `confirmedNextStep: null` 明示本切片没有经确认的学习下一步；“继续”仅为导航动作，不伪装成已接受任务。下一轮扩展需另行冻结契约。
- `availability` 不承诺原件对象实际存在：current 只表示当前已授权版本与位置可验证；下载仍由既有票据通路确认。无效来源的 name/question 不返回旧正文。
- Scope 使用现有 `OpeningConversationScope`（database）或 `Scope`（contracts）结构，不另发明鉴权令牌；DTO 不含 signed URL、材料正文或模型内部推理。

## PU02：有来源的只读接续投影

**Owner:** continuity-data。**Depends:** PU00、PU01。**Review gate:** repository + service 独立验证后方可交给 PU03。

**Files:** 下列 Create 为拟新增；Modify 为已存在文件；未另写目录的函数位于其任务列出的模块。
- Create: `packages/database/src/repositories/opening-continuity.ts`（最近保存轮次与候选查询）；`packages/database/src/repositories/opening-continuity-materials.ts`（材料身份/位置有效性读取）。
- Modify: `apps/web/src/features/opening/planning/today-service.ts`；`apps/web/src/features/opening/planning/today-read.ts`；对应 `apps/web/src/features/opening/planning/today-service.test.ts`、`apps/web/src/features/opening/planning/today-read.test.ts`（兼容五态并附新 DTO）。
- Create/Test: `tests/integration/opening-continuity-repository.test.ts`、`tests/integration/opening-continuity-privacy.test.ts`；修改 `tests/integration/handler/opening-today-read.test.ts` 保留旧接口边界断言。
- Export-only handoff: `packages/database/src/index.ts` 一行导出交由集成人员顺序写入；PU02 不与其他 agent 同时修改 barrel。

**Consumes:** 冻结的 `OpeningContinuityRead`；现有 `OpeningConversationScope`、`createOpeningPrivacyRepository(sql).listExcludedSourceIds(scope)`；保存轮次的 source_versions/current_page/chunk_id。
**Produces:** `createOpeningContinuityRepository(sql: Sql): { read(scope: OpeningConversationScope): Promise<OpeningContinuityRead> }`；`TodayResumeState.continuity?: OpeningContinuityRead`（五态保留）。`createTodayResumeReader` 的旧 latestOwned/pendingCandidates/pendingCandidateCount 导出保留为薄适配。

- [ ] 1. 建 repository 失败用例，复用 `createOpeningFixture` 的 beforeAll/reset/close；先建立 owner 与 otherOwner 的真实保存轮次。
```ts
const repo = createOpeningContinuityRepository(fixture.sql);
const conversations = createOpeningConversationRepository(fixture.sql);
const conversation = await conversations.create(fixture.scope, { title: "矩阵", courseId: null });
await conversations.appendSavedTurn({ scope: fixture.scope, conversationId: conversation.id,
  text: "为什么需要讨论零行？", mode: "hint", clientKey: randomUUID(), sourceIds: [],
  learningSessionId: null, currentPage: null, chunkId: null });
const actual = await repo.read(fixture.scope);
expect(actual.checkpoint?.question?.text).toBe("为什么需要讨论零行？");
expect(actual.checkpoint?.confirmedNextStep).toBeNull();
expect((await repo.read(fixture.otherScope)).checkpoint).toBeNull();
```
- [ ] 2. 红测：执行下列 integration 命令，预期新 repository 缺失或新断言失败；记录实际失败，不接受因数据库不可达造成的红测。
```powershell
$ErrorActionPreference = 'Stop'
node node_modules/vitest/vitest.mjs run --project integration tests/integration/opening-continuity-repository.test.ts tests/integration/opening-continuity-privacy.test.ts
if ($LASTEXITCODE -ne 0) { throw 'PU02 repository verification failed' }
```
- [ ] 3. 最小实现：只查有用户保存轮次的 owner 会话，以用户轮次 `created_at DESC,id DESC` 确定最近位置，不使用空新会话遮住上次学习；数据库读取无写入。
```ts
import type { Sql } from "postgres";
import type { OpeningContinuityRead } from "@aistudy/contracts";
import type { OpeningConversationScope } from "./opening-conversations";
export function createOpeningContinuityRepository(sql: Sql) {
  return { read: (scope: OpeningConversationScope): Promise<OpeningContinuityRead> =>
    readOpeningContinuity(sql, scope) };
}
```
  `readOpeningContinuity(sql: Sql, scope: OpeningConversationScope): Promise<OpeningContinuityRead>` 为同文件拟新增内部函数：在普通短事务内只执行读取，组装会话/用户轮次、workspace内课程名、最多32个源及最多3条候选。所有查询都关联 workspace+owner；禁止正文匹配、LLM总结或从候选文本猜下一步。
- [ ] 3a. 隐私并发：普通事务首先按workspace+owner `SELECT privacy_epoch FROM workspaces ... FOR SHARE`，与 `deleteOwnedMemory` 的workspace `FOR UPDATE`锁顺序一致；全套读取使用同一tx，组装返回前重校验epoch。不要开启SQL `READ ONLY`后再申请行锁，也不执行UPDATE；不跨模型/网络调用持锁。
- [ ] 3b. 在privacy集成测试用两个连接/barrier覆盖：删除先持锁→reader等待→删除提交→返回脱敏；reader先持锁→删除等待→reader完成→删除提交→下一次read脱敏。以事务读取时点定义结果，不承诺撤回已发出的浏览器字节。
- [ ] 4. 材料过滤：source_versions是原始版本；source_ids与版本键交叉核验；排除/删除/未授权返回unavailable且隐藏原问题和旧名称。版本变更返回version_changed，保留原版本标签，禁止默认选最新版。
- [ ] 5. 位置规则：chunk必须属于同source+version；有多个材料且没有可归属chunk时physicalPage=null（不能把同一页码分配给全部材料）；同版本重解析丢chunk时position_unavailable，仍允许尝试取原版本原件。
- [ ] 6. 降级规则：缺课程关联显示null；没有任何会话返回checkpoint=null；材料失效不自动恢复正文。候选count仅算owner的pending，recent按created_at/id倒序，未知kind不作为可操作项；失败抛错由服务映射error，401映射loggedOut。
- [ ] 7. 给 today-reader 增加 `read(scope)` 并一次读取投影；服务兼容旧state/reader导出，新页面只消费continuity。旧latestOwned由投影映射，保留title/courseId/lastUserText/sourceVersions/currentPage，旧测试不被删空。
- [ ] 8. 扩充红绿矩阵：跨owner/同workspace伪owner、empty、provider不可用、删除/隐私排除、v1→v2、同版本chunk重建、源无页码、多材料页码歧义、同时间戳排序、只有临时交互时无保存卡；后两者不得靠猜测实现。
- [ ] 9. 重跑步骤2，再执行服务回归及handler；每条检查失败先定位根因后修复，并重跑相同命令。
```powershell
$ErrorActionPreference = 'Stop'
node node_modules/vitest/vitest.mjs run --project unit apps/web/src/features/opening/planning/today-read.test.ts apps/web/src/features/opening/planning/today-service.test.ts
if ($LASTEXITCODE -ne 0) { throw 'PU02 service tests failed' }
node node_modules/vitest/vitest.mjs run --project handler tests/integration/handler/opening-today-read.test.ts
if ($LASTEXITCODE -ne 0) { throw 'PU02 handler tests failed' }
node node_modules/typescript/bin/tsc -p packages/database/tsconfig.json --noEmit
if ($LASTEXITCODE -ne 0) { throw 'PU02 database typecheck failed' }
```
**验收：** read前后tasks/plans/candidates行与状态相同；外部provider调用计数为0；来源失效不会返回其原文；同一数据重复读取一致。服务检查不能替代PU03浏览器恢复。
**回退：** 回退PU02新增模块与适配，让原Today reader继续读取；无schema变化、无需删用户数据。隐私修正不可因回退而重新展示已排除正文。

## PU03：可继续且可忽略旧建议的 Today UI

**Owner:** continuity-ui。**Depends:** PU02。**Review gate:** 新组件可单独评审，页面接线与浏览器验收一起完成。

**Files:** 下列 Create 为拟新增；Modify 为已存在文件；未另写目录的函数位于其任务列出的模块。
- Create: `apps/web/src/features/opening/planning/continuity-card.tsx`、`apps/web/src/features/opening/planning/continuity-material-link.tsx`、`apps/web/src/features/opening/planning/continuity-suggestions.tsx`；职责分别为恢复卡、版本原件访问、折叠候选入口。
- Create/Test: `apps/web/src/features/opening/planning/continuity-card.test.ts`；`apps/web/src/features/opening/planning/continuity-material-link.test.ts`；`tests/e2e/opening-continuity.spec.ts`。
- Modify: `apps/web/src/app/(opening)/opening/today/page.tsx`；读取 PU02 continuity，将嵌入式 TodayResumeBody 拆入新组件，页面与组件都≤200行。
- 不改 `assistant-view.tsx`、`client/api.ts`、`today-view.tsx` 或共享 CSS；不增加过期建议批量处理服务。

**Consumes:** `TodayResumeState.continuity`、`OpeningContinuityRead`、现有 `createOpeningApi().getSourceDownload(sourceId: string, version: number): Promise<SourceDownload>`（已在 `client/api.ts` 核实；SourceDownload 来自 contracts）。
**Produces:** 以下签名的 `ReactElement` 从 `react` 导入，DTO从 `@aistudy/contracts` 导入：`ContinuityCard({ value }: { value: OpeningContinuityRead }): ReactElement`；`ContinuityMaterialLink({ material }: { material: ContinuityMaterial }): ReactElement`；`ContinuitySuggestions({ value }: { value: OpeningContinuityRead["pendingSuggestions"] }): ReactElement`。

- [ ] 1. 写失败渲染测试：使用 `renderToStaticMarkup(createElement(ContinuityCard,{value}))`；value显式构造DTO（question为已知原文，materials=[]，confirmedNextStep=null，pendingSuggestions={count:20,recent:[]}）。
```ts
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { OpeningContinuityRead } from "@aistudy/contracts";
import { ContinuityCard } from "./continuity-card";
const value: OpeningContinuityRead = {
  checkpoint: { conversationId: "11111111-1111-4111-8111-111111111111", title: "矩阵", course: null,
    occurredAt: "2026-09-25T00:00:00.000Z", question: { turnId: "22222222-2222-4222-8222-222222222222",
      text: "为什么需要讨论零行？" }, materials: [], confirmedNextStep: null },
  pendingSuggestions: { count: 20, recent: [] },
};
const html = renderToStaticMarkup(createElement(ContinuityCard, { value }));
expect(html).toContain("继续上次学习");
expect(html).toContain("为什么需要讨论零行？");
expect(html).not.toContain("请先处理待确认事项");
expect(html).not.toContain("已掌握");
expect(html).toContain(`/opening/assistant?conversation=${value.checkpoint!.conversationId}`);
```
- [ ] 2. 红测/绿测均执行同一命令；先看到缺组件或目标行为断言失败，再最小实现组件。
```powershell
$ErrorActionPreference = 'Stop'
node node_modules/vitest/vitest.mjs run --project unit apps/web/src/features/opening/planning/continuity-card.test.ts apps/web/src/features/opening/planning/continuity-material-link.test.ts
if ($LASTEXITCODE -ne 0) { throw 'PU03 component checks failed' }
```
- [ ] 3. 卡片只展示课程名、材料名/原版本/已核验位置、原问题和“继续上次学习”；无课程为“未关联课程”，未知位置为“未记录位置”。状态异常说明与继续入口并存；无卡片才显示empty；error与loggedOut继续分开。
- [ ] 4. 候选默认 `<details>` 收起，标注“以前的建议，可稍后查看”；显示记录日期和最多3项入口，指向真实原会话，不链接确认POST API。没有查看全部产品页时不画假链接。无论停用1天/30天，回来不产生新任务、逾期债务或强制清空步骤。
- [ ] 5. 原件入口按指定version调用既有下载客户端后使用返回url；加载中防重入、失败保持页面及“原版本暂时不可用”。unavailable不给下载；version_changed明确旧版；position_unavailable说明原件与精确位置是两种能力。
- [ ] 6. 页面接线：confirm不再提前return遮住checkpoint；去掉raw UUID字段展示，TodayPlanView保留其既有读/提议/接受入口。首屏不为旧建议增加自动propose/accept/reject/skip调用。
- [ ] 7. 编写浏览器回归：复用opening-auth及现有真实上传/fixture provider流程，用户求助后重开独立context、登录、访问Today、一击继续到原会话；比较provider /stats前后不增加调用，原问题/材料版本/页码可核对。只导航不发送。
- [ ] 8. 增加停用模拟（只在隔离测试库把轮次时间回拨30天）、20条旧候选、provider离线、资料版本变更、隐私排除、临时对话及读取失败；检查桌面和390×844移动截图、键盘焦点、加载/错误态。provider恢复后再运行原workflow，排除污染。
```powershell
$ErrorActionPreference = 'Stop'
pwsh -NoProfile -File scripts/opening-e2e/run.ps1 tests/e2e/opening-continuity.spec.ts tests/e2e/opening-workflow.spec.ts
if ($LASTEXITCODE -ne 0) { throw 'PU03 isolated browser checks failed' }
node node_modules/typescript/bin/tsc -p apps/web/tsconfig.json --noEmit
if ($LASTEXITCODE -ne 0) { throw 'PU03 web typecheck failed' }
```
- [ ] 9. 并发删除显示测试：第二个登录context先启动删除并停在持锁屏障，首context请求Today，放行删除提交后核对question/name不出现在HTML和可见卡片；删除已确认后刷新/重进也必须脱敏。另断言读取期间无任务/计划mutation；页面使用动态owner读取，不缓存跨删除的投影。
**验收：** 已登录Today到已有会话≤1次点击；无provider调用即可辨认并回到原问题；重返不改正式计划；原件失效诚实说明。另用一份真实个人材料记录实际恢复耗时及“是不是想继续的”，未完成此人工验收不宣称个人使用目标达成。
**回退：** 回退页面与新组件接线，保留PU02只读投影；不得回退为强制确认或偷偷下载最新版。没有用户数据迁移。

## 交接与完成证据

- PU02交PU03：冻结DTO、owner/隐私/版本矩阵、精确命令和输出、baseline差异；PU03交集成：浏览器trace/截图、点击数、provider计数、真实个人材料人工验收记录。
- 测试环境依赖由PU00准备；不得把隔离库reset命令用于个人库。全局build/CI及SHA绑定由集成人员执行；本文件局部测试全绿不代表RP3/RP4/U03/T03/L01/CAP01–06全完成。
- PR写明验收入口、无migration与回退方法；当前阶段不提交。仓库图更新由父任务在计划全部写完后执行一次，不由本分片重复执行。
