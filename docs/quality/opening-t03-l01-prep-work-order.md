# T03 / L01 预备工单（learning-loop）

状态：**预备 only** — 可对照开工；**勿**在 materials/continuity 本轮短报前把 L01 实现写到半截。  
根目录：E:\Project\study-assistant-opening（eat/opening-release）。  
合约基线：F02 RU-04 语义审补已落地（packages/contracts unit 15/15）。  
硬约束：**保留 P02 → L01**；闲聊不建 session；AC06 / AC10。

## 1. 依赖（tasks.json，不改边）

| 任务 | dependsOn | 预备含义 |
|---|---|---|
| **T03** | T02, I03 | 会话/job/曝光写入；可先写失败单测与文件骨架清单，DB/API 实现等上游 |
| **L01** | T03, M01 | observation / session / ProblemRef 绑定；等 T03 能写 delivered HelpExposure |
| **P02** | P01, F03, **L01** | **不可拆** |
| 门禁 | F02 verified + F01 green（opening-lead） | 语义已齐；正式写库仍听该门禁；本文件只预备 |

## 2. 消费的已冻合约（勿重造）

来自 packages/contracts/src/opening/learning.ts（及 tutor/conversations）：

- shouldCreateLearningSession(mode) — hint/explain → true；listen/think_together → false
- observationAllowsIndependent({ problemId, assistance, outcome }) — 无/空 problemId → false
- problemRefSchema — L01 绑定持久化
- helpExposureSchema — delivered: true 字面量；仅服务端确认送达
- observationInputSchema — sessionId 必填；problemId / 
etestId 可选
- learningSessionCreateInputSchema
- 	urnInputSchema.learningSessionId / currentPage / chunkId
- conversationSummarySchema / conversationResumeSchema

验收钉：AC06（讲解后补正确不洗白）、AC10（assistance + verdictSource + retestId，无新 evidenceKind）。

## 3. T03 预备 — 文件清单

计划来源：docs/superpowers/plans/opening-release/03-tutor.md §T03。

**Create**
- packages/database/src/schema/opening-conversations.ts
- packages/database/src/migrations/0017_opening_conversations.sql
- packages/database/src/repositories/opening-conversations.ts
- packages/database/src/repositories/opening-candidates.ts
- pps/web/src/app/api/opening/candidates/route.ts
- pps/web/src/features/opening/tutor/tutor-service.ts
- pps/worker/src/jobs/tutor-turn.ts
- pps/worker/src/jobs/tutor-turn.test.ts
- pps/web/src/app/api/opening/conversations/route.ts
- pps/web/src/app/api/opening/conversations/[id]/turns/route.ts
- pps/web/src/app/api/opening/turns/route.ts
- pps/web/src/app/api/opening/jobs/[id]/route.ts
- 	ests/integration/handler/opening-tutor.test.ts

**RU-04 在 T03 的额外责任（预备检查表）**
- [ ] submitTurn：若 shouldCreateLearningSession(mode) 且无合法 learningSessionId → 服务端创建/复用并回传
- [ ] listen/think_together → 不创建 learning session
- [ ] explain 成功送达 → 写 helpExposureSchema（level: revealed, delivered: true）
- [ ] hint 成功送达 → level: hinted
- [ ] job 失败/取消 → **不**写 delivered 曝光
- [ ] 可选绑 problemRef / currentPage（服务端校验，不猜页）



## 3b. Continuity 对照（RU-02/03，opening-lead 短报后）

已落地（勿重写；T03 接线时复用）：

| 文件 | 职责 |
|---|---|
| pps/web/src/features/opening/tutor/page-selection.ts | alidatePageSelection — 文件≠当前页；无 page/chunk 不猜页 |
| pps/web/src/features/opening/tutor/page-selection.test.ts | RU-03 单测 |
| pps/web/src/features/opening/tutor/conversation-continuity.ts | uildBoundedHistory / uildConversationResume — sticky 页须重校验 |
| pps/web/src/features/opening/tutor/conversation-continuity.test.ts | RU-02 单测 |

本机复核命令：

`ash
node node_modules/vitest/vitest.mjs run --project unit \
  apps/web/src/features/opening/tutor/page-selection.test.ts \
  apps/web/src/features/opening/tutor/conversation-continuity.test.ts
# → 2 files / 10 tests passed
# 加上 contracts 16 → 与 continuity 短报合计 26 对齐
`

**T03 接线要点：** submitTurn / resume 路径调用 alidatePageSelection + uildConversationResume；RU-04 session/HelpExposure 叠在同一 tutor-service/worker，不另造页选逻辑。



### T03 ↔ continuity 对接清单（opening-lead，写入工单，实现仍按门禁）

| 调用 | T03 责任 |
|---|---|
| `validatePageSelection` | 失败映射 HTTP **422**，code ∈ `page_not_in_sources` / `chunk_not_in_sources` / `page_chunk_mismatch` |
| `toConversationSummary` | 列表/发现行；客户端不自造 conversation id |
| `buildConversationResume` | 传入 sticky + `authorizedChunks`；sticky 必须重校验 |
| `PROVIDER_HISTORY_MAX_TURNS=40` / `buildBoundedHistory` | provider 历史有界；尊重 `historyTruncated` |

**自建（T03）：** migration `0017`、repos、routes、`tutor-service`、job。
**禁止：** 改 continuity 模块加 DB / 把持久化塞进 `page-selection.ts` 或 `conversation-continuity.ts`。

## 4. L01 预备 — 文件清单

计划来源：docs/superpowers/plans/opening-release/05-learning.md §L01。

**Create**
- packages/database/src/schema/opening-learning.ts
- packages/database/src/migrations/0019_opening_learning.sql（follows 0018 / M01）
- packages/database/src/repositories/opening-learning.ts
- packages/domain/src/opening/assistance.ts
- packages/domain/src/opening/assistance.test.ts
- pps/web/src/features/opening/learning/observation-service.ts
- pps/web/src/app/api/opening/learning-sessions/route.ts
- pps/web/src/app/api/opening/observations/route.ts
- 	ests/integration/handler/opening-observations.test.ts

**Modify**
- pps/worker/src/jobs/tutor-turn.ts — 曝光挂显式 learningSessionId（与 T03 同一路径，勿双写语义）

**RU-04 在 L01 的额外责任**
- [ ] 
esolveAssistance：客户端 independent 不能压过同 session 已 delivered hinted/revealed
- [ ] 持久化 problemRef；无 problemId 的 observation 经 observationAllowsIndependent → 不得 observed_independent
- [ ] erdictSource：self_report / reference_checked / model_suggestion / unknown
- [ ] 新 session 不继承旧曝光；新 problemId 不洗旧题
- [ ] 修正观察 = 链接 revision，禁止隐形改写
- [ ] 闲聊无 session → 无观察洗白入口

## 5. 建议实现顺序（开工后）

1. Domain 红测：ssistance.test.ts（resolveAssistance + observationAllowsIndependent 集成断言）
2. T03 worker：mode→session + HelpExposure delivered 路径（单测假 provider）
3. L01 schema/migration/repo + observation handler 负例（spoof independent / 无 problemId / cross-session）
4. Handler 集成：AC06 序列；AC10 四条标签可区分
5. 再碰 U03 只读展示（非本预备范围）

## 6. 验收命令（预备核对 + 开工后）

`ash
# 合约回归（本机已绿基线）
node node_modules/vitest/vitest.mjs run --project unit packages/contracts/src/opening/contracts.test.ts

# L01 domain（开工后）
node node_modules/vitest/vitest.mjs run --project unit packages/domain/src/opening/assistance.test.ts

# T03 worker（开工后）
node node_modules/vitest/vitest.mjs run --project unit apps/worker/src/jobs/tutor-turn.test.ts

# Handler（开工后；需测试 DB）
npm run test:handler -- tests/integration/handler/opening-tutor.test.ts
npm run test:handler -- tests/integration/handler/opening-observations.test.ts
`

**预备阶段成功标准（本工单）：** 文件清单与依赖无歧义；G1–G5 标记合约已齐；上述 contracts 命令保持 15/15；**零**半截业务实现提交。

## 7. 明确不做

- 不改 	asks.json 依赖边
- 不实现 L02/U03/P02 本体（只保证不挡 P02→L01）
- 不上 GitHub / cloud PR（本地-only）
- 不等待 Docling / 真实模型（fake provider 即可验协议）
