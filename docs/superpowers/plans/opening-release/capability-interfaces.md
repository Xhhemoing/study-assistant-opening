# Capability expansion shared interfaces (X01)

计划状态：新增协议尚未实现或冻结。X01在既有F02旁增量引入，不追溯修改F02的verified证据。所有对象由服务端principal限定workspace，日期为ISO时间；UUID、长度、数值和枚举以Zod `.strict()`校验。

## 1. 连接与导入

类型分置`packages/contracts/src/opening/connections.ts`、`imports.ts`，服务端密钥结构不得由contracts导出至浏览器。

```ts
export type ConnectionKind = 'imap' | 'dingtalk';
export type ConnectionState = 'disabled' | 'needs_authorization' | 'ready' | 'syncing' | 'error' | 'revoked';
export type ConnectionView = {
  id: string; version: number; kind: ConnectionKind; label: string; state: ConnectionState;
  allowedScopes: string[]; lastSuccessAt: string | null; errorCode: string | null;
};
export type ImapSetupInput = {
  label: string; host: string; port: number; tlsMode: 'implicit' | 'starttls';
  username: string; folders: string[]; since: string; clientKey: string;
};
export type ImapCursor = { folder: string; uidValidity: string; lastUid: number };
export type ImportIdentity = {
  connectionId: string; container: string; generation: string; remoteId: string;
};
export type ImportReceipt = {
  id: string; sourceIds: string[]; duplicate: boolean; connectionVersion: number;
};
```

`importIdentityKey(identity:ImportIdentity):string`使用无歧义的JSON元组编码。IMAP key来自connection/folder/UIDVALIDITY/UID，不能只用Message-ID；钉钉使用connection/resource-type/container/event-or-resource-ID并区分修订。
数据库必须有同一key唯一约束；流读取/存储完成并提交来源关系后才能推进cursor。断线重放返回同一receipt。UIDVALIDITY变化触发新generation的受限重新扫描，不静默延用旧UID。

连接创建返回不带秘密的ConnectionView；独立`PUT /api/opening/connections/[id]/credential`仅接收TLS保护下的`{secret:string,clientKey:string}`，只返回204。secret只在认证边界短暂存在，AES-GCM加密，nonce唯一、AAD绑定workspace/connection，密钥在部署secret中，轮换记录keyId；禁止进入URL、日志、模型或备份。

| API | 输入/输出 | 责任 |
|---|---|---|
| GET /api/opening/connections | ConnectionView[] | 只列本人连接 |
| POST /api/opening/connections/imap | ImapSetupInput → ConnectionView | 校验明确选定的主机/范围，不自动扫描 |
| POST /api/opening/connections/dingtalk | `{label,requestedScopes:string[],clientKey}` → ConnectionView | 实际授权由官方应用流程完成 |
| POST /api/opening/connections/[id]/check | `{clientKey}` → ConnectionView | 仅验证配置的端点/能力，禁止任意URL |
| POST /api/opening/connections/[id]/sync | `{clientKey}` → `{jobId}` | 有界异步任务，不在Web请求拉完整邮箱 |
| POST /api/opening/connections/[id]/revoke | `{expectedVersion,clientKey}` → ConnectionView | 删密钥、增版本、停任务、阻断晚到写回 |
| POST /api/opening/imports/email | multipart `.eml` → ImportReceipt | 手工路径明确标manual，不伪称已同步邮箱 |

初始界限：每连接每轮100封、原始单邮件25MiB、单附件20MiB、附件总和25MiB；用户选择文件夹和起始日期，默认回看14天，轮询默认15分钟，允许暂停。上限错误可见；不读取被过滤邮件正文，正文不加载外链。

## 2. 媒体与知识结构

类型分置`media.ts`、`knowledge.ts`；保留SourceChunk现有时间戳字段。sources.ts增量允许`video/mp4`、`video/webm`、`message/rfc822`，由来源类型应用不同限额；audio既有200MiB不变，视频默认512MiB/120分钟，邮件25MiB。不以更宽的MIME列表假装解析已支持。

```ts
export type MediaSegment = {
  sourceId: string; sourceVersion: number; startMs: number; endMs: number;
  text: string; frameChunkIds: string[]; quality: 'needs_check' | 'checked';
};
export type KnowledgeNode = {
  id: string; courseId: string; label: string;
  kind: 'chapter' | 'concept' | 'procedure' | 'problem_type';
  evidenceChunkIds: string[]; status: 'suggested' | 'supported' | 'needs_check';
};
export type KnowledgeEdge = {
  from: string; to: string; kind: 'contains' | 'prerequisite' | 'applies_to';
  evidenceChunkIds: string[]; status: 'suggested' | 'supported' | 'needs_check';
};
export type KnowledgeSnapshot = {
  courseId: string; version: number; nodes: KnowledgeNode[]; edges: KnowledgeEdge[];
};
export type SkillEvidence = {
  nodeId: string; observationId: string;
  dimension: 'recall' | 'explain' | 'procedure' | 'transfer' | 'timed';
};
export type TutorAction = {
  nodeId: string; kind: 'clarify' | 'worked_example' | 'guided' | 'independent_variant' | 'delayed_retest';
  evidenceIds: string[]; reason: string;
};
```

`validateMediaSegments(segments:MediaSegment[],durationMs:number):MediaSegment[]`验证0≤start<end≤duration、source/version、长度与顺序；不猜页码或音轨内容。
`validateKnowledgeSnapshot(snapshot:KnowledgeSnapshot):KnowledgeSnapshot`验证节点唯一、无孤立边、无自身先修/先修循环；“supported”必须有证据ID，服务端再校验这些chunk属于授权课程与当前材料版本。
`recommendTutorAction(input:{nodeId:string;hasCheckedIndependent:boolean;hasAssistance:boolean;retestDue:boolean}):TutorAction['kind']`是K02可独立测试的选择规则，不以模型信心直接写掌握状态。

| API | 行为 |
|---|---|
| GET /api/opening/sources/[id]/segments | 授权后的MediaSegment[]，不可输出内部对象密钥 |
| GET /api/opening/courses/[id]/knowledge | 返回KnowledgeSnapshot，空课无生成节点 |
| POST /api/opening/courses/[id]/knowledge/rebuild | `{expectedVersion,clientKey}` → `{jobId}`，有界增量任务 |
| PATCH /api/opening/courses/[id]/knowledge | `{expectedVersion,nodes,edges,clientKey}` → KnowledgeSnapshot；引用/课程/循环校验 |
| GET /api/opening/courses/[id]/tutor-actions | TutorAction[]，默认至多3项 |

媒体纠错通过已有source版本化更正入口产生新版本，不原地篡改引用；该入口由V01明确实现为`POST /api/opening/sources/[id]/segments/corrections`，输入`{expectedVersion,segments,clientKey}`，返回`{jobId}`。

## 3. 主动建议而非自动承诺

复用T03候选、P02任务/版本接受、M01记忆作用域。新增`proactive.ts`只定义读投影与选择规则输入，不另建第二套任务系统。

```ts
export type ActionCandidate = {
  id: string; dedupeKey: string; title: string; minutes: number;
  dueAt: string | null; priority: number; sourceIds: string[];
  status: 'pending' | 'accepted' | 'rejected' | 'superseded';
  needsConfirmation: boolean;
};
export type ActionDigest = {
  primary: ActionCandidate[]; pendingConfirmationCount: number;
};
```

`buildActionDigest(candidates:ActionCandidate[]):ActionDigest`去掉已接受/拒绝/失效项，以dedupeKey归并、截止优先/priority降序/id稳定排序；primary≤3，待确认总数不因截断丢失。
`GET /api/opening/action-digest`返回该投影；接受与拒绝沿用候选生命周期，不因看过摘要而默认接受。
时间不明确的候选保留`dueAt:null`并needsConfirmation；课程改期保留修订链，已接受任务只生成新计划草案。
