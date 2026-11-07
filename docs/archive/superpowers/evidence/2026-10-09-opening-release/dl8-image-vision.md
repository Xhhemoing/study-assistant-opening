# DL8 Photo sources as direct vision input — agent-owned checks accepted

Verifier: AIstudy Integrator (not the implementer). Workspace: `/workspace/study-assistant-opening`, branch `feat/opening-release`. Uncommitted.

## Diff vs `14-loop-closure.md` § DL8

**Model (AI) half**
- `apps/worker/src/jobs/tutor-turn.ts` (+ test): `isImageOnlySourceChunks`; non-vision + image-only → `VISION_REQUIRED_MESSAGE` before `runBudgetedCall` (no reserve/complete); vision path attaches page-1 images.
- `apps/worker/src/jobs/tutor-chunks.ts` (+ test): keeps empty-text chunks that carry `imageObjectKey` (`isUsableChunk`).
- `packages/ai/src/opening/context.ts` (+ test): `preferPage` / `pageForImages` default 1 so empty-text image chunks on page 1 are selected.

**Parse (Pipeline) half**
- `apps/worker/src/jobs/parse-source.ts` (+ `parse-image-source.test.ts`): `IMAGE_SOURCE_MIMES` (`image/jpeg|png|webp`) → page 1 chunk, `imageObjectKey=finalKey`, empty OCR text OK via `replaceChunks`.
- `apps/worker/src/runtime/source-page-images.ts` (+ test): `image/*` page=1 returns data URL from original object.
- `packages/database/src/repositories/opening-source-chunks.ts` (+ readable test): `chunksHaveReadableContent` / `listForSources` allow empty text when `image_object_key` is non-empty.
- Inbox upload: HEIC/HEIF tip「请导出为 JPG 后上传」; webp in MIME/extension map (`upload-state.ts` / `upload-client.ts` + tests).

**Must not** touch Today UI or grading/evidence-eligibility in DL8-owned files — accept spot-check clean on that set (other dirty Today/evidence paths are outside DL8).

## Verification (agent-owned, Integrator re-run 2026-10-09)

- `node node_modules/vitest/vitest.mjs run --project unit` on model + parse DL8 suites (9 files):  
  `tutor-turn.test.ts`, `tutor-chunks.test.ts`, `packages/ai/src/opening/context.test.ts`,  
  `parse-image-source.test.ts`, `parse-source.test.ts`, `source-page-images.test.ts`,  
  `opening-source-chunks-readable.test.ts`, `upload-state.test.ts`, `upload-client.test.ts`  
  → **9** files, **90** passed (~6.44s). Split matches prior accept: model **63** + parse **27**.

**Cited from prior accept** ([`dl8-image-vision-accept.md`](./dl8-image-vision-accept.md); both halves ACCEPT):

- Model half: 3 files / **63** passed; parse half: 6 files / **27** passed.
- `tsc --noEmit` green for `apps/worker`, `packages/ai`, `packages/database`, `apps/web`.

Plan criteria 1–8 and 10 **PASS** at accept (vision gate, page-1 attachment, image MIME parse, readable empty text + image key, HEIC tip, OCR empty OK, no Today/grading touch). Criterion 9 (long-edge >2048 resize) deferred — see Known gaps.

## Not run

- Browser walk for Paula (upload image source → tutor with vision / non-vision error). Plan/`AGENTS.md` leave browser to the user; same follow-up pattern as DL5/DL6/DL7.
- `tests/integration/opening-image-source.test.ts` — file missing (see Known gaps).

## Known gaps

1. **Long-edge >2048 resize derivative not implemented** — `image_object_key` / `imageObjectKey` points at the original `finalKey`; no scaled derivative / image-encoder dep this round. Plan mentions a scaled object when long edge >2048. Non-blocking per PM; follow-up when an encoder is available. Vision page-1 path still works via the original key.
2. **Integration file `tests/integration/opening-image-source.test.ts` missing** — plan-named coverage for non-vision fail + vision request body via test adapter not present. Unit coverage covers the critical non-vision / vision / parse / readable paths.
3. **Browser left to Paula** — not run by the agent; do not claim browser pass.

## Ledger

- `tasks.json` DL8 → `verified` with this evidence path. No commit. DL7 remains verified; DL9 untouched (planned).
