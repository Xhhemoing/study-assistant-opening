# Holistic upload P1 — Experience G5 / G13 / G15 / G16 implement

**Date:** 2026-10-10 ~23:45 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release` @ tip `3af5c01` (cite D shipped; hermes still deploying that tip)  
**Owner:** Experience  
**Plan:** `docs/superpowers/plans/opening-release/holistic-upload-materials-audit-understand.md` + p0-plan P1 backlog  
**Status:** IMPLEMENT — **not committed / not pushed / no stash / no reset / no checkout that discards work**

## Shipped

### G5 — Queue cancel for uploading/idle
- `upload-queue.ts` `dismiss` now removes `idle` | `uploading` | `failed` (still no-ops for `saved`).
- Cancelled ids tracked so late progress/completion cannot resurrect removed items.
- Inbox + UploadStrip: **取消** for idle/uploading; **清除** + **重试** only for failed.
- Tests flipped: idle dismiss works; uploading dismiss ignores late completion.

### G13 — Batch delete
- `MaterialBatchActions`: **删除材料** with Chinese irreversible / memberships-removed confirm (single-delete tone).
- `material-batch-delete.ts`: sequential `impact` → `act(delete)` per id; succeeded/failed like membership batch.
- `useMaterialLibrary.deleteSelected` + library wiring; refreshes sources after.
- Tests: batch bar presence; helper succeeded/failed.

### G15 — Split filters incomplete_upload vs parsing
- `MaterialStatus`: replaced `processing` with `incomplete_upload` (upload not fully uploaded) and `parsing` (uploaded + not_started|queued|running).
- Kept `ready` / `attention` / `stored` / `all`.
- Library dropdown: 「上传未完成」「正在解析」; badge shows both counts separately.
- `material-collection.test.ts` updated thoroughly.

### G16 — Delete shortcut for unsupported + aged queued
- Exported `AGED_QUEUED_MS`, `isAgedQueuedParse`, `canDeleteSourceShortcut` from `upload-state.ts`.
- `source-row` uses helper (failed|rejected|pending|unsupported|aged queued ≥3min).
- Tests for unsupported, aged queued, fresh queued.

### Nice-to-have (same wave)
- **G10** Dropzone + `upload-state` MIME: `.mp4` / `.webm` + `video/mp4` / `video/webm`.
- **G11** `media-reader`: distinct `parse_failed` vs `parse_unsupported`; copy via `sourceStatusLabel`.
- **G17** When `!organizationReady` (and no org error yet): short Chinese guidance instead of looking broken.

## Files touched (Experience only)

| Path | Change |
|---|---|
| `apps/web/.../inbox/upload-queue.ts` (+ test) | G5 dismiss idle/uploading + ignore late |
| `apps/web/.../inbox/inbox-panel.tsx` | G5 取消 UI |
| `apps/web/.../assistant/upload-strip.tsx` | G5 取消 UI |
| `apps/web/.../inbox/upload-state.ts` (+ test) | G16 helpers; G10 video MIME |
| `apps/web/.../inbox/source-row.tsx` (+ test) | G16 shortcut |
| `apps/web/.../inbox/upload-dropzone.tsx` (+ test) | G10 video accept |
| `apps/web/.../library/material-collection.ts` (+ test) | G15 status split |
| `apps/web/.../library/material-library.tsx` | G15 labels/badges; G13 wire; G17 copy |
| `apps/web/.../library/material-batch-actions.tsx` (+ test) | G13 bulk delete confirm |
| `apps/web/.../library/material-batch-delete.ts` (+ test) | G13 impact+act helper |
| `apps/web/.../library/use-material-library.ts` | G13 `deleteSelected` |
| `apps/web/.../sources/media-reader.tsx` (+ test) | G11 distinct failed/unsupported |

**Left untouched (other agents):** ai-readiness*, source-service*, parse-source*, queue*, packages/ai/*, opening-sources*, docs rp5-gha*, Pipeline/Data evidence already written, `source-content.tsx`.

## Gates

```bash
npx vitest run \
  apps/web/src/features/opening/inbox/upload-queue.test.ts \
  apps/web/src/features/opening/inbox/source-row.test.ts \
  apps/web/src/features/opening/inbox/upload-state.test.ts \
  apps/web/src/features/opening/inbox/upload-dropzone.test.ts \
  apps/web/src/features/opening/library/material-collection.test.ts \
  apps/web/src/features/opening/library/material-batch-actions.test.ts \
  apps/web/src/features/opening/library/material-batch-delete.test.ts \
  apps/web/src/features/opening/sources/media-reader.test.ts \
  --project unit

cd apps/web && npx tsc -p tsconfig.json --noEmit
```

**Results (2026-10-10 ~23:45 CST):**
- vitest unit (8 files) — **49 passed**
- `apps/web` `tsc -p tsconfig.json --noEmit` — **PASS** (clean; no isolation needed)

## Explicit non-actions

- No commit, push, stash, reset, or checkout that discards work.
- Did not edit other agents' dirty product files listed in the task.

## Accept ask → Integrator

Please Accept Experience P1 wave **G5 / G13 / G15 / G16** (+ G10/G11/G17 nice-to-haves) against tip `3af5c01` working tree (uncommitted). Evidence: this file.

## Blockers for Accept

- None known for Experience scope. Concurrent dirty tree from Pipeline/Data/AI/worker remains; Integrator should attribute only paths in the table above to this wave.
- In-flight upload cancel is **queue UI remove + ignore late completions** (no XHR AbortController wired through `putPrivateBytes` this turn); acceptable per plan when abort is hard.
