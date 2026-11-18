---
title: 个人知识资产图的数据与接口对接
date: 2026-11-18
status: proposed
scope: [Opening, 课程要求, 学习证据, 来源, 笔记, 探索]
promotion_target: 经集成者确认后进入对应的 contracts、database、web 实施卡
---

# 个人知识资产图 · 数据与接口对接

给设计前端和实现后端的人。核对版本为 `c9072ef5`。**当前可以直接开发合成数据前端；统一图查询仍是提案。** 已存在的业务接口见第 2 节。配套的 [JSON 请求与响应样例](2026-11-18-knowledge-assets-examples.json) 可独立交给另一个模型，内容均为虚构。

## 1. 前端从这里开始

实现一个 `queryGraph(query, signal)` 数据适配器。设计阶段在样例的 `cases` 中匹配 `request.body`，返回对应的 `http` 和 `response`；按 JSON 对象语义匹配，键顺序无关。未收录的请求在开发模式明确报“样例未覆盖”，不要用空数组或模拟成功替代。接入真实服务时只替换传输层。浏览器以当前同源登录会话访问，不把密钥、用户身份或数据库连接交给设计模型。

让同一份数据支持三种具体操作：

1. **从目标出发。** 发现目标 → 展开目标适用的要求 → 选一项要求看材料和有效作答 → 查看可用行动。要求有材料、有过受助记录、达到课程验证，是三个不同判断。
2. **从任意资产出发。** 在工作区直接找到无课程笔记 → 沿入边回到曾产出它的探索。用户无需先建课程。没有显式关系的可读笔记也可以作为起点；展开为空仍是有效结果。
3. **保留中心，切换观察方式。** 同一要求看“来源”时显示讲义，看“证据”时显示作答。节点和历史记录保持原身份。缩放、拖拽、聚类、布局、打开几个详情面板由前端决定。切换目标会改变允许展示的范围，需要重新取数。

**可直接跑的最小 mock 适配器。** 假设 `fixtures` 是与本文同目录的 JSON，调用方按 `Response.ok` 分流，与真实 fetch 保持相同用法。下面的首屏请求会返回可以继续下钻的起点。真实接入时替换 `mockQuery`，同源 POST 发送 `JSON.stringify(body)`，并向 fetch 传递 `signal`、`credentials: "same-origin"` 和 `cache: "no-store"`；失败不要自动切回 mock。

```js
function normalized(value) {
  if (Array.isArray(value)) return value.map(normalized);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalized(value[key])]));
  }
  return value;
}
function mockQuery(fixtures, body) {
  const key = JSON.stringify(normalized(body));
  const row = fixtures.cases.find(item => JSON.stringify(normalized(item.request.body)) === key);
  if (!row) throw new Error("设计样例未覆盖此请求");
  return Response.json(row.response, {status: row.http});
}
const firstPage = await mockQuery(fixtures, {
  op: "roots", context: {kind: "workspace"}, lens: "all"
}).json();
```

## 2. 已有接口怎样用

下表是当前代码行为。`:id` 为实际业务 UUID。Opening 的身份由会话推导，历史文档和探索 API 也使用同一认证运行时。[Opening 作用域](../../apps/web/src/features/opening/runtime.ts) · [认证运行时](../../apps/web/src/features/auth/service.ts)

| 现有接口 | 返回或副作用 | 图如何使用 |
|---|---|---|
| `GET /api/courses`、`GET /api/opening/learning-goals?courseId=…` | 前者 `{courses}`；后者可省略课程，返回 `{goals,selectedGoalIds,legacyConflicts}`。一个正式目标可属于多门课。 | 作为课程、目标选择的依据；有历史歧义时保留歧义。图中同一个目标只占一个身份。[目标读取](../../packages/database/src/repositories/opening-learning-goal-repository.ts) |
| `GET /api/opening/courses/:id/knowledge` | 裸 `{version,snapshot,sourceVersions}`。节点有 `kind/status/evidenceChunkIds`，边有 `from/to/kind/status`；每张快照属于一门课。可读结果为空存在多种原因。 | 复用章节、概念、方法、题型及其关系。`supported` 表示材料有依据。图读取看不到节点时，不对用户断言从未建立过图。[知识图读取](../../packages/database/src/repositories/opening-knowledge.ts) · [结构契约](../../packages/contracts/src/opening/knowledge.ts) |
| `GET /api/opening/courses/:id/learning-route` | `scopeState,requirements,suggestions,summary,materials,currentActivity,currentRoute,observationId`。每项要求带版本、稳定技能、可空知识节点、来源和进度。 | 课程要求分母取有效清单；`scopeState` 未确认时明确显示。目标内分母另按目标适用性筛选，不能拿搜索命中数或当前屏幕节点数作分母。[路线契约](../../packages/contracts/src/opening/course-route.ts) |
| `GET /api/opening/learner-state?courseId=…&limit=…` | 学情投影含 `display,features,evidence,dataAsOf,stateVersion`；`display.scope=recorded_requirements`。不带 courseId 会跨活跃课程读；limit 仅截断返回证据的一部分。 | 复用资格和状态语义。总览不可对每个节点/课程调用完整接口。`stateVersion` 也不能代替写操作各自的 revision。[学情读取](../../packages/database/src/repositories/opening-learner-state-read.ts) · [状态定义](../../packages/domain/src/opening/learner-state.ts) |
| `GET /api/courses/:id/assets`、`GET /api/opening/learning-asset-links?assetType=document&assetId=…` | 前者 `{assets}`；后者 `{links}`，必须给资产类型和 ID，支持 `source/document`，包含用途、历史关联和可用性。 | 课程成员关系、学习用途和笔记本身分开。要求 → 相关笔记需要新增有界的反向查询，不能对全库逐个请求。`detached` 仅供历史查看。[学习资产关联](../../packages/contracts/src/opening/learning-asset-links.ts) |
| `GET /api/documents`、`GET /api/documents/:id/links` | 文档列表包含 blocks，交付正文可产生曝光回执；链接端点也可能带块文本。 | 图列表另走只含标题、身份、版本的读取。笔记详情可由用户主动打开 `/opening/library/:id`。图上悬停不预取正文。[文档交付](../../apps/web/src/app/api/documents/route.ts) · [现有元数据查询参考](../../packages/database/src/repositories/opening-system-query-records.ts) |
| `GET /api/explorations`、`GET /api/documents/:id/promotion-source` | `{explorations}`、`{promotion}`。探索可无 courseId。候选可能尚未被接受；历史 `/explore/*` 页面会重定向到 Today。 | 仅接受且目标确认为该文档的记录可生成“产出”关系。可展示探索元数据；在真正的入口接通前，动作可以为空。不能把旧 URL 当“继续探索”。[探索记录](../../packages/database/src/repositories/explorations.ts) · [来源反查](../../apps/web/src/app/api/documents/[id]/promotion-source/route.ts) · [路由重定向](../../apps/web/src/middleware.ts) |
| `GET /api/opening/courses/:id/shared-skills` | 区分 candidates 与已建立的 links，并区分关系当前是否有效。 | 同名知识点留作不同节点，跨课证据沿显式且当前有效的共享关系引用，保留来源课程、要求和观察身份。[共享技能投影](../../packages/database/src/repositories/opening-course-shared-skill-projection.ts) |
| `GET /api/opening/sources/:id/content?version=…&page=…`、`GET /api/opening/observations/:id/history` | 正文、作答沿革的交付有各自的授权和曝光规则。现有材料接口支持物理页；chunk ID 本身不保证能跳至段内或高亮字符。 | 只在用户主动阅读时沿现有入口交付。来源引用固定版本和可核验的物理页。版本失效则说明旧出处不可定位，保留可读的历史事实。[材料内容](../../apps/web/src/app/api/opening/sources/[id]/content/route.ts) · [作答沿革](../../apps/web/src/app/api/opening/observations/[id]/history/route.ts) |

卡片、今日安排、考前模拟与作品分期接入。卡片的复习记录描述卡片回忆；正式复测有独立的题目、时间与有效作答条件。考试保留题和答案不进入图的候选邻居。作品首期采用已有版本化文档；统一作品实体、量规和跨作品迁移评价仍需业务设计。[正式复测与验证](../../packages/contracts/src/opening/course-route.ts) · [作品学习目标](../plans/2026-07-21-lifelong-learning-design.md)

## 3. 候选查询协议

建议一个纯读聚合入口 `POST /api/opening/asset-graph/query`。POST 承载结构化查询；沿用现有同源 Origin 和 cookie 校验。图读取只返回个人浏览所需元数据，无建课、知识图重建、内容交付、模型请求、曝光写入或学习写入。响应设置 `Cache-Control: private, no-store`。

| 字段 | 约定 |
|---|---|
| `op` | `roots` 支持发现/检索起点，`neighbors` 展开一跳，`detail` 解释一个节点。 |
| `context` | `{kind:"workspace"}`、`{kind:"course",id:"course/<uuid>"}` 或 `{kind:"goal",id:"goal/<uuid>"}`。这是当前观察范围。真正的 workspace 和 owner 始终取自已认证会话。 |
| `lens` | `all / structure / assets / evidence`。控制邻边类别与默认展示信息。对同一范围和中心，切镜头保留中心身份。 |
| `roots` 参数 | 可给 `kinds`、标题查询 `q`、`limit`、`cursor`。默认发现课程、目标、笔记、探索、可读材料；题目作答不参与默认全局搜索。`q` 仅匹配已授权的安全元数据。 |
| `neighbors` 参数 | 必给 `focus` 和 `direction: in / out / both`。可给 `relations`、`limit`、`cursor`。关系过滤和镜头取交集。沿入边访问时仍返回原始 `from/to`，前端可据此画箭头。 |
| `roots / neighbors` 的可选摘要 | `include:["summary"]` 表示仅对本页节点按类型批量补摘要，适合需要同时显示状态的视角。默认只返回轻量节点。概要不可用或预算不足时保持未知并说明，用户仍能打开详情。 |
| `detail` 参数 | 必给 `focus`；返回该对象可公开给本人的元数据、有效状态和允许的动作。无邻接分页。`detail` 不返回答案、题干正文、私有批注或模型提示。 |

**镜头只选取关系，context 决定可见范围。**

| lens | neighbors 默认关系 | roots 默认起点种类 |
|---|---|---|
| `structure` | `servesGoal, scopes, mappedTo, contains, prerequisite, appliesTo` | 课程、目标、课程要求、课程知识节点 |
| `assets` | `usesSource, linkedTo, promotedTo` | 来源、笔记、探索 |
| `evidence` | `hasObservation` | 当前范围内有明确身份的要求 |
| `all` | 四种视角中已定义的全部关系 | 课程、目标、来源、笔记、探索 |

`roots.kinds` 显式给出时覆盖默认起点种类，并受当前 context 和授权限制；首期全局根搜索不接受 `observation`，需从有权查看的要求展开。`detail` 在任一镜头返回同一对象的业务判断；`neighbors` 即使无匹配边也返回可见中心。一个中心同时出现在两张镜头里，前端可自由并排、切换或叠加；不同 context 的成员资格按各自响应保存。

**范围不随遍历无限扩大。** 工作区可纳入本人可读的独立资产。课程范围按该课程的有效要求、课程知识快照和明确的成员/业务关联选取。目标范围只纳入指定目标、其适用课程和要求、这些要求明确映射的知识节点/来源/合格归属的作答，以及与该目标或这些要求直接关联的资料、笔记和探索。探索产出的笔记只在笔记已在范围内或探索明确属于此目标时随关系纳入；单纯同课程、同名或共用某页均不扩展边界。跨课程目标分别按各所属课程应用规则，最终按真实身份去重。每条边再次检查两端。例如要求 A、B 属于不同目标且共用资料 S，目标 A 中沿 S 的入边只看到 A。要找 B 须显式切回工作区或目标 B。目标下直接请求一个工作区可读但无课、无目标关联的笔记，返回统一 404；图不会据此提示其他目标的存在。

建议初始页大小 20、最大 40，作为可测量的起点。`roots.limit` 按选中节点数计；`neighbors.limit` 按关系数计，并附中心和这些边的端点。大图通过继续展开和分页读取。客户端不请求无限深度；一个页面可以保留多个展开中心。

```ts
type Id = string; // 输出的完整节点 ID，传回 focus/context 时原样使用
type Context = {kind: "workspace"} | {kind: "course" | "goal"; id: Id};
type Lens = "all" | "structure" | "assets" | "evidence";
type WindowOptions = {limit?: number; cursor?: string; include?: ["summary"]};
type GraphQuery = {context: Context; lens: Lens} & (
  | ({op: "roots"; kinds?: NodeKind[]; q?: string} & WindowOptions)
  | ({op: "neighbors"; focus: Id; direction: "in" | "out" | "both";
       relations?: Relation[]} & WindowOptions)
  | {op: "detail"; focus: Id}
);
type NodeKind = "course" | "goal" | "requirement" | "knowledge"
  | "source" | "document" | "exploration" | "observation";
type LearnerState = "independent" | "hinted" | "retest" | "insufficient";
type RequirementStatus = "unobserved" | "needs_correction" | "assisted"
  | "needs_verification" | "verified" | "blocked";
type Action =
  | {kind: "navigate"; href: string; label: string}
  | {kind: "startCourseRequirement"; courseId: string; goalId: string;
     requirementId: string; expectedGoalRevision: number;
     expectedRequirementRevision: number; label: string};
type StateSummary = {learnerState: LearnerState | null; requirementStatus: RequirementStatus | null};
type NodeMeta = {occurredAt?: string; assistance?: "independent" | "hinted" | "revealed" | "unknown";
  version?: number; knowledgeStatus?: "suggested" | "supported" | "needs_check"};
type GraphNode = {id: string; kind: NodeKind; label: string; meta?: NodeMeta; summary?: StateSummary};
type Relation = "scopes" | "usesSource" | "hasObservation" | "promotedTo"
  | "linkedTo" | "contains" | "prerequisite" | "appliesTo" | "mappedTo" | "servesGoal";
type GraphEdge = {id: string; from: string; to: string; relation: Relation;
  basis: "recorded" | "derived" | "suggested"; sourceVersion?: number; page?: number};
type GraphPage = {
  asOf: string; nodes: GraphNode[]; edges: GraphEdge[];
  page: {nextCursor: string | null}; completeness: "complete" | "partial"; warnings: string[];
  detail: null | (StateSummary & {id: string; notes: string[]; actions: Action[]});
};
```

**字段语义决定界面可以怎样自由组合。** `id` 是服务端发出的带类型身份；一般形如 `document/<uuid>`，课程知识节点为 `knowledge/<courseUUID>/<nodeUUID>`。前端按完整 id 引用、去重，不拆字符串构造写请求。源版本在引用上保留，同一材料可被多个要求在不同版本/页面引用。归属、边的方向、证据状态由服务端决定；`x/y/颜色/布局/选中项/缩放` 都是前端状态。

- `meta` 按种类提供：观察可带发生时间和帮助条件；来源可带当前可读版本；课程知识节点可带材料整理状态。时间轴排序使用 `meta.occurredAt`，缺失就不排入时间序列；`asOf` 不能当作发生时间。受保护题目/观察只给安全名称，例如“独立作答记录”，避免借节点名、定位或悬浮摘要提前交付题干/答案。素材本身的版本与某条边所引用的版本可以不同。
- `summary` 省略表示该响应没交付摘要。`null` 表示该维度不适用或目前无法可靠返回，区分原因见 `warnings/detail.notes`。`insufficient` 是资格服务已给出的“证据不足”；`unobserved` 是课程要求仍无合格观察。任何一种都不能显示成“学不会”。
- `asOf` 是本响应读取时刻。`complete` 说明所承诺的**这一页**完整交付，仍可有 `nextCursor`。`partial` 表示预期的某类信息无法评估，应显示缺口，不能用分页或填零掩盖。没有相关数据可返回完整空页。权限不足的对象不计入缺口、总数或警告。
- 两端节点都必须在同一邻接响应可见。`basis` 描述关系的来源：业务持久化记录用 `recorded`，按确定性条件投影用 `derived`，待审的语义关系用 `suggested`。推测关系不可参与正式要求验证、跨课证据共享或自动执行。节点状态 `supported` 只说明材料依据。初版若不提供结构节点的具体材料状态，前端保持中性。
- 课程要求、学情和课程知识节点之间可能没有对应。要求摘要的 `learnerState` 仅对通过当前 `courseId + requirement.id + revision + stableSkillId + requirementKey` 检查的有效事实，复用学情领域规则计算。既有 `display.requirements` 按 `courseId + requirementKey` 分组，不能直接拷贝到已改版的要求。无法确认版本归属时返回 null 并解释；当前要求的 `requirementStatus` 使用路线自己的资格、来源及评价规则。一次独立成功可以与要求 `needs_verification` 同时成立。即使同课、同名，缺少稳定映射也保持分开。
- `actions` 为封闭集合。`navigate` 只允许已有同源产品路由；传给原入口，由它重新鉴权及检查可用性。客户端只识别明确的 `kind`，不能把服务端字符串当任意方法或 URL 执行。展示动作不代表已开始、已排期、已确认或已收费。

### 哪些关系有真实来源

| 正向关系 | 服务端依据与用途 |
|---|---|
| `course → goal (servesGoal)`、`goal → requirement (scopes)` | 前者按正式 `goal.courseIds`。后者限该目标所属课程的有效要求；显式 `goalIds` 或课程适用于所有目标的规则均可产生关系。默认适用通过 `derived` 标记。允许多课程目标。 |
| `requirement → knowledge (mappedTo)`、`requirement → source (usesSource)` | `knowledgeNodeId` 可空；来源按 `sourceRefs` 保留实际版本和物理页。同源不同页/版本可有平行边。 |
| `knowledge → knowledge` | `contains/prerequisite/appliesTo` 映射原有快照，`prerequisite` 方向是先修 → 后继。复用其审核状态；不把同现、章节顺序或名称相似升格为先修。 |
| `requirement → observation (hasObservation)` | 必须通过要求身份、版本、effective head 与可见性检查。仅课程和标签相同不连。首批只投影本地合格归属；跨课程共享在附带原始要求、共享 link 及生效条件的 DTO 后再开放，避免重复计算。 |
| `document/source → requirement/course/goal (linkedTo)` | 取有效学习资产关联。脱离的关系仅通过原历史视图查看；图上移除边不删除资产。 |
| `exploration → document (promotedTo)` | 取已接受且目标文档 ID 一致的 promotion。裸笔记仍可从工作区独立发现，不能给它凭空补一个主题或课程。 |

有原关系主键时用其身份生成不透明 `edge.id`。课程知识快照本身没有边 ID；对这类边使用类型化端点、关系种类与已有出处键组合，保留确实可区分的不同出处，完全同义且相同出处可合并。在特定关系无法跨版本识别时随该快照重新加载。布局或标签变更不会给学习记录创建新身份。

## 4. 服务端取数与前端合并

1. **绑定身份。** 建议 handler 放在 `apps/web/src/app/api/opening/asset-graph/query/route.ts`，复用 `requireOpeningScope`，解析 op 对应的参数白名单，核对 context 与 focus 归属。新增 DTO 属 `packages/contracts`，查询归 `packages/database`，既有业务状态继续由 `packages/domain` 判定。这些是拟修改位置。
2. **先选择可见页，再批量取关系。** 建议 repository 在只读、可重复读事务内，按每种真实表已有的 owner/workspace/用途条件读取有限 ID。对本页 ID 批量读取来源版本、要求、显式关联、promotion，统一投影安全标题。索引依据实际查询计划决定。`neighbors` 一次只展开指定中心，不将整个 workspace 发给浏览器再过滤。
3. **只为需要的节点算资格。** 总览读结构元数据，用户请求摘要才为可见页合并读取有效作答；详情再调用完整判断所需的事实。限制输出页数不能代替限制 SQL 工作量。若判断“首次见题”需要跨课程历史，保留原语义并按涉及题目定向查；没能证明兼容时返回 `partial`。当前路线会读取 owner 范围的作答历史，部分 span 作答还会逐条读取；必须用同一组输入核对新旧资格结果。[课程路线取数](../../packages/database/src/repositories/opening-course-route-read.ts) · [有效观察读取](../../packages/database/src/repositories/opening-learner-state-read.ts)
4. **核对释放条件。** 个人浏览和发送给 AI 分别授权。排除 AI 使用的资料仍可能允许本人阅读；相应证据/关系按原模块资格处理。永久删除、无权限或来源链不可用时，不能从相关边、警告、标题、计数、候选行动反推出隐藏对象。复用现有查询的快照与隐私版本复查，并核对材料用途和两端可见性；隐私版本单独不足以代表所有用途变化。[个人笔记读取条件](../../packages/database/src/repositories/opening-note-provenance.ts) · [系统查询只读与释放复查](../../packages/database/src/repositories/opening-system-query.ts)
5. **分页与前端状态。** 建议根集合按 `(kind,id)`、邻接按 `(relation,edgeId)` 稳定做 keyset 分页。游标为服务端可验证的不透明值，绑定会话作用域、context、lens、op、中心、方向、筛选、排序、请求摘要口径及相关已有版本，不授予权限。可检测到相关变化则使游标过期；跨页不承诺冻结全库，新增对象可在刷新时出现。游标不承载原文。UI 分开保存“本次查询的成员”和“节点元数据”，单页只对该请求范围生效；不同镜头均引用同一资产 ID。
6. **防止迟到结果。** 切换用户、目标、视角、中心或筛选时取消前一请求，同时按本地请求代数丢弃迟到结果。仅同语义的续页可以追加。退出、权限收缩或隐私变化时，清理已展开的详情、关系与数量，并重新读取；切换镜头本身不意味着可以扩大权限。已有跨标签页隐私通知仅用于提示失效。[客户端失效通知](../../apps/web/src/features/opening/client/privacy-change.ts)

**现有三个接口不宜用于首屏并发拼图。** 全文文档接口会交付内容，`learner-state.limit` 无法限制完整资格计算，逐课程 `learning-route` 会重复装载历史。首版以 PostgreSQL 业务事实做按需投影；没有新增图数据库、全局掌握表或全量同步依赖。后续若观测到瓶颈，先量根查询、邻接和资格详情各自的扫描行数、SQL 次数、响应字节及 P95，再决定是否为有明确失效依据的结构元数据建索引或做派生缓存。

## 5. 动作调用与恢复

例：用户在要求详情选择“学习这一项”。取返回动作里的原始 ID 与版本，使用既有 `createCourseRouteClient().start(courseId, body)`。`clientKey` 在**用户明确发起这一次动作**时创建；网络结果未知时复用原键和原 payload。`minutes` 用用户给定值或沿用原服务的默认策略，不从图上节点数量推算。

```ts
// action 来自 GraphPage.detail.actions，courseRouteClient 是已有客户端。
// clientKeyForThisIntent 在本次操作开始时创建；重试必须取回同一个值。
const result = await courseRouteClient.start(action.courseId, {
  goalId: action.goalId, expectedGoalRevision: action.expectedGoalRevision,
  requirementId: action.requirementId,
  expectedRequirementRevision: action.expectedRequirementRevision,
  minutes: selectedMinutes ?? 20, clientKey: clientKeyForThisIntent
});
if (result.kind === "ready") openValidatedCourseHref(result.href);
if (result.kind === "choice") showCourseChoice(result.reason, result.message);
```

`openValidatedCourseHref` 和 `showCourseChoice` 代表前端已有的路由/反馈职责；URL 以课程客户端的校验为准。用户点开详情、拖动节点、切换镜头都不会触发写动作。正式开始可能因证据、来源、配置或授权变化返回 `200 choice`。收到 `ready` 再进入后续活动。作答提交、更正、复测与计划接受沿原流程操作；完成后刷新受影响的要求、原作答及行动，禁止前端乐观宣布达标。[已有客户端与 ready/choice 核验](../../apps/web/src/features/opening/courses/course-route-client.ts) · [写入契约](../../packages/contracts/src/opening/course-route.ts)

| 情况 | 前端表现与恢复 |
|---|---|
| 图读 `200` 空页 / `partial` | 完整空页显示“当前范围无匹配”；部分结果显示已有内容和可公开的缺口，允许重试。已确认课程范围未知与证据不足分别显示。 |
| `400` 参数错误，`401` 登录失效，`403` 会话/同源策略拒绝 | 400 修正请求；401 进入原登录恢复并清掉私有视图；403 停止展示旧的相关结果。 |
| `404 NOT_FOUND` | 聚焦对象不存在、不可读或不属于当前可见范围时统一处理，移除该中心的缓存与相邻边。不能向用户区分“别人的对象”。 |
| 图读 `409 CURSOR_STALE` | 统一清空当前私有图会话的各镜头页面、节点、边、摘要、详情与游标，取消在途请求；在原视角从第一页重新读取。前端无需根据错误文本猜权限是否已变化。 |
| 已有业务写 `409` / `200 choice` | 409 读取新的业务版本并让用户确认受影响的意图；choice 展示服务端原因和可选入口。都不把当前节点改成成功状态。 |
| 网络中断或 `5xx` | 图读可重试；跨会话、已撤权的数据不回显。写入保留该意图的原 clientKey 和请求，先按原业务恢复语义核对结果。 |

普通更正走 `POST /api/opening/observations/revisions` 的 `expectedHead`；`/api/assessment/corrections` 属另一套事件模型。正式路线复测用 `POST /api/opening/courses/:id/learning-route/retest`，受 `notBeforeAt` 等条件约束。接收一条普通候选待办不代表已预约正式延迟复测。地图初期可转回对应业务页，减少重复实现。[作答修订](../../packages/contracts/src/opening/learning-revisions.ts) · [课程复测客户端](../../apps/web/src/features/opening/courses/course-route-client.ts)

## 6. 对接顺序和验收

| 可验收的结果 | 交付与验证 |
|---|---|
| 前端在无后端环境走通两个方向 | 外部设计模型读取本文和样例，独立决定画布/列表/关系图布局。演示目标 → 要求 → 资产/作答，以及无课程笔记 → 来源探索；确认入边方向、重复节点、空页、部分结果和翻页过期。 |
| 真实账号只读浏览资产 | 服务端先接根集合、显式关联、元数据与可见性。用隔离合成库对照现有对象与反向边；检查整次浏览不产生曝光、学习和计费写入。关闭新入口即可恢复原有业务入口。 |
| 学情及行动接入 | 同要求对照原资格/路线输出，覆盖提示后正确、独立新题、失效来源、作答更正/撤回、要求已修订但 key 不变、无证据及同名跨课。测试用户明确开始才创建活动、重复意图不重复创建、版本冲突和 `choice` 可恢复。实际浏览器验收由用户完成。 |
| 评估动态分配能否改善选择 | 在相同视角、可用分钟与可见资料下比较候选的新覆盖和重复活动。优化器的候选来源、覆盖增益和用时估计属于“建议”，不进入事实邻边。建议成本与证据资格由原模块核实。完成真实作答或改评后再重读事实和行动，计划选中、点击和排序分数都不产生掌握记录。作品评价、时间回放和跨课程自动归并不列入这次对接。 |

交给前端模型的一句话：**用附带的请求与响应实现“从任何可见节点出发、可双向展开、可换视角”的学习地图。保留服务端的身份、状态、缺口和动作语义；布局自由。先用样例走通上述两条路径，不访问真实账户，不调用尚未实现的图接口。**
