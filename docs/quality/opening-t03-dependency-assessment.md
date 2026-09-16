# T03 依赖评估（方案 B 预研）— 2026-09-13

作者：aistudy-lead。**只文档**；不改 `tasks.json` `dependsOn`。等 Fiona / aistudy-pm 裁定。

范围：对照本机 **T03 HTTP 联调切片**（conversations / resume / turns / submitTurn + sources HTTP 由 materials 持有），评估计划依赖 **T02、I03**（及上游）哪些是硬依赖、哪些可降为契约依赖。

证据基线：`docs/superpowers/evidence/2026-09-13-opening-release/t03-tutor-http-slice.md`；相关 unit 曾跑 **49 passed**。T03 现 `blocked`（因 T02/I03 未 verified）。

---

## 1. 计划写的依赖链

```
F01 → F03 → I03 (BullMQ/outbox runtime)
F03 → T01 (provider/budget) → T02 (context/citations) → T03
I02 → T02
T03 dependsOn: [T02, I03]
```

计划全文里，**完整 T03**（worker 跑完一轮）明确要求：Worker 经 **T02** 建上下文、调 **T01**、经 **I03** 派发/认领 job。

---

## 2. HTTP 切片实际调用了什么

| 能力 | 本机实现落点 | 是否调用 T02/I03 产物 |
|---|---|---|
| list/create conversations | `tutor-service` + `opening-conversations` repo | 否 |
| resume + boundedHistory | continuity `buildConversationResume` | 否（非 T02 `selectContext`） |
| listTurns | conversations repo | 否 |
| submitTurn 校验 | contracts `turnInputSchema` + continuity `validatePageSelection` | **否** T02；仅 RU-03 契约语义 |
| learning session 门 | contracts `shouldCreateLearningSession` | 否 |
| 持久化 user + pending assistant + `opening_tutor_jobs` 行 | `appendSavedTurn` 直接 INSERT | **否** I03 outbox/BullMQ |
| 返回 `jobId` | DB 生成 UUID | job **永不 dispatch** |
| sources list/begin/complete | materials `source-service` | 属 F03/I01 切片，非 I03 |

**结论：** 当前 HTTP 切片 **零 import / 零调用** `packages/ai/.../context|citations`、`apps/worker` queue/dispatch、T01 provider。

---

## 3. 硬依赖 vs 可降为契约依赖

### 相对「HTTP 切片验收 / U03 联调」

| 依赖 | 判定 | 说明 |
|---|---|---|
| **T02** | **契约依赖（可降）** | 切片只用 `authorizedChunks` + `validatePageSelection`（continuity）。无 chunk 表时带 `currentPage` → fail-closed 422（已知）。完整「可引用检索」才硬需要 T02 `selectContext` / `resolveCitations` / chunks repo。 |
| **I03** | **契约依赖（可降）** | 切片只写 `opening_tutor_jobs` 行并返回 id；UI 显示 pending。真执行/重试/崩溃恢复才硬需要 I03 outbox+BullMQ。 |
| **T01** | 非 tasks 直接依赖，但对「job complete」为硬 | HTTP 不调 provider；worker 补齐前不可称端到端 tutoring。 |
| **F02 contracts / continuity helpers** | 硬（已齐） | Summary/Resume、TurnInput、page 422 codes。 |
| **conversations migration/repo** | 硬（T03 自有 DATA） | 0017 + repo；与 T02/I03 无关。 |
| **sources HTTP（materials）** | 并列交付，非 T03 dependsOn | U03 上传路径需要；归属 materials。 |

### 相对「计划全文 T03 verified（含 worker）」

| 依赖 | 判定 |
|---|---|
| **T02** | **硬** — worker 建上下文与可验证引用 |
| **I03** | **硬** — 认领/派发/重试与唯一业务结果 |
| **T01**（经 T02 链） | **硬** — 真实 complete |
| candidates API / integration handler / `tutor-turn` worker | 计划 Create 清单内，HTTP 切片 **未做** |

---

## 4. 方案含义（供裁定，不改图）

**维持门禁（现状）：** T03 继续 `blocked`，等 T02+I03 verified 后再标 verified。诚实，但 U03 已联调的 HTTP 价值在任务图上显示为 blocked。

**方案 B（依赖降级，若 Fiona 批准再改 `dependsOn`）：**

- 将 T03 拆成或标注两档：`T03a` HTTP/持久化切片 vs `T03b` worker 闭环；或
- T03 `dependsOn` 改为仅 **F02**（+ 可选 F01），把 T02/I03 挪到「T03 worker / 端到端」后续任务；
- verified 证据必须写明：**不含** 真模型、不含 outbox 派发、页选无 chunk 时 fail-closed。

**不推荐：** 在 T02/I03 仍 planned 时强行 `verified` 且不改图 — `validate-opening-plan.mjs` 会红。

---

## 5. 建议话术（给 Fiona）

> HTTP 切片对 T02/I03 是「计划纸面硬依赖、实现上契约依赖」。若目标是诚实反映 U03 可联调，应改依赖图或拆任务后再 verified；若目标是完整 tutoring job，应先推 F01→F03→I03 与 T01→T02，T03 保持 blocked。

---

## 6. 明确未做（避免误读）

- 未改 `tasks.json`
- 未声称 T03 计划 checkbox 全绿
- F01 仍卡 `OPENING_TEST_DATABASE_URL`（基础设施），与本文正交
