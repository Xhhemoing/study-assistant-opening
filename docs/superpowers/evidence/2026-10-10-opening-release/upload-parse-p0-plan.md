# Plan：上传/解析 P0（whisper 可读失败 + ppt/eml 诚实）

**Date:** 2026-10-10 ~12:38 CST (Asia/Shanghai)  
**Owner:** Pipeline (AIstudy)  
**Branch:** `feat/opening-release`  
**Status:** **PLAN_ONLY** — 不写产品代码；不改 `tasks.json`；不 commit/push  
**依据：** `upload-parse-gaps-understand.md`；Integrator **AGREE**（`upload-parse-gaps-integrator-review.md`）；Paula/PM brief（本 Plan 仅规划）  
**显式约束：** **待 Integrator AGREE + PM 授权后再 IMPLEMENT**；本文件不是实施许可

---

## Goal

1. **音/视频在 whisper 未配置时**：`markParseState(..., "failed")` **必须**写入可读 `error` 载荷（`blocked_not_configured` + 中文面向用户的原因）；UI 展示该原因，避免用户对着空「解析失败」无限重试。  
2. **`.ppt` / `.eml` 误导**：选定**一种**最小清晰 UX，不再暗示「可抽字」；上传后或入口侧诚实对待「仅存原件 / 暂不能提取」。

## Non-goals（本 P0）

- **不**安装 / 配置 faster-whisper、OCR 模型、Docling OCR 开关（全量 OCR/whisper 安装已拒为 P0）  
- **不**改 delete API / 不叠 Experience `upload-delete` P0 未推工作（仅在展示 parse error 所必需时碰 Inbox/source-row 标签）  
- **不**发明 migration / 不缩 contracts MIME 白名单（`message/rfc822`、旧 PPT MIME 仍可被契约与 email import 接受）  
- **不**做 eml 正文→chunks、旧 ppt→pptx 转换  
- **不**做视频 dropzone 与契约对齐（P1）  
- **不** commit / push / 改 `tasks.json` 状态

---

## Slice 1 — whisper 未配置：可读 `error` + UI 表面

### 根因（已核实）

`apps/worker/src/jobs/parse-media.ts` 在 `transcription === "blocked_not_configured"` 时：

```ts
await deps.sources.markParseState(scope, source.id, "failed");
// 未传第 4 参 error；job return 里的 error 字符串未落库
```

`OpeningSourceRepository.markParseState(scope, id, state, error?)` **已支持**写 `error`（见 `packages/database/.../opening-sources.ts`）。  
`apiFailureSchema`：`{ code, message, retryable }`（`packages/contracts/.../foundation.ts`）。  
对照：`opening-job-failure.ts` 已写同类载荷（如 `PARSE_FAILED` / `PRIVACY_EXCLUDED`）。

UI：`sourceStatusLabel` 对任意 `failed` 一律「原件已保存，解析失败」，仅特殊处理 `PRIVACY_EXCLUDED`；`source-row` 对非隐私失败仍挂「重新解析」→ 空重试循环。

### 行为

| 步骤 | 期望 |
|---|---|
| whisper / transcribe adapter 未配置（audio-only 或 video 无可用转写） | `markParseState(..., "failed", error)`，`error` 形如 `{ code: "blocked_not_configured", message: "<中文可读原因>", retryable: false }` |
| `message` 文案（建议定稿，IMPLEMENT 可微调措辞） | 例如：「转写服务未配置（需 faster-whisper），原件已保存；配置完成前重试无效。」 |
| Inbox / SourceRow 标签 | `sourceStatusLabel` 在 `parseState===failed` 且存在 `error.message` 时优先展示该 message（隐私码仍优先） |
| 重试按钮 | 当 `error.retryable === false`（含本码与既有隐私）时**不展示**「重新解析」，避免空重试；`retryable: true` 的失败仍可重试 |
| media-reader | 薄改：failed/unsupported 文案优先走 `sourceStatusLabel(source)`（或同类），不再把配置失败与「暂不能提取」糊成同一句「解析失败」 |

### 文件

| 文件 | 改动 |
|---|---|
| `apps/worker/src/jobs/parse-media.ts` | 两处 `blocked_not_configured` → `failed` 调用补上 `error` 第 4 参（audio-only 与 video 分支一致） |
| `apps/worker/src/jobs/parse-media.test.ts` | 断言 `markParseState` 收到 `failed` **且** `error.code === "blocked_not_configured"`、`retryable === false`、`message` 非空 |
| `apps/web/src/features/opening/inbox/upload-state.ts` | `sourceStatusLabel`：failed 时展示 `error.message`（若有） |
| `apps/web/src/features/opening/inbox/upload-state.test.ts` | 覆盖 blocked_not_configured / 通用 failed / PRIVACY 优先级 |
| `apps/web/src/features/opening/inbox/source-row.tsx` | 重试条件：`onRetry && error?.code !== "PRIVACY_EXCLUDED"` → 改为尊重 `error?.retryable !== false`（或显式排除 `blocked_not_configured`）；与 Inbox 挂载一致 |
| `apps/web/src/features/opening/inbox/inbox-panel.tsx` | 与 SourceRow 同一重试门闩（现有 `error?.code !== "PRIVACY_EXCLUDED"`） |
| `apps/web/src/features/opening/sources/media-reader.tsx`（若需） | `mediaReaderStateCopy("parse_failed_original_saved")` 或渲染处改用带 error 的 `sourceStatusLabel` |
| 相关 `*.test.ts`（source-row / media-reader） | 断言标签含配置原因；非 retryable 无「重新解析」 |

### 不做

- 不改 `parseJobKindForMime` / 不装 whisper  
- 不改 job-failure 路径（已有 error）  
- 不扩 Experience 删除/队列清除（属另一条 P0）

---

## Slice 2 — `.ppt` / `.eml` 诚实（选定一种方案）

### 决策（最小清晰 UX）

**从 dropzone accept 移除 `.ppt` 与 `.eml`，并更新拒绝文案；保留 contracts MIME + 手工 email import。**

理由：

- 解析侧已诚实：旧 PPT → `unsupported` + `storedOnly`（`parse-source.ts`）；eml → 落入 `unsupported`（无正文→chunks）。  
- 误导主因在**入口**：`openingUploadAccept` 与「支持类型」文案把它们与 PDF/PPTX 并列。  
- 移除 accept = 文件选择器/拖拽不再假装可抽字；比「先上传再等 unsupported」更短、更清晰。  
- **不**缩 `packages/contracts/.../sources.ts` 白名单 → 无 migration；C02 手工 `.eml` 导入（`apps/web/src/app/api/opening/imports/email/route.ts`）继续存原件，UI 已用 `unsupported` →「原件已保存，暂不能提取文字」。  
- 用户要课件请用 `.pptx`（Docling 文本路径已通）。

**拒绝的替代：** 本 P0 不做「keep accept + 仅靠 post-upload 标签」为主方案（入口仍误导）；不做 eml→chunks / ppt 转换。

### 行为

| 入口 | 期望 |
|---|---|
| Dropzone / 文件选择 | `openingUploadAccept` **不含** `.ppt`、`.eml`；`typeLabels` 同步去掉；`supportedUploadTypesLabel` 不再列出 PPT/EML |
| 拖入 `.ppt` / `.eml` | `isAcceptedUploadFile` 拒绝；rejection 文案含「不支持…」+ 当前支持类型（诚实列表） |
| `resolveUploadMime` / `BY_EXTENSION` | **保留** `ppt` / `eml` 映射（email import 与契约仍可能用到 MIME；不假装 dropzone 接受） |
| 手工 email import `.eml` | 行为不变：complete → parse → `unsupported`；Inbox 标签「原件已保存，暂不能提取文字」；**无**「重新解析」（retry 仅 failed） |
| API/契约仍上传旧 PPT | 仍 `unsupported` + storedOnly；标签同上 |

可选薄文案（若 email import UI 有可见提示）：一句「邮件原件仅保存，暂不能提取正文用于提问」——仅当现成组件有挂载点；不新开 Experience 大改。

### 文件

| 文件 | 改动 |
|---|---|
| `apps/web/src/features/opening/inbox/upload-dropzone.tsx` | 从 `openingUploadAccept` / `typeLabels` 去掉 `.ppt`、`.eml` |
| dropzone 相关测试（若有；否则补最小测） | accept 字符串断言；`.ppt`/`.eml` → `isAcceptedUploadFile` false；`.pptx`/`.pdf` 仍 true |
| `apps/web/src/features/opening/inbox/upload-state.ts` | **不删** `BY_EXTENSION` 的 ppt/eml（除非 IMPLEMENT 时证明无调用方）；`unsupported` 标签保持「原件已保存，暂不能提取文字」 |
| `apps/worker/src/jobs/parse-source.ts` | **本 Slice 默认不改**（已 unsupported）；若 IMPLEMENT 发现 eml 与 ppt 不一致，可给 eml 同样 `{ unsupported: true, storedOnly: true }` 返回值，**仍无** error 载荷要求（unsupported ≠ failed） |
| `apps/web/src/app/api/opening/imports/email/route.ts` | 不改 API；可选只读注释「仅存原件」 |
| `packages/contracts/src/opening/sources.ts` | **不改** |

### 测试

- Dropzone accept / `isAcceptedUploadFile`：ppt/eml 拒、pptx/pdf/音频仍收  
- `sourceStatusLabel({ parseState: "unsupported" })` 仍为「原件已保存，暂不能提取文字」  
- 既有 `parse-source` unsupported（ppt）测不回退  

---

## P1 parking lot（只记，不写 IMPLEMENT 切片）

| 项 | 说明 |
|---|---|
| PDF / 图片 OCR | Docling `do_ocr=False`；图片 DL8 空文本 + vision；对齐 readiness，非本 P0 |
| 视频 dropzone vs contracts | 契约/worker 支持 `video/mp4|webm`，`openingUploadAccept` 无视频扩展名 — 另开 P1 对齐入口或文案 |
| DL8 长边缩放 / 缺集成测 | 低优先级债 |
| eml 正文→chunks | 产品能力增强，非诚实标 P0 |

---

## Acceptance criteria（供 Integrator）

1. **Slice 1：** 未配置 whisper 时，source 行 `error.code === "blocked_not_configured"`，`message` 非空中文可读，`retryable === false`；UI 标签展示该原因；用户看不到对该条的「重新解析」。  
2. **Slice 1 回归：** whisper 可用时转写路径不变；job-failure / PRIVACY 路径不被破坏。  
3. **Slice 2：** 默认 dropzone 无法选中/拖入 `.ppt`/`.eml`；拒绝文案不把它们列为可提取类型；`.pptx` 等可提取类型仍接受。  
4. **Slice 2：** 手工 `.eml` import 仍可存原件，parse 为 `unsupported`，标签诚实「暂不能提取」。  
5. **范围：** 无 migration；未改 delete API；未装 whisper/OCR；未碰 `tasks.json` / 未要求本 Plan 阶段 commit。  
6. **门禁：** 相关 unit 测绿（parse-media + upload-state + dropzone/source-row 触及处）。

---

## Explicit

**本文件仅为 Plan。**  
**禁止 IMPLEMENT**，直至：

1. Integrator 对本 Plan **AGREE**，且  
2. PM **明确授权**实施。

授权前：不改产品代码、不改 `tasks.json` 状态、不 commit、不 push。
