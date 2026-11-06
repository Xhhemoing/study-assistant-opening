# Understand + 最短 Plan：`上传中断，原件仍在本地。未标记为已上传。`

**Date:** 2026-10-10 ~21:42 CST  
**Owner:** Experience（UI/客户端；staging 代理路由建议本切片落地）  
**Status:** UNDERSTAND+PLAN — 待 Integrator 审后 IMPLEMENT  
**Paula 原文（hermes）：**「上传中断，原件仍在本地。未标记为已上传。」  
**HEAD tip：** `0489585`（以 box 为准）

## 文案出处（已定位）

| 文案 | 文件 | 触发条件 |
|---|---|---|
| **上传中断，原件仍在本地。未标记为已上传。** | `apps/web/src/features/opening/inbox/upload-client.ts` L87–94 | `begin` **已成功**，浏览器 **`deps.put`（XHR PUT）抛错** |
| 上传准备失败，原件仍在本地。 | 同文件 L68–73 | `begin` 失败 |
| 上传已暂存，但保存确认失败，仍可重试。 | 同文件 L96–105 | PUT 成功但 `complete` 失败 |
| XHR `onerror` → `Error("上传中断")` | `put-private.ts` L22 | 网络/CORS/不可达主机等 |

**不是** stuck-pending 文案（「上传未完成」）；那是材料库对已落库 `pending` 的标签。Paula 这句话是**上传队列失败 message**。

## 流程断点

```text
beginUpload  →  创建 SourceRecord (uploadState=pending, parseState=not_started)
     ↓
PUT ticket.uploadUrl（或 resolveUploadPutUrl 改写后的 URL）
     ↓  ← Paula 断在这里（message 精确匹配 PUT catch）
complete(sourceId)  →  校验 staging 对象 → uploaded + 排队解析
```

落库为何是 pending：begin 已写库；PUT 失败则**故意不调 complete**（「未标记为已上传」），源留在 pending。

## 根因（hermes 高置信）

1. `source-service.beginUpload` 用 `OpeningS3.presignPut`，endpoint 默认/`S3_ENDPOINT` = **`http://127.0.0.1:9000`**（hermes 本机 minio）。  
2. 浏览器拿到的 `uploadUrl` 指向 **用户机器访问不到的 127.0.0.1:9000**（或未对公网 CORS 的 minio）。  
3. `resolveUploadPutUrl` **只**把 `upload.local` / `__SOURCE_ID__` 改写成同域 `/api/opening/sources/:id/staging`；**真 presign 原样返回**。  
4. **不存在** `apps/web/src/app/api/opening/sources/[id]/staging` 路由（契约/测试期望有，磁盘无目录）→ 即便改写也会 404，除非本轮补上。  
5. XHR PUT 失败 → 上表文案；材料库见「上传未完成」+ 可删（P0′）。

次要可能：大文件/超时、预签过期、content-type 不匹配（也会进 PUT catch，需用 Network 状态码区分；当前 catch 吞掉具体 `上传对象失败 (status)`）。

## UI 如何标

| 表面 | 表现 |
|---|---|
| 助理/Inbox **上传队列** | `failed` + message「上传中断…」+「重试」「清除」 |
| 材料库 SourceRow | 「上传未完成」+「重试上传」(retryComplete，**若对象未 PUT 仍会失败**)+「删除」 |
| retryComplete | 仅 `complete`，**不会重做 PUT**；无 staging 对象时 complete 失败 |

## 最短 Plan（修根因）

### P0 — 同域 staging PUT（推荐，Experience 可落地）

1. **新增** `PUT /api/opening/sources/[id]/staging`：鉴权后读 body → `OpeningS3.putObject(stagingKey(id), bytes, { mime })`（校验 Content-Length/MIME 与 begin 记录一致，复用 upload-policy 边界）。  
2. **`resolveUploadPutUrl`**：对浏览器上传**一律**返回 `stagingPutUrl(sourceId)`（或：凡 `uploadUrl` host 为 loopback / 内网 minio 则改写）。保留 stub 分支。  
3. 更新 `api.test.ts`：presign 形如 `http://127.0.0.1:9000/...` 也改写到 staging。  
4. 可选：PUT catch 保留/展示 `err.message`（含 status），便于区分 CORS vs 4xx。  
5. 门禁：upload-client / api / staging route 单测 + web tsc。  
6. 证据 md → Integrator Accept；**不自推**；部署等 PM/Paula。

### 非本切片（可并行）

- Hermes：`S3_PUBLIC_ENDPOINT` + minio CORS（Data/运维）；不能替代同域 PUT 的稳妥性。  
- retry：pending「重试上传」应 **resume PUT+complete**（upload-client 已有 resume 字段）；Inbox `retryComplete`  alone 不够——可作 P0.1。

## 验收

- hermes 上小文件：队列不再出现该中断文案；complete 后变为可提问/解析中。  
- 故意断网仍可失败，但文案诚实；pending 可删。

## Review

请 Integrator 审根因与 P0 Plan；AGREE 后 Experience **立即 IMPLEMENT**（Paula/PM 要修）。
