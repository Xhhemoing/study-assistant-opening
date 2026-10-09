# V01 media parse — agent-owned verified (Integrator)

**Date:** 2026-10-09 ~18:13 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release` @ `a9b87cb` (+ uncommitted Pipeline V01 slices as already ACCEPTed)  
**Workspace:** `/workspace/study-assistant-opening`  
**Verifier:** AIstudy Integrator (not the implementer)  
**Verdict:** **verified** agent-owned (same pattern as C02/C03/DL10 — PM asked Integrator to 拍板 after multi-round ACCEPTs). **Does not claim** browser / classroom live / faster-whisper live.

## Prior accepts (cited)

- Media parse thin slice: [`v01-media-parse-accept.md`](./v01-media-parse-accept.md) — `parse-media` job kind (0050), FFmpeg/ffprobe argv, segments validate, GET/POST segments surface; ACCEPT agent-owned; not verified.
- Keyframes / transcribe adapter / correction CAS: [`v01-media-parse-followup-accept.md`](./v01-media-parse-followup-accept.md) — I02 `frames/` keys, offline-only whisper bridge (`CONFIGURATION` without weights), source version CAS on correction.
- Object copy + `{ jobId }` receipt: [`v01-media-parse-copy-jobid-accept.md`](./v01-media-parse-copy-jobid-accept.md) — `OpeningS3.copyObject`, `v{n}→v{n+1}` final+frames copy, thin sync `parse-media` `segments-correction` receipt (no new kind / no outbox).
- K01 invalidate: [`v01-k01-invalidate-accept.md`](./v01-k01-invalidate-accept.md) — post-commit `markNeedsCheckForSources(scope, [sourceId])`; source-level only; no auto `enqueueRebuild`.

## Re-verify (this pass)

```text
# Vitest unit — consolidated V01 set (= 20)  ★ agent-owned gate
node node_modules/vitest/vitest.mjs run --project unit \
  apps/worker/src/parsers/media-segments.test.ts \
  apps/web/src/features/opening/media/media-segments-service.test.ts \
  apps/worker/src/jobs/parse-media.test.ts \
  packages/database/src/storage/opening-s3.test.ts
→ Test Files  4 passed (4)
→ Tests       20 passed (20)
→ Duration    ~5.11s
  Breakdown: media-segments 3 + media-segments-service 7 + parse-media 7 + opening-s3 3 = 20
  (matches k01-invalidate accept count; +2 markNeedsCheck vs copy-jobid’s 18)

# Pytest — parser media (= 10)
services/parser/.venv/bin/pytest services/parser/tests/test_media.py -q
→ 10 passed in 1.20s
```

## CAP / live note

V01 **agent-owned verified** closes the structural unit gate after four ACCEPTs. It **does not** claim CAP/classroom/whisper live acceptance. Live gates below stay open and must not be reported as done.

## Explicit gaps (do not claim closed)

1. **Browser / real classroom footage** — not run; plan live accept path remains human.
2. **faster-whisper / offline weights not installed** — live transcription still optional / `CONFIGURATION` path OK; no auto-download.
3. **No auto `enqueueRebuild`** — intentional; Pipeline optional follow-up; callers can use K01 rebuild.
4. **True async correction job kind** — later; current `{ jobId }` is thin sync receipt (`createOnce` → claim → `succeeded`, no outbox).
5. **Source-level `needs_check` only** — no time-range-scoped invalidate API on K01; corrected interval alone is not marked.

## Ledger

- `tasks.json` V01 → `verified`; primary evidence this path; keep the four accept evidence entries.
- Commit/push: **not done** (Integrator instruction: Do NOT commit/push).
