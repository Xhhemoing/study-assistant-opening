# V01 follow-up accept — object-store v{n}→v{n+1} copy + corrections `{ jobId }`

**Date:** 2026-10-09 ~17:56 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release`  
**Workspace:** `/workspace/study-assistant-opening`  
**Scope:** Agent re-accept of **PIPELINE** latest V01 follow-up against `docs/superpowers/plans/opening-release/10-media-knowledge.md` § V01.  
**Prior accepts (not re-litigated):**  
- `docs/superpowers/evidence/2026-10-09-opening-release/v01-media-parse-accept.md`  
- `docs/superpowers/evidence/2026-10-09-opening-release/v01-media-parse-followup-accept.md`  
**Verdict:** **ACCEPT** (agent-owned; **not verified**)  
**Browser:** **not run** — do not claim browser pass.  
**Real classroom footage:** **not run** (plan live accept path — human verify).  
**tasks.json:** **not edited** by this accepter (workspace may already show prior MM from other owners; left untouched).  
**verified:** **not marked**.  
**Commit/push:** **not done**.  
**K01 knowledge invalidate:** **still deferred**.  
**True async apply job kind:** **later** (PM 后补; this slice is thin sync receipt only).

## Claimed this round (vs prior follow-up gaps)

| Claim | Result | Notes |
|---|---|---|
| `OpeningS3.copyObject` | **PASS** | `packages/database/src/storage/opening-s3.ts`; on `OpeningStorage` pick; no-op when source===dest; unit asserts `CopyObjectCommand` Bucket/Key/CopySource |
| Correction bump copies `finalKey` + frames `v{n}→v{n+1}` | **PASS** | `copyOpeningSourceVersionObjects` inside `applyCorrections` tx (before commit); rewrites `image_object_key` under `opening/sources/{id}/v{n}/…`; dedupes duplicate frame keys |
| Corrections return `{ jobId }` (thin sync receipt; no new job kind) | **PASS** | After sync DB write: `jobs.createOnce` kind `"parse-media"`, payload `mode: "segments-correction"`; claim + `finish("succeeded")`; **no outbox** (createOnce inserts job row only). Matches capability-interfaces CAP03 / V01 `{jobId}` |
| Handler skips re-transcribe for receipt | **PASS** | `parse-media` early-return when `mode === "segments-correction"` (`skipped: true`; no source load / download / replaceChunks) |
| No new migration | **PASS** | Still only V01 `0050_opening_parse_media_job.sql` (job-kind CHECK). `0051` is extract-study-actions (other owner) — not introduced by this slice |
| Vitest unit **4 files / 18 passed** | **PASS (actual)** | Re-run green — see below |
| K01 invalidate deferred; real async job kind later; whisper; browser | **CONFIRMED gaps** | Explicit TODO in service; PM deferred async apply; faster-whisper not installed; browser not run |

## Files reviewed (this delta)

**Storage**  
- `packages/database/src/storage/opening-s3.ts` — `copyObject(sourceKey, destKey)` via `CopyObjectCommand`  
- `packages/database/src/storage/opening-s3.test.ts` — copy + same-key no-op  

**Web media service**  
- `apps/web/src/features/opening/media/media-segments-service.ts` — `rewriteOpeningSourceVersionKey`, `copyOpeningSourceVersionObjects`, version-bump tx copies objects then inserts segments/frames at `v{n+1}`, returns `{ jobId }`  
- `apps/web/src/features/opening/media/media-segments-service.test.ts` — key rewrite + copyObject mock; correction contract / `clientKey`  
- `apps/web/src/app/api/opening/sources/[id]/segments/corrections/route.ts` — POST → service (JSON `{ jobId }`)  

**Worker**  
- `apps/worker/src/jobs/parse-media.ts` — `segments-correction` skip path  
- `apps/worker/src/jobs/parse-media.test.ts` — asserts no source/storage/chunk side effects  

**Contracts**  
- `packages/contracts/src/opening/media.ts` — `mediaSegmentCorrectionResultSchema` = `{ jobId: uuid }` strict  

## Plan / interface checklist (this slice only)

| Criterion | Result | Notes |
|---|---|---|
| Object-store versioned copy on correction (prior gap) | **PASS** | finalKey + forwarded frames under version prefix |
| Corrections API returns `{ jobId }` (capability-interfaces) | **PASS** | Thin sync receipt via existing `parse-media` kind; not outbox re-transcribe |
| No new job kind / no new migration | **PASS** | Reuses 0050 `parse-media` |
| Correction → new source version (prior follow-up) | **PASS** | Unchanged CAS bump; now paired with object copy |
| Invalidate derived knowledge (K01) | **DEFERRED** | TODO in service; avoid K01 ownership fight |
| Real async apply / re-transcribe job | **DEFERRED** | Receipt is sync succeed; PM said 后补 dedicated kind if needed |
| Browser / classroom accept | **NOT RUN** | Do not mark verified |

## Tests re-run (actual)

```text
node node_modules/vitest/vitest.mjs run --project unit \
  packages/database/src/storage/opening-s3.test.ts \
  apps/web/src/features/opening/media/media-segments-service.test.ts \
  apps/worker/src/jobs/parse-media.test.ts \
  apps/worker/src/parsers/media-segments.test.ts
# → Test Files  4 passed (4)
# → Tests  18 passed (18)
# Breakdown: opening-s3 3 + media-segments-service 5 + parse-media 7 + media-segments 3 = 18
```

Matches Pipeline claim (4 / 18). Pytest / whisper / browser **not** re-claimed this round (prior accepts cover; whisper still not installed).

## Known gaps (do not treat as verified)

1. **K01 knowledge invalidate still deferred** — correction bumps version, copies objects, replaces segment rows; does not mark derived knowledge `needs_check` or scoped rebuild.  
2. **True async apply job kind later** — current `{ jobId }` is a thin sync receipt (`createOnce` → claim → `succeeded`, no outbox). Real async re-apply / re-scope needs a later job kind (PM 后补).  
3. **faster-whisper not installed** — live transcription still optional / `CONFIGURATION` until offline weights.  
4. **Browser + real classroom footage not run** — human verify path remains; **do not mark verified**.  
5. **CAS + object-copy path not SQL/integration-tested in this unit set** — service unit covers key rewrite / copyObject mock; full tx + MinIO copy reviewed in code only.

## Verdict rationale

Closes the two gaps called out in `v01-media-parse-followup-accept.md`: (1) object-store `v{n}→v{n+1}` copy of `finalKey` + forwarded frame keys on correction CAS bump; (2) corrections return `{ jobId }` after sync DB write via a `parse-media` job with `mode: "segments-correction"` receipt (no new kind, no outbox re-transcribe; handler skips if ever dispatched). No new migration. Unit re-run: **4 files / 18 passed**. Remaining gaps (K01 invalidate, true async job kind, whisper, browser/classroom) stay open and explicit. **ACCEPT** agent-owned. **Not verified.** No `tasks.json` edit. No commit/push.
