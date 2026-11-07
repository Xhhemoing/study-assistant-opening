# DL8 accept — Photo sources as direct vision input

**Date:** 2026-10-09 ~16:52 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release`  
**Workspace:** `/workspace/study-assistant-opening`  
**Scope:** Agent accept against `docs/superpowers/plans/opening-release/14-loop-closure.md` § DL8 (model half + parse half).  
**Verdict:** **ACCEPT** overall (both halves **ACCEPT**; agent-owned; **not verified**)  
**Browser:** **not run** — do not claim browser pass.  
**tasks.json:** **not edited**. **verified:** **not marked**.

## Halves

| Half | Owner split | Verdict |
|---|---|---|
| Model (AI) | `tutor-turn.ts`, `tutor-chunks.ts`, `packages/ai` `selectContext` | **ACCEPT** |
| Parse (Pipeline) | `parse-source.ts`, `source-page-images.ts`, `opening-source-chunks`, upload-state/client | **ACCEPT** |
| **Overall agent accept** | both halves | **ACCEPT** |

## Files reviewed

**Model half**
- `apps/worker/src/jobs/tutor-turn.ts` (+ `tutor-turn.test.ts`)
- `apps/worker/src/jobs/tutor-chunks.ts` (+ `tutor-chunks.test.ts`)
- `packages/ai/src/opening/context.ts` (+ `context.test.ts`)

**Parse half**
- `apps/worker/src/jobs/parse-source.ts`
- `apps/worker/src/jobs/parse-image-source.test.ts` (**new**, untracked)
- `apps/worker/src/runtime/source-page-images.ts` (+ test)
- `packages/database/src/repositories/opening-source-chunks.ts`
- `packages/database/src/repositories/opening-source-chunks-readable.test.ts` (**new**, untracked)
- `apps/web/src/features/opening/inbox/upload-state.ts` (+ test)
- `apps/web/src/features/opening/inbox/upload-client.ts` (+ test)

**Integration (plan-named)**
- `tests/integration/opening-image-source.test.ts` — **missing** (file does not exist)

## Today / grading / collision spot-check

- DL8 implementation files have **no** Today UI (`today-view` / `groupTodayQueue`) or grading/evidence-eligibility (`verdict` / `reference_checked` / mastery) edits.
- Working tree also has dirty Today / attempt-form / evidence-context files from **other** DL work; those are outside the DL8 file set.
- Shared-file split matches the agreed halves: model owns tutor + context selection; parse owns parse + page images + chunks readable + upload tips. No conflicting edits on the same DL8-owned symbols beyond that split.

## Plan criteria checklist

| # | Criterion | Result | Notes |
|---|---|---|---|
| 1 | `isImageOnlySourceChunks`: every chunk has `imageObjectKey` and empty/whitespace text | **PASS** | Exported helper + unit cases (empty, whitespace, caption fails, empty list false) |
| 2 | Non-vision + image-only → error「当前模型不能看图，请在设置中选择支持图片的模型」; no `reserve` / provider `complete` | **PASS** | Throws `VISION_REQUIRED_MESSAGE` before `runBudgetedCall`; test asserts no reserve/complete + `fail` with message |
| 3 | Vision + image-only: default page 1 attachment; tutor-chunks keep empty-text image chunks; `selectContext` `preferPage=1` selects them | **PASS** | `preferPage` / `pageForImages` default 1; `isUsableChunk` keeps image keys; context test prefers empty-text image on page 1 |
| 4 | Parse `image/jpeg\|png\|webp` → page 1 chunk, `imageObjectKey=finalKey`, empty text OK, ready via `replaceChunks` | **PASS** | `IMAGE_SOURCE_MIMES` branch; `parse-image-source` tests PNG/JPEG/WebP |
| 5 | `chunksHaveReadableContent` / `listForSources` allow empty text with image key | **PASS** | Readable helper + SQL OR on non-empty `image_object_key` |
| 6 | `source-page-images`: `image/*` page=1 returns data URL from original | **PASS** | Unit: page 1 bytes; non-1 skipped |
| 7 | HEIC/HEIF tip「请导出为 JPG 后上传」; webp extension in upload MIME map | **PASS** | `unsupportedUploadMessage` / `isHeicUpload`; webp in `BY_EXTENSION` |
| 8 | OCR empty string allowed (no OCR service required this round) | **PASS** | Empty text written; comment in parse-source |
| 9 | Long-edge **>2048** resize derivative | **DEFER (known gap)** | Plan mentions scaled derivative when long edge >2048. **Not implemented** this round (points at original; no image encoder dep). Per PM: **do not block** other passing DL8 items. Record as follow-up; acceptance still met via original object key + vision page-1 path. |
| 10 | Must NOT touch Today UI or grading rules in DL8 files | **PASS** | Spot-check clean on DL8 file set |

## Tests re-run

### Model half — 63 passed / 0 failed

```text
node node_modules/vitest/vitest.mjs run --project unit \
  apps/worker/src/jobs/tutor-turn.test.ts \
  apps/worker/src/jobs/tutor-chunks.test.ts \
  packages/ai/src/opening/context.test.ts
→ Test Files  3 passed (3)
→ Tests       63 passed (63)
  tutor-turn.test.ts     36
  tutor-chunks.test.ts    3
  context.test.ts        24
```

### Parse half — 27 passed / 0 failed

```text
node node_modules/vitest/vitest.mjs run --project unit \
  apps/worker/src/jobs/parse-image-source.test.ts \
  apps/worker/src/jobs/parse-source.test.ts \
  apps/worker/src/runtime/source-page-images.test.ts \
  packages/database/src/repositories/opening-source-chunks-readable.test.ts \
  apps/web/src/features/opening/inbox/upload-state.test.ts \
  apps/web/src/features/opening/inbox/upload-client.test.ts
→ Test Files  6 passed (6)
→ Tests       27 passed (27)
  parse-image-source.test.ts              2
  parse-source.test.ts                    7
  source-page-images.test.ts              3
  opening-source-chunks-readable.test.ts  3
  upload-client.test.ts                   6
  upload-state.test.ts                    6
```

### Typecheck — all exit 0

```text
node node_modules/typescript/bin/tsc -p apps/worker/tsconfig.json --noEmit          → exit 0
node node_modules/typescript/bin/tsc -p packages/ai/tsconfig.json --noEmit           → exit 0
node node_modules/typescript/bin/tsc -p packages/database/tsconfig.json --noEmit     → exit 0
node node_modules/typescript/bin/tsc -p apps/web/tsconfig.json --noEmit              → exit 0
```

## Integration

- DB up: `pg_isready` 127.0.0.1:5432 OK; `psql` to `aistudy_opening_test` OK.
- Plan file `tests/integration/opening-image-source.test.ts` **does not exist** — not run.
- Agent accept does **not** require inventing that integration file; note as coverage gap for a later slice (non-vision fail path + vision request body via test adapter).

## Explicit non-actions

- **Browser not run** (user-owned per AGENTS.md / plan).
- **`tasks.json` not edited**.
- **Not marked verified**.
- No commit / push.

## Known gaps (non-blocking)

1. **Long-edge >2048 resize derivative** — deferred; original finalKey used. Follow-up when an encoder is available.
2. **`tests/integration/opening-image-source.test.ts`** — missing; unit coverage covers the critical non-vision / vision / parse / readable paths.

## Bottom line

Model half **ACCEPT**, parse half **ACCEPT**, overall agent accept **ACCEPT**, with >2048 resize recorded as known deferred gap. Browser / verified / tasks.json untouched.
