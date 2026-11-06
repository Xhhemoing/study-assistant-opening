# Holistic upload/materials P1 — Pipeline G12 / G19 / G8 / G9 implement

**Date:** 2026-10-10 ~23:41 CST (Asia/Shanghai)  
**Branch tip at start:** `feat/opening-release` @ `3af5c01`  
**Owner:** Pipeline (this wave)  
**Status:** implemented locally — **no commit / push / stash / reset**

Companion: `docs/superpowers/plans/opening-release/holistic-upload-materials-audit-understand.md`, `.../holistic-upload-materials-audit-p0-plan.md` P1 backlog.

---

## What changed

### G12 — `extract-study-actions` in `createQueues` (must)

- `apps/worker/src/runtime/queue.ts`: added `"extract-study-actions"` to the kind list alongside parse / tutor / retest / remind / build-course-knowledge / parse-media.
- New `apps/worker/src/runtime/queue.test.ts`: asserts returned record includes that key and BullMQ queue name `opening-extract-study-actions`.
- Handler was already registered in `apps/worker/src/index.ts`; this closes the orphan-queue gap so outbox jobs are consumed.

### G19 — `PUBLIC_BASE_URL` fail-closed in production (must)

- `apps/web/src/features/opening/sources/source-service.ts` `stagingUploadUrl`:
  - If `PUBLIC_BASE_URL` trim-nonempty → use it.
  - If missing/blank and `NODE_ENV === "production"` → throw `PUBLIC_BASE_URL is required in production to mint staging upload URLs` (no loopback absolute URL).
  - Outside production → keep `http://127.0.0.1:3000` fallback so existing local/unit paths keep working.
- Extended `source-service.test.ts`: production missing → throw; production set → uses that base; non-production missing → loopback fallback.

### G8 — eml / legacy ppt honest stored-only (must)

- `apps/worker/src/jobs/parse-source.ts`: `message/rfc822` treated like legacy ppt — `markParseState(..., "unsupported")` and return `{ unsupported: true, storedOnly: true }` (no chunks, no Docling).
- Catch-all other non-PDF/PPTX mimes still return `{ unsupported: true }` without `storedOnly` (unchanged audio/etc.).
- Dropzone already rejects `.eml`/`.ppt` from default accept; email-import / API MIME remains accepted by contracts but parse is now honest stored-only.
- Tests: eml → unsupported + storedOnly; ppt still storedOnly; audio still unsupported without storedOnly.

### G9 — OCR readiness soft checklist + scanned-PDF copy (Pipeline + AI)

- `packages/ai/src/opening/ai-readiness.ts`:
  - Soft key: **`parser_ocr`** added to `AI_READINESS_SOFT_KEYS`.
  - Fact: `parserOcrReady: boolean` on `AiReadinessFacts`.
  - Builder item (Chinese):
    - ok: `扫描件 OCR 已配置`
    - not ok: `扫描件 OCR 未配置`
    - fixHint: `可选：扫描 PDF / 纯图片页需 OCR 才能提取文字；普通文字 PDF 与文字辅导不要求。在 worker 环境设置 PARSER_OCR_MODEL_DIR 指向离线 RapidOCR 模型目录。`
- `apps/web/src/app/api/opening/ai-readiness/route.ts`: `parserOcrReady = Boolean(process.env.PARSER_OCR_MODEL_DIR?.trim())`.
- Assistant checklist (minimal honesty so soft key does not hard-block legacy payloads): label + legacy soft-key fallback for `parser_ocr` in `ai-readiness.tsx` / `ai-readiness-model.ts`; soft rows stay out of the hard “AI 为何还不可用” list.
- Inbox `source-content.tsx` empty-text copy tightened: `图片或扫描页在未配置 OCR 时无法提取文字。` (Pipeline-owned honesty only; no restyle).

---

## Tests

Command:

```bash
npm test -- --project unit \
  apps/worker/src/runtime/queue.test.ts \
  apps/worker/src/jobs/parse-source.test.ts \
  apps/web/src/features/opening/sources/source-service.test.ts \
  packages/ai/src/opening/ai-readiness.test.ts \
  apps/web/src/features/opening/assistant/ai-readiness.test.ts \
  apps/web/src/features/opening/inbox/source-content.test.ts
```

Result: **6 files, 54 tests passed** (vitest 4.1.10).

---

## Files touched (this Pipeline wave)

| Path | Gap |
|---|---|
| `apps/worker/src/runtime/queue.ts` | G12 |
| `apps/worker/src/runtime/queue.test.ts` (new) | G12 |
| `apps/web/src/features/opening/sources/source-service.ts` | G19 |
| `apps/web/src/features/opening/sources/source-service.test.ts` | G19 |
| `apps/worker/src/jobs/parse-source.ts` | G8 |
| `apps/worker/src/jobs/parse-source.test.ts` | G8 |
| `packages/ai/src/opening/ai-readiness.ts` | G9 |
| `packages/ai/src/opening/ai-readiness.test.ts` | G9 |
| `apps/web/src/app/api/opening/ai-readiness/route.ts` | G9 |
| `apps/web/src/features/opening/assistant/ai-readiness.tsx` | G9 (soft label / filter) |
| `apps/web/src/features/opening/assistant/ai-readiness-model.ts` | G9 |
| `apps/web/src/features/opening/assistant/ai-readiness.test.ts` | G9 |
| `apps/web/src/features/opening/inbox/source-content.tsx` | G9 copy |

---

## Explicit non-goals

- No commit / push / stash / reset.
- Did not touch untracked `docs/superpowers/evidence/2026-10-09-opening-release/rp5-gha…`.
- No migrations invented.
- No full eml→chunks extraction.
- No Experience UI restyle / materials filter ownership beyond soft-checklist honesty + empty-text OCR copy.
- No hermes deploy / MemoryMax / Docling ops.
- Left parallel Data work on `packages/database/.../opening-sources*` and `holistic-upload-p1-g4-data-implement.md` alone (not part of this wave).
- Did not edit `tasks.json` verified rows.

---

## Note for @AIstudy AI (G9 / G18 align)

| Field | Value |
|---|---|
| Soft key | `parser_ocr` |
| Fact field | `parserOcrReady` (from `PARSER_OCR_MODEL_DIR` trim nonempty) |
| Detail (ok) | `扫描件 OCR 已配置` |
| Detail (not ok) | `扫描件 OCR 未配置` |
| fixHint | `可选：扫描 PDF / 纯图片页需 OCR 才能提取文字；普通文字 PDF 与文字辅导不要求。在 worker 环境设置 PARSER_OCR_MODEL_DIR 指向离线 RapidOCR 模型目录。` |
| Severity | soft only — must not hard-block text tutor / AI-unavailable |

G18 budget UX remains AI-owned; this wave only adds the soft OCR checklist row + fact plumbing.

---

## Suggested Accept focus (Integrator)

1. G12: `createQueues` keys include `extract-study-actions`; unit test green.
2. G19: production missing `PUBLIC_BASE_URL` throws; set URL used; non-prod fallback still loopback.
3. G8: eml + ppt → `unsupported` + `storedOnly: true`; no chunks.
4. G9: `parser_ocr` soft; missing OCR does not hard-block; route wires `PARSER_OCR_MODEL_DIR`.
5. Confirm Data G4 / `opening-sources` diffs are a separate Accept lane (not this evidence).
