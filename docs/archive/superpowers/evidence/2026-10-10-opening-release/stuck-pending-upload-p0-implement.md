# Implement：pending / 未完成上传 — 显式删除 + 文案（P0′）

**Date:** 2026-10-10 ~20:00 CST  
**Owner:** Experience  
**Status:** READY_FOR_ACCEPT  
**Branch:** `feat/opening-release`  
**HEAD (pre-commit):** `32be749`  
**Plan:** `stuck-pending-upload-p0-plan.md`  
**Auth:** Integrator AGREE + PM authorized immediate IMPLEMENT after AGREE  
**约束：** 未 commit / 未 push

## 改动文件

| 文件 | 变更 |
|---|---|
| `apps/web/src/features/opening/inbox/upload-state.ts` | `sourceStatusLabel`：`uploadState !== "uploaded"` → `"上传未完成"`（原 `"等待上传完成"`） |
| `apps/web/src/features/opening/inbox/upload-state.test.ts` | pending+not_started 期望改为 `"上传未完成"` |
| `apps/web/src/features/opening/inbox/source-row.tsx` | 删除快捷：`failed \|\| uploadState === "pending"`；管理材料 / 重试不变 |
| `apps/web/src/features/opening/inbox/source-row.test.ts` | 新增 pending+not_started 显示「删除」+「管理材料」+「上传未完成」；ready 仍无删除 |

未改：`inbox-panel.tsx` / `inbox-panel.test.ts`（已有 failed 行删除断言；无 pending 行断言；`onDelete` → `openManage(id, "delete")` 复用既有）

## 门禁

```text
npx vitest run \
  apps/web/src/features/opening/inbox/upload-state.test.ts \
  apps/web/src/features/opening/inbox/source-row.test.ts \
  apps/web/src/features/opening/inbox/inbox-panel.test.ts \
  apps/web/src/features/opening/inbox/upload-queue.test.ts
```

**结果：** Test Files 4 passed (4)；Tests 28 passed (28)

```text
cd apps/web && npx tsc -p tsconfig.json --noEmit
```

**结果：** exit 0（无输出）

## Accept 清单

- [x] 文案：pending → 「上传未完成」
- [x] SourceRow：pending 行有「删除」快捷；ready 无
- [x] 复用 upload-delete 面板/API，无新 API
- [x] 门禁绿
- [x] 无 commit / 无 push

→ Integrator Accept。
