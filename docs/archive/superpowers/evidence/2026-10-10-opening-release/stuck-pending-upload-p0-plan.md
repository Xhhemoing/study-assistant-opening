# Plan：pending / 未完成上传 — 显式删除 + 文案（P0′）

**Date:** 2026-10-10 ~19:59 CST  
**Owner:** Experience  
**Status:** PLAN_ONLY — 待 Integrator AGREE 后由 PM 已授权路径 **IMPLEMENT**  
**依据：** `stuck-pending-upload-understand.md`；PM：Paula 要自己清、别拖  
**约束：** 复用 upload-delete P0 面板/API；不自推；不改后端 complete/parse  

## 目标

1. 落库 `uploadState === "pending"`（含典型 `parseState === "not_started"`）行有显式 **「删除」**，与失败行同确认流。  
2. 文案不再像「还在传」：改为 **「上传未完成」** 类。

## 非目标

- 客户端队列 `uploading` cancel（另议）  
- 年龄阈值 / 自动清库（运维已清 hermes）  
- P1 侧栏材料入口  
- commit/push/hermes  

## 改动

### 1) SourceRow 删除快捷扩大

**文件：** `source-row.tsx`（+ test）

- 现：`failed = rejected || parseState===failed` 才显示「删除」。  
- 改：可删快捷条件 = `failed || uploadState === "pending"`（rejected 已含在 failed）。  
- 保留「管理材料」「重试上传」（pending 仍走 `retryComplete`）。  
- `onDelete` 仍由 `inbox-panel` → `openManage(id, "delete")` → `SourceActionsPanel` `initialAction="delete"`（**不新开 API**）。

### 2) 文案

**文件：** `upload-state.ts`（+ `upload-state.test.ts`）

| 条件 | 现文案 | 新文案 |
|---|---|---|
| `uploadState !== "uploaded"`（含 pending） | 等待上传完成 | **上传未完成** |
| rejected badge | 上传被拒绝 | 不变 |

可选（同 PR 若一行）：`material-collection` / 筛选文案若写死「处理中」含 pending——**本 P0′ 不改分桶**（仍 processing），只改用户可见 status label，避免范围膨胀。

### 3) 测试

- `sourceStatusLabel({ pending, not_started })` → `"上传未完成"`  
- SourceRow：pending+not_started + onDelete → 有「删除」+「管理材料」  
- ready 仍无删除快捷  
- 既有 upload-delete / inbox-panel 测继续绿  

### 门禁

```text
npx vitest run \
  apps/web/src/features/opening/inbox/upload-state.test.ts \
  apps/web/src/features/opening/inbox/source-row.test.ts \
  apps/web/src/features/opening/inbox/inbox-panel.test.ts \
  apps/web/src/features/opening/inbox/upload-queue.test.ts
cd apps/web && npx tsc -p tsconfig.json --noEmit
```

证据：`stuck-pending-upload-p0-implement.md` → Integrator Accept。

## API（复用）

- `GET /api/opening/sources/:id/impact`  
- `POST /api/opening/sources/:id/actions` `{ action: "delete", ... }`  

## Review

请 Integrator AGREE/改点；AGREE 后 Experience 立即 IMPLEMENT（PM 已授权 Plan→过审后 IMPLEMENT）。
