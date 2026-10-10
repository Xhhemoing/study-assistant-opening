# Understand：stuck `pending` + `not_started` 材料能否清除（只读）

**Date:** 2026-10-10 ~19:58 CST  
**Owner:** Experience  
**Status:** LIST_ONLY — 未 IMPLEMENT  
**背景：** hermes 上 9 条 stuck `uploadState=pending` 且 `parseState=not_started`（从未 complete）已被 Integrator 清库；问 UI 侧是否可清、是否像「卡死」  
**HEAD tip：** `32be749`（含 R2 + 上传删除 P0）

## 结论

| 问题 | 答案 |
|---|---|
| 材料库能否清这类行？ | **能，但绕路**：有「管理材料」→「删除材料」（现有 impact/actions）。**没有**失败态那种显式「删除」快捷。 |
| 客户端上传队列？ | P0「清除」**仅** `failed`。若项卡在 `uploading`/`idle`/`saved`，**不能** dismiss。 |
| 是否显示成「卡死」？ | **否**。文案是中性「**等待上传完成**」，分桶 `processing`；不像失败红标。易被当成「还在传」。 |

## 现状对照（`pending` + `not_started`）

| 表面 | 展示 | 可操作 | 缺口 |
|---|---|---|---|
| `sourceStatusLabel` | `uploadState !== "uploaded"` → **「等待上传完成」**（不提 not_started） | — | 无「卡住/未完成」措辞 |
| `materialStatus` | `pending` → **processing** | 材料库「处理中」筛选 | 与真在解析的 queued/running 混在一起 |
| `SourceRow` | 中性 badge；有「重试上传」；**无**显式「删除」（`failed` 才显示） | `onRetry` → `retryComplete`；「管理材料」全开 | 显式删除快捷缺席 |
| Inbox/助理 **上传队列** | 仅会话内队列态 | `failed` 可「清除」 | 永不 complete 的**已落库** pending 不在此队列 |
| 助理 UploadStrip | 同上 | 同上 | 同上 |

## 与「失败清除」P0 的差异

- P0 覆盖：队列 `failed` 清除 + 落库 `rejected`/`parse failed` 行上「删除」。  
- **未覆盖：** 长期 `pending`（从未 complete）——后端允许删（Data 清单），UI 只靠「管理材料」两步确认。

## 建议（待 PM 拍，本轮不写 Plan/不改）

1. **P0′（可选）** 对 `uploadState === "pending"`（可再加年龄阈值，如 >N 分钟）行显示显式「删除」快捷，复用现有 `initialAction=delete` 面板（与失败行同路径）。  
2. **文案** 将长期 pending 标成「上传未完成」/「可能已中断」，避免「等待上传完成」像仍在进行。  
3. **队列** 若产品要清会话内卡住的 `uploading`，另议 cancel/dismiss（与落库 pending 不同）。  
4. 运维清库不能替代 UI：用户仍会再产生 stuck pending。

## 明确不做（本 Understand）

- IMPLEMENT / commit / push / hermes  
- 改 complete/parse 后端（属 Data/Pipeline）
