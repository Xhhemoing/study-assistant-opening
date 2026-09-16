# RU-04 → F02 契约缺口清单（learning-loop / Wave1）

状态：**产品分叉已裁定；对照 contracts 残余缺口见 §0b；等 F02 语义审完再动 T03/L01；本波不改业务代码。**
基线：`feat/opening-release` 本地 `E:\Project\study-assistant-opening`；对照 `opening-real-use-audit.md` RU-04、`interfaces.md`、`05-learning.md`、`03-tutor.md` T03、`07-experience.md` U03、`tasks.json`。
硬约束：**保留 `P02.dependsOn` 含 `L01`；闲聊不强制建学习 session；验收钉 AC06 / AC10。**

## 裁定（F02 / opening-lead，2026-09-13）

1. **无法定位题面：** `hint` / `explain` **仍可**建/复用 learning session；但无 `problemId` 的 observation **不得** `independent` → 记 `unknown` / 摘要 `needs_check`。`listen` / `think_together` **不建** session。
2. **AC10：** **不新建** `evidenceKind`；用既有 `assistance` + `verdictSource`（+ `retestId`）区分例题讲解 / 提示 / 独立 / 延迟。

会话/页契约已在本机 contracts 落地：`ConversationSummary` / `ConversationResume`、`TurnInput.currentPage`。
**本波仍等 F02 语义审完再动 T03/L01 实现。P02→L01 保留。**

## 0b. 对照本机 contracts 的残余缺口（2026-09-13）

| ID | 状态 | 证据 |
|---|---|---|
| G1 活动 session 规则 | **合约已齐** | `learningSessionId` 可选已在 `tutor.ts`；**缺** mode→建/不建 session 的可测规则（服务端策略或 contract helper） |
| G2 ProblemRef / 快照 | **合约已齐** | 仅有可选 `problemId` UUID；无 stemSnapshot / sourceVersion / page / artifactKind |
| G3 HelpExposure | **合约已齐** | contracts 无曝光事件类型；`delivered` 语义未冻 |
| G4 retestId | **合约已齐** | `observationInputSchema.retestId` 已有；L02 `summarizeObservations(..., retests, now)` 仍待实现期 |
| G5 洗白禁令 | **合约已齐** | `ASSISTANCE_BLOCKS_INDEPENDENT` + `canBecomeObservedIndependent` 已挡 hinted/revealed；**缺**「无 problemId → 禁止 independent」的 schema/helper/负例 |
| 会话/页 RU-02/03 | **齐（本波依赖）** | `conversations.ts` + turn `currentPage`/`chunkId` 测试已过形状 |

F02 语义审建议在冻结前补齐：**无 problemId 禁 independent** 负例、（可选）`HelpExposure` 最小 schema、mode→session 策略函数签名。ProblemRef 快照可标为 L01 实现前必须冻，或由 F02 最小补丁一次带上。

## 0. 一句话

现有计划已有 session / assistance / observation 骨架，但**题面身份、帮助曝光、后补正确性**还没冻成一条可测的服务端证据链。F02 需要先补齐下面缺口，再让 T03/L01/L02/U03 并行实现。

## 1. 已有、可沿用（不要重造）

| 已有 | 位置 | 说明 |
|---|---|---|
| `learningSessionId?` on `TurnInput` | `interfaces.md` | 可空；缺的是「何时服务端创建/复用」规则 |
| `POST learning-sessions {courseId,skillLabel,sourceIds} -> {id}` | `05-learning.md` L01 | 显式建 session 路径存在 |
| `resolveAssistance` 防客户端抹曝光 | L01 | 同 session 内 `independent` 不能压过已知 `hinted`/`revealed` |
| `verdictSource` / `needs_check` / `observed_independent` | interfaces + L02 | 标签方向对；缺绑定失败路径与 retest 输入 |
| T03：`explain` 记 reveal intent 给 L01 | `03-tutor.md` | 方向对；缺曝光事件类型与题面引用 |
| U03：课程视图区分 self_report / model / reference | `07-experience.md` | UI 消费面；依赖上游证据形状 |
| `P02 → L01` | `tasks.json` | **保持**；本清单不提议改依赖图 |

## 2. F02 必须补的契约缺口

每项写清：缺口、建议落点、最小 schema/规则、负例、owner 消费任务。

### G1 — 活动 learning-session：服务端创建/复用（非闲聊强制）

**缺口：**`TurnInput.learningSessionId` 可空，但没有「自然求助时由服务端创建或复用活动 session」的契约；也没有「何种 turn 禁止建 session」。

**建议落点：**`interfaces.md` tutor + learning；F02 Zod；T03 worker/service 消费。

**最小规则：**
1. `mode ∈ {hint, explain}` 且 turn 绑定了可定位题面（见 G2）时：服务端创建或复用 **active learning session**；响应 DTO 回传 `learningSessionId`。
2. `mode ∈ {listen, think_together}` 或纯闲聊（无题面绑定意图）：**不得**自动创建 learning session。
3. 客户端可显式传已有 `learningSessionId`；服务端校验 ownership + course/workspace；冲突返回 4xx，不静默改绑。
4. **已裁定：** 无法定位题面时 hint/explain **仍可**建/复用 session；该 session 内无 `problemId` 的 observation 只能 `unknown` / `needs_check`。
5. 复用键建议（实现可调整）：`workspaceId + courseId + problemRefHash + openSession`；新变式题面 → 新 session（见 G2），不继承旧曝光。

**负例（F02 fixtures）：**
- listen / think_together → 无 session 行
- hint/explain 无 problemId → 可有 session，但 observation `assistance: independent` 必须被拒绝或降为 `unknown`
- 伪造他人 `learningSessionId` → 拒绝

**消费：**T03 写曝光；L01 观察必须带 session；U03 展示当前活动 session。

---

### G2 — 题面引用 / 快照（problem identity）

**缺口：**仅有可选 `problemId` + `sourceIds`。一个 PDF +「反函数」不足以唯一识别哪道题；无快照则后补「做对了」无法对齐原求助题。

**建议类型（名称可调，字段语义需冻）：**

```ts
export type ProblemRef = {
  /** Stable within workspace once assigned by server */
  problemId: string;
  sourceId: string;
  sourceVersion: number;
  /** Server-checked physical page when known */
  physicalPage: number | null;
  chunkId: string | null;
  /** Short server-held snapshot: stem text or crop descriptor — not full PDF */
  stemSnapshot: string;
  /** Distinguishes worksheet item vs student scratch work */
  artifactKind: 'reference_item' | 'student_work' | 'unknown';
};
```

**规则：**
1. Observation / exposure **优先**挂 `problemId`；无 `problemId` 且无法从 turn 定位 → 该条证据 `assistance`/`verdict` 不得升为 `independent` / `observed_independent`。
2. `stemSnapshot` 由服务端在首次绑定时写入；客户端不可事后改写快照来「换题洗白」。
3. 同 skill 下两道题必须可区分（不同 `problemId` 或不同 sourceVersion+page+stem hash）。

**负例：**
- 只有 `skillLabel: "反函数"` + 整本 PDF `sourceIds`，无 page/stem → 不能记 independent correct
- 修改客户端 `problemId` 指向未曝光题 → 拒绝或记 unknown

**消费：**T03 绑题；L01 存观察；L02 汇总按 problem/skill；U03 展示「哪一题」。

---

### G3 — 帮助曝光事件（与 turn / session / problem 同链）

**缺口：**L01 提到 `exposures: Array<'hinted'|'revealed'>`，interfaces 未定义持久化曝光记录；T03「reveal intent」未成 schema。

**建议：**

```ts
export type HelpExposure = {
  id: string;
  workspaceId: string;
  learningSessionId: string;
  problemId: string | null;
  turnId: string;
  kind: 'hinted' | 'revealed';
  /** false if request failed / cancelled before deliver */
  delivered: boolean;
  createdAt: string;
};
```

**规则：**
1. 只对 `delivered: true` 计入 `resolveAssistance`。
2. 曝光只作用于 **同一 learningSessionId**；新 session / 新 problem **不自动继承**。
3. `explain` 成功落库 → `revealed`；`hint` 成功 → `hinted`；失败 job 不写 delivered 曝光。

**负例：**失败的 explain job 后客户端报 independent correct → 仍可为 independent（无 delivered 曝光）；成功 explain 后报 independent → 强制 `revealed`。

**消费：**L01 `resolveAssistance`；AC06。

---

### G4 — `retestId` 与观察关联

**缺口：**`RetestCandidate.id` 存在，但 `ObservationInput` / `LearningObservation` 无 `retestId`；PA-03 已指出 `summarizeObservations(observations, now)` 缺少 retest 状态输入。

**建议：**
1. `ObservationInput` 增加 `retestId?: string | null`。
2. L02 签名改为显式传入版本化 retest 状态（或 read-service 合成），例如：
   `summarizeObservations(observations, retests, now)`。
3. 接受 due retest → `needs_review`；完成后关闭对应 due（与 P02 task 适配器衔接，**仍经 L01 证据**）。

**负例：**无 retest 状态差异的两份相同作答历史，摘要结果不得被纯函数区分不了却声称「已到期重测」。

**消费：**L02；P02 接受 retest→task；保留 P02→L01。

---

### G5 — unbound / 事后无法确认 → `unknown` / `needs_check`（禁止洗白）

**缺口：**标签枚举有 `unknown` / `needs_check`，但缺少「自然聊天看完答案再记对」的合同化拒绝路径。

**冻结规则（写入 interfaces 学习节 + F02 负例）：**
1. 无 learning session、或 session 内无 delivered 曝光且无 reference_checked：客户端宣称 `independent` + `correct` → 服务端记 `assistance: unknown` 或 `verdictSource: unknown`，摘要 `needs_check`，**不得** `observed_independent`。
2. 有 delivered `revealed` 后补 correct → `assistance: revealed`（或等价「已帮助」），可记 learning effect，**不得**标独立掌握。
3. 真正新变式（新 `problemId` / 新 session）不继承旧曝光；可走独立观察路径。
4. 普通闲聊不创建 session，也就没有可洗白的观察入口。

**与 IES 证据分层（产品语义，不必一次上齐枚举名）：**

| 场景 | 合同结果（最小） |
|---|---|
| 看懂例题 / 完整讲解后自报对 | revealed + self_report → needs_check 或显式「understood_with_example」类，非 independent |
| 有 hint 后重做 | hinted |
| 新题独立且 reference_checked | observed_independent（有限观察，非 mastery） |
| 延迟重测 | retestId 关联；到期 needs_review；完成后单独观察 |

F02 可先用现有枚举表达上述矩阵；若需新 `evidenceKind`，一并进 contracts，避免 U03 事后猜。

---

## 3. AC 钉点 → F02 fixture（实现前红测形状）

| AC | F02 / 下游必须能表达的序列 | 禁止结果 |
|---|---|---|
| **AC06** | ① explain 成功 → delivered revealed；② 同题后补 correct；③ 另开新题独立观察 | ①② 被记成 independent / observed_independent；无 sessionId 的后补洗白成功 |
| **AC10** | 同一答案文本，分别来自例题讲解、hint、新题独立、延迟重测 | 四条摘要/标签不可区分；生成答案未经核验当 reference |

建议 F02 `contracts.test.ts` 至少含：spoofed independence、cross-session isolation、unbound observation、retestId optional round-trip、ProblemRef required fields、HelpExposure `delivered:false` 不参与 resolve。

## 4. 任务交接（不改 dependsOn 边）

| 任务 | 本清单要求其消费的冻结面 | 仍等待 |
|---|---|---|
| **F02** | G1–G5 schema + 负例 fixtures；更新 `interfaces.md` | INTEGRATOR 审阅合并 |
| **T03** | 创建/复用 session；写 HelpExposure；绑 ProblemRef；回传 sessionId | F02 页/会话草稿齐 |
| **L01** | Observation 强制 session；resolveAssistance 读曝光；problem/retest 字段入库 | F02 + T03 曝光写入 |
| **L02** | summarize 吃 retest 状态；AC10 分层；不把 revealed 当 mastery | L01 |
| **U03** | 课程证据 UI 展示题面/帮助/核验来源；不提供「无链记独立掌握」入口 | T03/L03 等（依赖图不变） |
| **P02** | 继续依赖 L01；accepted retest→task 不绕过证据链 | L01 可用 |

## 5. 明确不做（本波）

- 不改 `tasks.json` 依赖（尤其不删 `P02→L01`）。
- 不新增知识图谱学生模型 / 聊天 chrome / Docling 选型。
- 不把研究里的「两天」写成产品最优间隔科学结论（保持启发式）。
- 不提前实现业务表/API；等 F02 契约草稿审阅通过。

## 6. 产品分叉（已裁定）

1. ~~无法定位建不建 session~~ → **建/复用；无 problemId 禁 independent。**
2. ~~是否新建 evidenceKind~~ → **不建；用 assistance + verdictSource（+ retestId）。**


## F02 语义审补落地（opening-lead，2026-09-13）

本地 `packages/contracts` 已齐下列可测签名（unit 15/15）：

| 缺口 | 落地 |
|---|---|
| G1 mode→session | `shouldCreateLearningSession(mode)` — `hint`/`explain` → true；`listen`/`think_together` → false |
| G2 ProblemRef | `problemRefSchema`（problemId/sourceId/sourceVersion/physicalPage/chunkId/stemSnapshot/artifactKind）— **F02 已冻**；L01 实现绑定 |
| G3 HelpExposure | `helpExposureSchema`：`level` hinted\|revealed，`delivered: true` 字面量（仅服务端确认送达） |
| G4 retestId | 已有（observation 可选） |
| G5 无 problemId 禁 independent | `observationAllowsIndependent({ problemId, assistance, outcome })` — 缺/空 problemId → false；另保留 hinted/revealed 挡 |

**裁定不变：** hint/explain 可建 session；无 problemId 不得记 independent；listen/think_together 不建 session；AC10 不加新 evidenceKind。

**对 T03/L01：** F02 语义审补已齐；仍 **等 F02 task verified + F01 green** 后再开工（勿抢跑）。P02→L01 保留。



## G1–G5 合约勾选（learning-loop 预备，2026-09-13）

- [x] G1 shouldCreateLearningSession — 合约已齐（实现仍待 T03）
- [x] G2 problemRefSchema — 合约已齐（绑定待 L01）
- [x] G3 helpExposureSchema delivered — 合约已齐（写入待 T03）
- [x] G4 
etestId on observation — 合约已齐
- [x] G5 observationAllowsIndependent — 合约已齐（handler 强制待 L01）

**预备工单：** [opening-t03-l01-prep-work-order.md](opening-t03-l01-prep-work-order.md)  
**门禁：** 可并行预备；正式写库仍听 opening-lead（F02 verified + F01 green / materials·continuity 短报）。P02→L01 保留。
