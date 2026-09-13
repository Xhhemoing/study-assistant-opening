# Opening release shared interfaces

本文件是F02的契约目标，不代表代码已存在。类型放入`packages/contracts/src/opening/`，每文件≤200行；统一从`opening/index.ts`再由现有包index导出。API版本为1；现有类型保持兼容，不修改既有LearningEvent v1以容纳未经判定的作答。


## F02 research contract freeze (mandatory)

- Docling pin: `2.126.0` (`DOCLING_PINNED_VERSION`). Formula enrichment default OFF; PPTX SimplePipeline has no CodeFormula; never tutor from garbled `orig`.
- Multimodal: `imageObjectKey` is storage-only; `ProviderInput` needs real `imageParts` or `mediaCapability: 'refused'` (`text_only | text_plus_page_images | refused`).
- Physical `page` ≠ PPTX `slideLabel`; do not dedupe chunks by text hash.
- RU-01..06 encoded in Zod `.strict()` schemas under `packages/contracts/src/opening/`.
- LearningEvent v1 unchanged.

## 1. 基础与材料（foundation.ts / sources.ts）

```ts
export type Scope = { workspaceId: string; ownerUserId: string };
export type ApiFailure = { code: string; message: string; retryable: boolean };
export type SourceMime = 'application/pdf' |
  'application/vnd.openxmlformats-officedocument.presentationml.presentation' |
  'image/jpeg' | 'image/png' | 'image/webp' |
  'audio/mpeg' | 'audio/mp4' | 'audio/wav';
export type UploadInput = { name: string; mime: SourceMime; bytes: number; sha256: string };
export type SourceRecord = {
  id: string; workspaceId: string; name: string; mime: SourceMime;
  bytes: number; sha256: string; version: number;
  uploadState: 'pending' | 'uploaded' | 'rejected';
  parseState: 'not_started' | 'queued' | 'running' | 'ready' | 'failed' | 'unsupported';
  error: ApiFailure | null; courseId: string | null; createdAt: string;
};
export type UploadTicket = { source: SourceRecord; uploadUrl: string; expiresAt: string };
export type SourceChunk = {
  id: string; sourceId: string; sourceVersion: number;
  /** Physical page index — not PPTX slide label. */
  page: number | null;
  /** Optional PPTX logical label; never equate with page across MIME types. */
  slideLabel?: string | null;
  startMs: number | null; endMs: number | null;
  text: string;
  /** Storage-only object key — not provider vision input. */
  imageObjectKey: string | null;
};
export type Citation = { chunkId: string; sourceId: string; sourceVersion: number; label: string };
```

Scope只能由登录principal及workspace所有权查询产生，不能信任请求body。UUID/date/sha256/MIME使用Zod校验。
初始限制：image 20MiB；document 50MiB；audio 200MiB；文件名≤180字符；不允许路径分隔符或NUL。限制是可配置产品默认值，不是服务器能力实测。
source identity不嵌入课程所有权：course关联使用已有membership模型；courseId是读取投影。原件object key由服务端生成。

## 2. 作业与AI（jobs.ts / tutor.ts）

```ts
export type JobRecord = {
  id: string; workspaceId: string; key: string; kind: 'parse' | 'tutor' | 'retest' | 'remind';
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'outcome_unknown';
  attempt: number; error: ApiFailure | null; privacyEpoch: number;
};
export type TutorMode = 'hint' | 'explain' | 'listen' | 'think_together';
export type TurnInput = {
  conversationId: string; text: string; sourceIds: string[];
  mode: TutorMode; clientKey: string; privacy: 'saved' | 'ephemeral';
  learningSessionId?: string | null;
  /** Optional server-checked current physical page (RU-03). */
  currentPage?: number | null;
  /** Optional server-checked chunk membership selection (RU-03). */
  chunkId?: string | null;
};
/** Resume without pre-seeded chat id: create conversation server-side first (RU-02). */
export type ConversationCreateInput = { title: string; courseId: string | null };
export type ProviderMediaCapability = 'text_only' | 'text_plus_page_images' | 'refused';
export type ProviderImagePart = {
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  /** data URL or vendor file id after authorized fetch — never a raw object key */
  data: string;
  detail?: 'auto' | 'low' | 'high';
  sourceId?: string;
  physicalPage?: number;
};
export type ProviderInput = {
  instruction: string; text: string; chunks: SourceChunk[];
  mode: TutorMode; maxOutputTokens: number; signal: AbortSignal;
  mediaCapability: ProviderMediaCapability;
  imageParts: ProviderImagePart[];
};
export type AssistantCandidate =
  | {kind:'memory';text:string;temporary:boolean}
  | {kind:'task';title:string;minutes:number|null;dueText:string|null};
export type AssistantCandidateRecord = {
  id:string;workspaceId:string;version:number;candidate:AssistantCandidate;
  sourceTurnId:string;sourceIds:string[];status:'pending'|'accepted'|'rejected';createdAt:string;
};
export type ProviderOutput = {
  text: string; citedChunkIds: string[]; requestId: string | null;
  candidates: AssistantCandidate[];
  inputTokens: number | null; outputTokens: number | null;
};
export type TurnRecord = {
  id: string; conversationId: string; role: 'user' | 'assistant';
  text: string; citations: Citation[]; createdAt: string;
  mode: TutorMode; status: 'pending' | 'complete' | 'failed';
};
export type BudgetReservation = { id: string; requestKey: string; jobId: string | null; reservedCents: number };
export type EphemeralTurnInput = {
  text: string; sourceIds: string[]; mode: TutorMode;
  history: Array<{role:'user'|'assistant';text:string}>;
  currentPage?: number | null;
  chunkId?: string | null;
};
```

真实provider实现`complete(input: ProviderInput): Promise<ProviderOutput>`；模型候选建议另外校验，不把ProviderOutput直接当数据库写入命令。
首版自动重试仅用于确定未发送/可安全重试的传输阶段，最多2次；未知是否计费转outcome_unknown，先对账或人工重试。业务提交使用幂等键；不承诺第三方exactly-once。
`AI_DAILY_LIMIT_CENTS=0`默认关闭收费调用；高难升级也经过预算预留，不静默使用其他账户。

## 3. 记忆（memory.ts）

```ts
export type MemoryItem = {
  id: string; workspaceId: string;
  /** Per-course scope — null = workspace-level; never silently global-bleed (RU-06). */
  courseId: string | null;
  kind: 'confirmed' | 'candidate' | 'temporary';
  text: string; sourceTurnIds: string[]; version: number;
  expiresAt: string | null; status: 'active' | 'rejected' | 'deleted';
};
export type MemoryDecision = { id: string; expectedVersion: number; action: 'confirm' | 'reject' | 'delete'; clientKey: string };
```

candidate不可直接作为已确认事实；temporary必须有expiresAt。确认只由用户路由触发。
删除时提升workspace privacyEpoch、使派生上下文失效；所有worker写回前核验epoch。删除记忆可选择一并删除关联对话正文；若保留正文，必须保存排除标记，禁止重新提炼同一来源。备份恢复不得复活删除标记之后的敏感内容。

## 4. 学习（learning.ts）

```ts
export type ObservationInput = {
  sessionId: string; courseId: string; skillLabel: string; sourceIds: string[];
  /** Optional problem linkage within learning session (RU-04). */
  problemId?: string | null;
  answer: string;
  outcome: 'correct' | 'incorrect' | 'unverified';
  assistance: 'independent' | 'hinted' | 'revealed' | 'unknown';
  clientKey: string;
};
export type LearningEvidenceVerdict =
  | 'FLOW_VERIFIED'
  | 'LEARNING_EFFECT_OBSERVED'
  | 'MASTERY_NOT_ESTABLISHED';
export type LearningObservation = ObservationInput & {
  id: string; workspaceId: string; occurredAt: string; sourceTurnIds: string[];
  verdictSource: 'self_report' | 'reference_checked' | 'model_suggestion' | 'unknown';
  referenceSourceId: string | null;
  evidenceVerdict?: LearningEvidenceVerdict;
};
export type LearningSummary = {
  skillLabel: string; status: 'unobserved' | 'needs_check' | 'observed_independent' | 'needs_review';
  evidenceIds: string[]; sampleCount: number; lastObservedAt: string | null;
};
export type RetestCandidate = { id: string; courseId: string; skillLabel: string; prompt: string; sourceIds: string[]; dueAt: string; accepted: boolean };
```

系统知道的hint/reveal曝光优先于客户端的independent声明；不知道在外部看答案时不臆断。开放证明默认unverified，不能因LLM说正确就写入boolean=true的旧正式事件。只有证据充分且题目已映射到正式内容版本时，才通过已有attempt服务进入旧事件系统。

## 5. 课表和计划（planning.ts）

```ts
export type WeekSession = { courseName: string; weekday: number; weeks: number[]; startPeriod: number; endPeriod: number };
export type TimeBlock = { start: string; end: string; kind: 'class' | 'sleep' | 'meal' | 'locked' | 'free' };
export type TaskItem = { id: string; title: string; minutes: number; dueAt: string | null; priority: number; status: 'pending' | 'done' | 'skipped' };
export type TaskCreateInput = {title:string;minutes:number;dueAt:string|null;priority:number;candidateId:string|null};
export type PlannedBlock = { taskId: string; start: string; end: string; reason: string };
export type PlanDraft = { id: string; date: string; version: number; baseVersion: number; status: 'draft' | 'accepted' | 'rejected'; blocks: PlannedBlock[]; unscheduledTaskIds: string[] };
export type AcceptPlanInput = { draftId: string; expectedBaseVersion: number; clientKey: string };
export type Reminder = { id: string; taskId: string; dueAt: string; channel: 'in_app' | 'feishu'; status: 'due' | 'sending' | 'sent' | 'failed' | 'disabled' };
```

日期存UTC ISO，展示使用用户IANA时区；默认Asia/Shanghai可修改。缺学期起始日或period->clock映射时，只显示学周与节次，不运行绝对时间排程。priority是用户/期限规则优先级，不是AI人格评分。

## 6. 服务函数与路由约定

每个服务函数首参数为通过鉴权的Scope；repository仍校验workspace，不能只依赖UI过滤。

| 服务 | 签名 | API |
|---|---|---|
| sources | beginUpload(scope, input: UploadInput): Promise<UploadTicket> | POST /api/opening/sources |
| sources | completeUpload(scope, sourceId: string): Promise<SourceRecord> | POST /api/opening/sources/[id]/complete |
| sources | listSources(scope): Promise<SourceRecord[]> | GET /api/opening/sources |
| sources | readSource(scope, id: string): Promise<{url:string; expiresAt:string}> | GET /api/opening/sources/[id]/download |
| tutor | submitTurn(scope, input: TurnInput): Promise<{jobId:string; turnId:string}> | POST /api/opening/turns |
| tutor | listTurns(scope, conversationId: string): Promise<TurnRecord[]> | GET /api/opening/conversations/[id]/turns |
| jobs | getJob(scope, id: string): Promise<JobRecord> | GET /api/opening/jobs/[id] |
| memory | listMemory(scope): Promise<MemoryItem[]> | GET /api/opening/memory |
| memory | decideMemory(scope, input: MemoryDecision): Promise<MemoryItem> | POST /api/opening/memory/[id]/decision |
| learning | submitObservation(scope, input: ObservationInput): Promise<LearningObservation> | POST /api/opening/observations |
| learning | summarizeLearning(scope, courseId: string): Promise<LearningSummary[]> | GET /api/opening/courses/[id]/learning |
| planning | getToday(scope, date: string): Promise<PlanDraft|null> | GET /api/opening/today |
| planning | proposePlan(scope, date: string): Promise<PlanDraft> | POST /api/opening/plans |
| planning | acceptPlan(scope, input: AcceptPlanInput): Promise<PlanDraft> | POST /api/opening/plans/[id]/accept |

新增接口：任务CRUD `/api/opening/tasks`、课表确认 `/api/opening/timetable`、复习候选确认 `/api/opening/retests/[id]/accept`、提醒列表 `/api/opening/reminders`。其请求体分别使用TaskCreateInput、WeekSession数组及显式学期映射、仅clientKey、无body；F02补齐Zod输入/输出类型。
对话创建 `POST /api/opening/conversations {title,courseId:null|string}` -> `{id,title,courseId}`；id由服务器生成，source关联逐个授权。
保存会话的`submitTurn`只接受privacy=saved；ephemeral使用`POST /api/opening/ephemeral`，接收EphemeralTurnInput并直接返回ProviderOutput，不将正文写入持久队列，返回前清空candidates。`GET /api/opening/candidates`返回当前用户的待确认AssistantCandidateRecord；来源ID由程序附加，模型不得任意指定。memory候选由M01确认服务消耗，task候选由P02任务确认服务消耗；两者都不得直接成为正式事实或安排。学习会话通过`POST /api/opening/learning-sessions {courseId,skillLabel,sourceIds}`创建，返回服务器id；帮助曝光按该会话关联。
错误约定：401未登录、404不属于当前用户或不存在、409版本/幂等载荷冲突、413过大、415类型不支持、422结构无效、429预算/限流、503依赖不可用。日志不输出正文、令牌、签名下载地址。

## 7. 测试fixtures约定

F03创建`tests/integration/opening-fixture.ts`：`createOpeningFixture(): Promise<OpeningFixture>`。对象包含`scope`、`otherScope`、`sql`、`cookie`、`request(path, init): Promise<Response>`、`requestAnonymous(path, init): Promise<Response>`、`reset(): Promise<void>`、`close(): Promise<void>`。只连接F01保护的测试库；每次生成独立用户/workspace。

纯规则测试自行使用字面量，避免依赖数据库fixtures。UI测试请求mock仅在测试目录内；Q02必须另跑一次真实API流程。提供`tests/fixtures/opening/source.pdf`等合成素材时注明生成方式，不把合成识别质量当课堂实测。
