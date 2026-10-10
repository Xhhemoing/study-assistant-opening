# Plan：错误上传可清除 / 失败材料可删（P0 only）

**Date:** 2026-10-10 ~12:24 CST  
**Owner:** Experience  
**Status:** PLAN_ONLY — **暂不 IMPLEMENT**；待 Integrator 审 → PM 授权后再动手  
**依据：** `upload-delete-understand.md`；PM Understand AGREE  
**约束：** 不碰 R2 未推提交（实现时另开干净改动集 / 或等 R2 push 后再叠）；不删后端；不标 verified；不自推  

## 目标

Paula 对「错误上传」能就地处理：  
1. 上传队列里的 **failed** 可 **清除**（离开视线，不强制重试）。  
2. 已落库的 **失败态材料** 行上有显式 **删除**，不必先找「管理材料」再点两步。

## 非目标（本 P0）

- P1：助理内嵌管理 / 侧栏恢复「材料」入口（记下，本 Plan 不实施）  
- 批量硬删、改 delete API 语义、改清理对象存储策略  
- hermes / commit / push  

## P0-1 上传队列 failed →「清除」

### 行为

| 状态 | UI | 行为 |
|---|---|---|
| `failed` | 现有「重试」保留 | 不变 |
| `failed` | 新增「清除」 | 从队列移除该项；**不**调后端（无 source 或本地队列项） |
| `idle` / `uploading` / `saved` | 不提供清除（或 uploading 仅取消——本 P0 不做取消） | — |

两处挂载同一队列 UX：  
- `apps/web/src/features/opening/assistant/upload-strip.tsx`  
- `apps/web/src/features/opening/inbox/inbox-panel.tsx`（队列 `<ul aria-label="上传队列">`）

### 实现要点

1. `apps/web/src/features/opening/inbox/upload-queue.ts`  
   - 新增 `dismiss(id: string, update?: UploadQueueUpdate): void`（或 `remove`）  
   - 仅当 `item.state === "failed"` 时从 `items` 去掉并 `update?.(snapshot())`  
   - `return { …, dismiss }`  
2. 两处 UI：`failed` 旁加 `清除` 按钮 → `queue.dismiss(id, setItems)`  
3. 测试：`upload-queue.test.ts` — dismiss 只删 failed；非 failed 为 no-op；dismiss 后 snapshot 不含该项  
4. 可选：strip/inbox 轻量渲染测断言「清除」存在且无误调 API  

### 验收

- 失败队列项可清除后列表变短；刷新页面后本就无持久队列（预期）。  
- 不调用 `/api/opening/sources/*`。

---

## P0-2 失败态 SourceRow 显式「删除」快捷

### 行为

对 **已落库** `SourceRecord`，当  
`uploadState === "rejected"` **或** `parseState === "failed"`  
（且非需隐私特殊路径时仍允许删除；`PRIVACY_EXCLUDED` 仍可删材料，仅重解析按钮已按现逻辑隐藏）：

- 在 `SourceRow` 操作区增加醒目 **「删除」**（danger 次要按钮），与「重试/重新解析」「管理材料」并列。  
- 点击后走与 `SourceActionsPanel` **相同**确认语义：先读 impact → 确认文案 → `action: "delete"`。  
  - **推荐最小方案：** 点击「删除」等同 `onManage` 并自动 `setAction("delete")`，或 InboxPanel 增加 `pendingDeleteId` 打开 `SourceActionsPanel` 且默认 `action="delete"`。  
  - **避免** 无确认一键硬删。  
- 成功后复用 `sourceActionNotice` + `onChanged`。

### 实现要点

| 文件 | 改动 |
|---|---|
| `source-row.tsx` | 可选 `onDelete?: (id) => void`；失败态显示「删除」调用它（保留「管理材料」） |
| `inbox-panel.tsx` | `onDelete` → 打开 `SourceActionsPanel`，初始 action=`delete`（扩展 panel props：`initialAction?: "delete"`） |
| `source-actions-panel.tsx` | 支持 `initialAction`；impact 到齐后若为 delete 进入确认步 |
| 测试 | source-row：失败态有删除、ready 无；panel：initialAction=delete 进确认文案；inbox 可选 |

### API（复用，不新开）

- `GET /api/opening/sources/:id/impact`  
- `POST /api/opening/sources/:id/actions`  
  body: `{ action: "delete", expectedVersion, expectedMembershipIds }`  
- Client：`createSourceActionsClient().impact` / `.act`  

### 验收

- attention（failed/rejected）行可见「删除」→ 确认后材料消失并提示清理结果。  
- ready 行无该快捷（仍可用「管理材料」）。  
- 409 冲突文案与现面板一致。

---

## P1（记下，本 Plan 不做）

- 助理页失败材料内嵌管理 / 更短路径删除  
- 侧栏或 Today 恢复「材料」入口（R2 去干扰后发现性）  
- 课程 media-reader 失败态删入口  

## 门禁（IMPLEMENT 时）

```text
npx vitest run \
  apps/web/src/features/opening/inbox/upload-queue.test.ts \
  apps/web/src/features/opening/inbox/source-row.test.ts \
  apps/web/src/features/opening/inbox/source-actions-*.test.ts \
  apps/web/src/features/opening/inbox/inbox-panel.test.ts \
  apps/web/src/features/opening/assistant/upload-strip*.test.ts   # 若有
cd apps/web && npx tsc -p tsconfig.json --noEmit
```

证据：`upload-delete-p0-implement.md` → Integrator Accept。  
与 R2 同工作区时：只改上述 inbox/assistant 文件，**不**混进 R2 palette/settings diff 的 amend；若需 commit，等 PM 指示 Integrator 拆 commit。

## Review 请批

请 Integrator 审本 Plan；过后再由 PM 授权 Experience IMPLEMENT。
