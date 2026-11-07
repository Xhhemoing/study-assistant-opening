# Understand：上传中断 → `pending` + `not_started`（只读）

**Date:** 2026-10-10 ~21:42 CST (Asia/Shanghai)  
**Owner:** Pipeline (AIstudy)  
**Branch:** `feat/opening-release` @ `0489585`  
**Status:** UNDERSTAND ONLY — 未改产品代码；未 commit/push  
**Paula（via PM）：**「上传中断，原件仍在本地。未标记为已上传。」  
**对照：** Experience stuck-pending P0′（UI 删除/文案，已有 plan/accept）— 本文件只查 ingest/complete 根因，不重排他们的 P0。

---

## 1. Happy path vs leftover pending

### Happy path

```
client resolveMime + sha256
  → POST /api/opening/sources          beginUpload
       repo.create → upload_state=pending, parse_state=not_started
       storage.presignPut(stagingKey, mime, bytes, 900s)
  → PUT uploadUrl (XHR putPrivateBytes, Content-Type=mime)
  → POST /api/opening/sources/:id/complete   completeUpload
       headObject(staging) must exist
       streamDigest → magicMatchesMime(firstBytes, declared mime)
       validateStoredUpload(bytes + sha256 + mime)
       completeWithParseJob → upload_state=uploaded, parse_state=queued + job/outbox
       copyStagingToFinal; delete staging
```

成功后 **不会** 再停在 `pending`/`not_started`。`completeWithParseJob` 原子地把两者推到 `uploaded`/`queued`（`packages/database/.../opening-sources.ts`）。

### Leftover：`uploadState=pending` + `parseState=not_started`

任一路径在 **complete 成功写库之前** 停下，行就会永久停在 begin 初值：

| 何时停下 | 客户端可见文案（`upload-client.ts`） | 库内状态 |
|---|---|---|
| begin 失败（网络/校验） | 「上传准备失败，原件仍在本地。」 | **无行**（create 未成功） |
| begin 成功，**PUT 失败/中断** | **「上传中断，原件仍在本地。未标记为已上传。」** ← Paula | `pending` + `not_started` |
| PUT 成功，**complete 失败** | 「上传已暂存，但保存确认失败，仍可重试。」 | 仍 `pending` + `not_started`（校验失败不改态） |
| begin 后用户关闭页 / 未再 PUT | （无队列消息；材料库显示「等待上传完成」/Experience 将改「上传未完成」） | 同上 |

**关键点：** Paula 原文 = `upload-client.ts` PUT `catch`（约 L87–94），由 `put-private.ts` 的 `xhr.onerror` / `onabort` / 非 2xx `onload` 抛出。此时 **原件未标 uploaded 是正确行为**；副作用是 begin 已落库一行 pending。

---

## 2. Root-cause candidates（按可能性排序）

1. **Staging PUT 网络中断 / abort / 非 2xx**（最贴 Paula）  
   - **何时：** XHR PUT 中途断网、取消、CORS/代理、S3/MinIO 返回 4xx/5xx。  
   - **路径：** `apps/web/.../inbox/put-private.ts` → `upload-client.ts` PUT catch。  
   - **结果：** DB `pending`/`not_started`；staging 可能空或半截（MinIO 通常整对象原子，半截多不落地）。

2. **Presigned URL 过期（900s）后队列重试仍用旧 ticket**  
   - **何时：** begin 后 >15min 再 `upload-queue.retry`；resume 复用 `item.ticket.uploadUrl`，**不会** 再 `begin` / 再 `issueUploadTicket`。  
   - **路径：** `source-service.ts` `expiresInSeconds: 900`；`upload-queue.ts` resume；`upload-client.ts` `resumeSourceId`+`ticket`。  
   - **结果：** PUT 403/失败 → 同 Paula 文案；库内仍 pending。

3. **材料库「重试上传」只调 complete、不重 PUT**  
   - **何时：** 用户在 Inbox `SourceRow` 对已落库 pending 点「重试上传」。  
   - **路径：** `inbox-panel.tsx` `onRetry` → `client.retryComplete(id)` → 仅 `POST .../complete`。  
   - **结果：** 若 staging 无对象 → `UploadPolicyError("upload not found; PUT to uploadUrl first")`；pending 不变。对 Paula「PUT 从未成功」场景，**重试无效**（需本地文件再 PUT；Experience/客户端缺口）。

4. **Presign 签名绑定 Content-Type + ContentLength，PUT 头/体不一致**  
   - **何时：** 客户端 `Content-Type` ≠ ticket mime，或 body 长度 ≠ begin 申报 `bytes`（签名含两者：`opening-s3.ts` `PutObjectCommand`）。  
   - **路径：** `packages/database/.../opening-s3.ts` `presignPut`；`put-private.ts` 设 `content-type`。  
   - **结果：** S3 拒 PUT → Paula 文案；通常无 staging 对象。

5. **Complete 校验失败（magic / bytes / sha）留下 pending**  
   - **何时：** PUT 已成功，但对象与 ticket 不符（见 §3）。  
   - **路径：** `source-service.ts` `completeUpload`；`upload-policy.ts`；`magic.ts`。  
   - **结果：** 抛错、**不** 改 `upload_state`（集成测明确「leaving the source pending」）。客户端文案是「上传已暂存…仍可重试」而非 Paula 句——若测试复现 Paula 句，更偏 PUT 阶段。

6. **Complete 其它服务端失败（staging 缺失、copy、privacy epoch、存储 503）**  
   - **何时：** head 无对象；`copyStagingToFinal` etag 不匹配；workspace `privacy_epoch` 变了；S3 `OpeningStorageError`。  
   - **路径：** `completeUpload` / `completeWithParseJob`；`complete/route.ts` 映射 400/404/503。  
   - **结果：** 仍 pending；客户端「保存确认失败」。

7. **Begin 成功后从未 PUT（设计内残留）**  
   - **何时：** 选文件后 begin 返回、用户离开；或 begin 后立即失败在 PUT 之前。  
   - **路径：** `opening-sources.ts` `create` 固定 `'pending','not_started'`。  
   - **结果：** 运维/hermes 上多条 stuck pending 的常见来源；**不是 complete bug**（见 §4）。

---

## 3. Complete failure taxonomy

全部在 `completeUpload`；失败时 **不** 写 `uploaded`/`queued`（idempotent 仅当已是 `uploaded`）。HTTP：`UploadPolicyError` → 400 `UPLOAD_MISMATCH`；`OpeningStorageError` → 404/503。

| 类别 | 触发条件 | 错误信号 | 是否改态 |
|---|---|---|---|
| **Staging 缺失** | `headObject` `exists=false`（未 PUT / 已删 / 错 ID） | `"upload not found; PUT to uploadUrl first"` | 否 → pending |
| **Magic / MIME** | `magicMatchesMime(firstBytes, source.mime) === false`（含未知 mime → false） | `"stored object magic bytes do not match declared MIME"` | 否 → pending |
| **Size (bytes)** | digest.bytes ≠ ticket.bytes | `validateStoredUpload` / `"stored bytes … != expected …"` | 否 → pending |
| **SHA-256** | digest.sha256 ≠ ticket.sha256（大小写不敏感） | `"stored sha256 does not match expected"` | 否 → pending |
| **MIME 字段** | actual.mime ≠ expected.mime（complete 用 declared `source.mime`，通常不因 head ContentType 漂移） | `"stored mime … != expected …"` | 否 → pending |
| **Repo assertMatch** | `completeWithParseJob` 内二次校验 | `OpeningSourceError VALIDATION` `"stored object does not match upload ticket"` | 否 |
| **Privacy epoch** | workspace epoch ≠ 入参 | `CONFLICT` `"Workspace privacy settings changed; retry the upload"` | 否 |
| **Copy / etag** | `copyStagingToFinal` `CopySourceIfMatch` 失败 | `OpeningStorageError` | 否（事务前/内 beforeComplete） |
| **Presign 过期** | 影响 **PUT**，不是 complete 本身；过期后无对象 → 归入 staging 缺失 | PUT 非 2xx → Paula 文案 | pending |
| **网络 abort before complete** | PUT 未完成或 complete 请求未达 | Paula 句 **或** 「保存确认失败」 | pending |
| **Begin 体积上限** | `uploadInputSchema` 超 MIME 上限（图 20MiB / 文档 50 / 音频 200 / 视频 512 / eml 25） | begin 400；**无行** | N/A |

**Magic 覆盖：** `packages/database/src/storage/magic.ts`（pdf/jpeg/png/webp/mp4/mpeg/wav/webm/pptx zip、ppt OLE、text/html/md/eml 无 NUL）。无签名 mime → magic 失败。

**注意：** schema 有 `uploadState=rejected`，但 complete 校验失败路径 **不会** 自动标 `rejected`；失败行继续是 `pending`。

---

## 4. What is NOT a bug

- **`begin` 创建 `pending`/`not_started` 且尚未 PUT** — 设计如此（`opening-sources.ts` INSERT）。没有「超时自动 rejected」生命周期。  
- **Complete 校验失败保持 pending** — 有意：避免假 uploaded；允许在 staging 仍在时重试 complete。  
- **「未标记为已上传」在 PUT 中断时** — 正确；问题是 **孤儿 pending 行 + UI 像仍在传 + 材料库 retry 不能重 PUT**。  
- **Experience stuck-pending P0′（删除快捷 +「上传未完成」文案）** — 缓解发现性/清理，**不** 修 ingest 根因；勿与本 Pipeline 切片抢活。

---

## 5. Suggested next owners

| Owner | 建议 |
|---|---|
| **Pipeline** | （可选）complete 失败是否应标 `rejected`+可读 error；staging 生命周期/GC；是否提供「reissue upload ticket」API（新 presign、同 source id）；presign/PUT 失败可观测性。 |
| **Experience** | 已在做 stuck-pending UI；另议：材料库「重试上传」对无 staging 的 pending 应引导 **重新选本地文件再 PUT**（或接 reissue），勿只 `retryComplete`；队列过期 ticket 应重新 begin 或 reissue 而非死磕旧 URL。 |
| **勿做（本 Understand）** | 不改产品代码；不 commit/push；不重排 Experience P0′。 |

---

## 6. Explicit：read-only

本轮只新增本 evidence 文件。未改 `apps/`、`packages/`、`tasks.json`；未 commit；未 push。

### 引用文件

- `apps/web/src/features/opening/sources/source-service.ts` — begin/complete  
- `apps/web/src/features/opening/sources/upload-policy.ts` — bytes/sha/mime  
- `apps/web/src/app/api/opening/sources/route.ts` — begin  
- `apps/web/src/app/api/opening/sources/[id]/complete/route.ts` — complete  
- `packages/database/src/repositories/opening-sources.ts` — create pending/not_started；completeWithParseJob  
- `packages/database/src/storage/opening-s3.ts` — presignPut / staging / digest / copy  
- `packages/database/src/storage/magic.ts` — magicMatchesMime  
- `apps/web/src/features/opening/inbox/upload-client.ts` — Paula 文案；interrupt 分相  
- `apps/web/src/features/opening/inbox/put-private.ts` — XHR PUT  
- `apps/web/src/features/opening/inbox/upload-queue.ts` / `inbox-panel.tsx` — 队列 resume；材料库 retryComplete（cite only）  
- Experience 对照：`stuck-pending-upload-understand.md` / `stuck-pending-upload-p0-*.md`

---

## PM 补充（2026-10-10 ~21:42）

确认：Paula 原文出自 `upload-client.ts` PUT catch（`put-private.ts` `xhr.onerror` / abort / 非 2xx）。**优先查 staging PUT / MinIO CORS / 预签名 URL，不是 complete。**  
Complete 失败有另一套文案（「上传已暂存…仍可重试」）。运维排查 hermes 时先看浏览器 Network 对 staging PUT：CORS preflight、403 签名、过期、Content-Type/Length 是否与 begin 一致。
