# Understand：上传/解析路径缺口（只读，未改代码）

**Date:** 2026-10-10 ~12:26 CST (Asia/Shanghai)  
**Owner:** Pipeline (AIstudy)  
**Branch:** `feat/opening-release` @ `697d1d6`  
**Status:** UNDERSTAND ONLY — 未改产品代码；未改 `tasks.json`；未 commit/push  
**Paula:** 测试并解决很多小问题，尤其「上传文件解析不完善」  
**对照计划:** `docs/superpowers/plans/2026-10-04-opening-upload-flow.md`；`opening-release/02-ingestion.md`；`10-media-knowledge.md` §V01；`14-loop-closure.md` §DL8  
**已引证据:** DL8 (`dl8-image-vision.md` / accept)；V01 (`v01-verified.md` 等)；RP5 (`rp5-upload-desktop-queued-accept.md`)；删除入口另见 Experience `upload-delete-understand.md`（本文件不改 Experience 树）

---

## 范围 / 对照闭环

材料上传闭环（本文件只盘点 ingest→parse，不实施）：

`beginUpload` → 客户端 PUT staging → `completeUpload`（magic/bytes/sha256）→ `completeWithParseJob`（`parse_state=queued` + outbox）→ worker `parse` | `parse-media` → `replaceChunks`→`ready` **或** `markParseState(unsupported|failed)` / job-failure→`failed`。

UI 轮询：`shouldRefreshSources` 在 `queued|running|not_started` 时刷新；标签见 `sourceStatusLabel`。

---

## 路径地图

| 步骤 | 关键文件 |
|---|---|
| MIME/大小契约 | `packages/contracts/src/opening/sources.ts`（白名单；图 20MiB / 文档 50MiB / 音频 200MiB / 视频 512MiB / eml 25MiB） |
| 客户端 MIME + 文案 | `apps/web/src/features/opening/inbox/upload-state.ts`；`upload-client.ts`；`upload-dropzone.tsx`（`openingUploadAccept`） |
| begin / complete / retry API | `apps/web/src/app/api/opening/sources/route.ts`；`[id]/complete/route.ts`；`[id]/retry/route.ts` |
| 策略 + 服务 | `apps/web/src/features/opening/sources/upload-policy.ts`；`source-service.ts`（`magicMatchesMime` + `completeWithParseJob` / `retryParse`） |
| Magic bytes | `packages/database/src/storage/magic.ts` |
| 完成并入队 | `packages/database/src/repositories/opening-sources.ts`（`completeWithParseJob`、`parseJobKindForMime`、`retryParseWithJob`） |
| Job 失败回写 source | `packages/database/src/repositories/opening-job-failure.ts` |
| ready 写回 | `packages/database/src/repositories/opening-source-chunks.ts`（`replaceChunks` → `parse_state='ready'`） |
| 文档/图解析 | `apps/worker/src/jobs/parse-source.ts`；Docling `services/parser/opening_parser/__main__.py`（默认 `do_ocr=False`） |
| 媒体解析 | `apps/worker/src/jobs/parse-media.ts`；`parsers/media-process.ts`；`parsers/transcribe-adapter.ts` |
| UI 状态 | `upload-state.ts`（`sourceStatusLabel`）；`source-row.tsx`；`source-refresh.ts`；`inbox-panel.tsx`；`media-reader.tsx`；助理 `upload-strip.tsx` |
| 手工 eml | `apps/web/src/app/api/opening/imports/email/route.ts` → 同一 `completeUpload` |

`parseJobKindForMime`：`video/*`|`audio/*` → `parse-media`；其余 → `parse`。

---

## 已知缺口清单

（仅代码或已引证据核实；严重度相对 Paula「解析不完善」）

1. **图片解析无 OCR，仅空文本 + `imageObjectKey`** — 非视觉模型时辅导拒答；有视觉才可用。  
   **路径:** `apps/worker/src/jobs/parse-source.ts`（`IMAGE_SOURCE_MIMES`）；`opening-source-chunks.ts`  
   **严重度:** high（常见作业/板书路径）  
   **计划/证据:** DL8 已 verified 边界；已知 OCR 空串 OK、集成测缺失（`dl8-image-vision.md`）

2. **音/视频转写依赖 offline whisper；未配置时 `parseState=failed` 且未写入 `error` 载荷** — `markParseState(..., "failed")` 无 error；UI 仅「解析失败」+可重试，重试仍失败。  
   **路径:** `apps/worker/src/jobs/parse-media.ts`（`blocked_not_configured`）；`upload-state.ts`  
   **严重度:** high（音频可上传）  
   **计划/证据:** V01 `v01-verified.md` 明确 faster-whisper / weights 未装

3. **`.eml` / `message/rfc822` 可上传与手工导入，但 `parse-source` 落入 unsupported** — 无正文→chunk。  
   **路径:** `upload-state.ts` / `upload-dropzone.tsx`；`imports/email/route.ts`；`parse-source.ts`（非 md/html/image/pdf/pptx → unsupported）  
   **严重度:** med  
   **计划/证据:** C02 手工导入保存原件；契约允许 MIME；解析侧未接 mail→chunks

4. **旧版 `.ppt`（`application/vnd.ms-powerpoint`）明确 `unsupported` + storedOnly** — accept 列表含 `.ppt`，用户易以为能抽字。  
   **路径:** `upload-dropzone.tsx`；`parse-source.ts`  
   **严重度:** med  
   **计划/证据:** I02「显式 fallback」诚实行为；仍是产品感知缺口

5. **`retryParseWithJob` 仅允许 `parseState=failed`** — `unsupported`（eml/ppt 等）无法「重新解析」；Inbox 只对 failed 挂 retry。  
   **路径:** `opening-sources.ts`；`inbox-panel.tsx`  
   **严重度:** med  
   **计划/证据:** 上传流 Task3 按 failed 设计；与 3/4 叠加

6. **DL8 长边 >2048 缩放派生未做** — `imageObjectKey` 指向原件 `finalKey`。  
   **路径:** `parse-source.ts`；证据 `dl8-image-vision.md` Known gaps  
   **严重度:** low（PM 不阻塞 DL8）  
   **计划/证据:** 有

7. **前端 dropzone 不接受视频**（契约/worker 支持 `video/mp4|webm`）— UI `openingUploadAccept` 无 `.mp4/.webm`。  
   **路径:** `upload-dropzone.tsx` vs `packages/contracts/.../sources.ts` + `parse-media.ts`  
   **严重度:** med（能力与入口不一致；非「已上传却解析不了」）  
   **计划/证据:** V01 worker 侧 verified；UI 入口未对齐

8. **PDF OCR 默认关** — Docling `do_ocr=False`，仅当 `PARSER_OCR_MODEL_DIR` 备齐才开；扫描件易「ready 但无字」。  
   **路径:** `services/parser/opening_parser/__main__.py`  
   **严重度:** med  
   **计划/证据:** I02「OCR unavailable 时保留原件」；与缺口 1 同类

9. **`media-reader` 将 `failed` 与 `unsupported` 合成同一文案「原件已保存，解析失败」** — Inbox 标签可区分「暂不能提取文字」。  
   **路径:** `apps/web/src/features/opening/sources/media-reader.tsx` vs `upload-state.ts`  
   **严重度:** low（解析 UX；属 Experience 表面，Pipeline 仅记录）  
   **计划/证据:** 代码核实；删除/发现性见 `upload-delete-understand.md`（Experience，不改）

10. **DL8 集成测与浏览器未跑** — `tests/integration/opening-image-source.test.ts` 缺失。  
    **路径:** 证据 `dl8-image-vision.md`  
    **严重度:** low（门禁债，非运行时逻辑）  
    **计划/证据:** 有

---

## 明确「非缺口 / 已正确行为」

- **`completeWithParseJob` 后 `parseState=queued` 并入队**（非 `not_started`）— `opening-sources.ts`；RP5 `rp5-upload-desktop-queued-accept.md`。
- **Complete 校验** bytes/sha256/mime + magic — `upload-policy.ts`；`source-service.ts`；`magic.ts`。
- **HEIC/HEIF 拒绝并提示「请导出为 JPG 后上传」** — `upload-state.ts`（DL8）。
- **JPEG/PNG/WebP → page-1 chunk + image key → ready**（空文本允许）— DL8 parse half。
- **PDF / PPTX 走 Docling 文本路径**；md/html 本地切 chunk。
- **旧 PPT / 未知 MIME → unsupported，原件保留** — 诚实 fallback，不是静默假 ready。
- **隐私 epoch 变更丢弃 job；仅 failed（非 PRIVACY_EXCLUDED）可 retry** — 设计如此。
- **上传队列「失败无清除」** — 属 Experience `upload-delete-understand.md`，**不是**本 Pipeline parse 切片；此处不立项改 UI 树。

---

## 建议下一步 Plan 切片（仅建议，不实施）

1. **P0-parse:** eml（及可选邮件正文）→ chunks，或上传/导入侧诚实标「仅存原件」并避免暗示可提问。  
2. **P0-media-UX:** whisper 未配置时写清 `error`（或 `unsupported`）+ 用户可读原因；避免空 error 的「解析失败」死循环重试。  
3. **P1:** 扫描 PDF / 图片 OCR 开关与离线模型就绪说明（对齐 DL7 readiness）。  
4. **P1:** dropzone 与契约对齐（加视频扩展名，或契约/文案标明视频仅 API）。  
5. **P2:** DL8 长边缩放；补 `opening-image-source` 集成测。  
6. Experience 并行：失败队列清除 / 材料库发现性 — 见 `upload-delete-understand.md`，勿与本 parse Plan 抢 commit。

---

## 未改代码、未推送

本轮只新增本 evidence 文件；未改产品代码、未改 `tasks.json`、未 commit、未 push。
