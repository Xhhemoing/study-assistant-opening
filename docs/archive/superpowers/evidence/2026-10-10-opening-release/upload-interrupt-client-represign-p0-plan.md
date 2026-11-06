# Plan（Experience 客户端半边）：上传中断重试 = 刷新预签 + 重新 PUT

**Date:** 2026-10-10 ~21:45 CST  
**Owner:** Experience（客户端/队列/材料库重试 UX）  
**配对：** Pipeline 后端 **刷新 upload ticket / re-presign**（`upload-interrupt-represign-p0-plan.md`，若尚未落盘则按下方契约对齐）  
**依据：** Pipeline `upload-interrupt-pending-understand.md`；PM 三点要求  
**Status:** PLAN_ONLY — 待与 Pipeline 对齐后一并交 Integrator；**AGREE 后 IMPLEMENT**；不自推  

## 目标

1. 队列/材料库「重试」**必须** 刷新预签名 + **重新 PUT**，禁止复用过期 `ticket.uploadUrl`，禁止对无 staging 的 pending **只** `complete`。  
2. PUT 失败尽量带上 **HTTP 状态/原因**（便于排 CORS/403）。  
3. **不与 stuck-pending P0′ 冲突**（「上传未完成」文案 + pending 显式删除保留）。

## 非目标

- 改 parse/complete 校验语义（Pipeline/Data）  
- hermes minio 公网曝光（运维另议；同域 staging 仍可并行）  
- commit/push  

## 与 Pipeline 契约（客户端依赖）

客户端调用（名称可按 Pipeline 最终定稿微调）：

```http
POST /api/opening/sources/:id/upload-ticket
# 或 issueUploadTicket / represign — 仅允许 upload_state=pending
→ UploadTicket { source, uploadUrl, expiresAt, ... }
```

- **同一 sourceId**，新 `uploadUrl`（新预签），**禁止** 创建第二行材料。  
- 校验：principal 拥有该源；仍为 pending；bytes/mime/sha 与 begin 一致。  
- Experience **不**发明第二套 begin。

## 客户端改动

### A. PUT 错误信息可读

**`put-private.ts`**

- `onload` 非 2xx：`reject(new Error(\`上传对象失败 (${xhr.status})\`))` 已有 → **上传到 upload-client message**。  
- `onerror`：尽量附带 `xhr.status`（若有）或固定「网络错误/可能 CORS」。  
- 可选：`UploadPutError` 带 `status?: number`。

**`upload-client.ts` PUT catch**

- message 形如：`上传中断，原件仍在本地。未标记为已上传。${detail}`  
  - detail 例：`HTTP 403` / `HTTP 0（网络或 CORS）` / 原 `err.message`。  
- **不改变** phase=`interrupted`、仍返回 `sourceId`+`ticket`（旧 ticket 仅作 id 引用；重试时丢弃 URL）。

### B. 队列重试：强制新 ticket + PUT

**`upload-queue` / `upload-client` / strip+inbox**

- `retry(id)` 时：若有 `sourceId`（interrupted 后），调用 **represign API** 取新 ticket，再 `put` + `complete`。  
- **禁止** `progress.ticket` 直接复用旧 `uploadUrl`。  
- 仍保留本地 `file.bytes`（队列已有）；无本地文件则无法 PUT → UI 提示「请重新选择文件上传」+ 引导材料库删除。

伪流程：

```text
retry(queueItem):
  ticket = await api.refreshUploadTicket(sourceId)  // Pipeline
  put(resolvePutUrl(ticket) | ticket.uploadUrl)
  complete(sourceId)
```

`resolveUploadPutUrl`：若本切片同时落地同域 staging（见 `upload-interrupt-understand-plan.md`），继续改写；与 represign **兼容**（新 URL 仍可 rewrite）。

### C. 材料库「重试上传」：禁止只 complete

**`inbox-panel.tsx`**

- 现：`uploadState===pending` → `retryComplete` only。  
- 改：pending 重试 =  
  1. 若上传队列仍持有同 `sourceId` 的本地文件 → 走 B。  
  2. 否则：无法静默成功 → toast/提示「原件不在本机会话，请重新上传或删除后重传」；**仍保留**「删除」快捷（stuck-pending）。  
- **不要**对空 staging 只调 complete（避免无效重试）。

可选 P0.1：材料库允许重新选文件绑定该 `sourceId` 再 PUT（范围更大，可第二刀）。

### D. 与 stuck-pending 共存

| 能力 | 保留 |
|---|---|
| 文案「上传未完成」 | 是 |
| pending 行「删除」 | 是 |
| 队列 failed「清除」 | 是 |
| 本 Plan | 只改「重试」语义与 PUT 错误详情 |

## 测试

- put-private：非 2xx message 含 status。  
- upload-client：PUT 失败 message 含 detail；resume **请求** represign mock，不 PUT 旧 URL。  
- upload-queue.retry：assert `refreshUploadTicket` called before put.  
- inbox-panel：pending 无本地文件时不调用 `retryComplete` alone（或调用后有明确失败提示——以最终实现为准）。  
- web tsc。

## 门禁 / 证据

```text
npx vitest run apps/web/src/features/opening/inbox/...
cd apps/web && npx tsc -p tsconfig.json --noEmit
```

证据：`upload-interrupt-client-represign-p0-implement.md` → Integrator Accept（可与 Pipeline 后端 Accept 同批）。

## 交接

1. Pipeline 确认/落盘后端 Plan 与路由名。  
2. 两边 Plan 一并交 Integrator。  
3. AGREE → Experience IMPLEMENT 客户端；Pipeline IMPLEMENT 后端。  
4. PM 授权后再 push/hermes。
