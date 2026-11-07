# Holistic upload/materials audit P0 Plan — Integrator review

**Date:** 2026-10-10 ~22:28 CST  
**Reviewer:** INTEGRATOR  
**Source:** `holistic-upload-materials-audit-p0-plan.md` (companion: `holistic-upload-materials-audit-understand.md`)  
**Branch tip baseline:** `feat/opening-release` @ `ea998da`  
**Verdict:** **AGREE**

## Why AGREE

- Packages A–D map cleanly to gap IDs: A→G1+G2, B→G3 (partial G4/G5), C→G6+G7, D→G14; P1 backlog holds the rest.
- Reuse existing surfaces: same-origin staging PUT (`3c8cca8`), `addToCourse` / memberships (`ea998da`), `failOpeningJob` fences, no new MinIO public path.
- Rejected alternatives are sound: no `/s3/` nginx or public MinIO; no UI-only fake-fail on timer; no auto-delete pending; no duplicate `begin` on retry; no R2 chrome restore; no silent last-course auto-assign.
- Non-goals keep R2 denoise, Q03/Q01 packaging, and `tasks.json` verified rows untouched.
- No package invents a parallel browser→MinIO path or weakens privacy/version fences; A explicitly requires staging-PUT 204 regression.

## Implement notes (non-blocking)

1. **PM sequencing overrides plan parallel sketch.** Plan diagram allows A∥B∥C∥D after AGREE; PM dispatch is serial-first:
   1. Pipeline Package **C** first (`failOpeningJob` parse-media + claim→running + honest copy; MemoryMax/ops with Data note only — Data/AI write no product code this wave).
   2. After C **Accept**: Pipeline **A server** (download same-origin proxy/stream) + **B server** (reissue upload-ticket).
   3. Then Experience: **A client** + **B client** + Package **D** (upload with `courseId`).
   4. Integrator: AGREE this plan, then Accept each package; Integrator makes no product edits.
2. Package A must not regress shipped staging PUT or materials `ea998da`; Inbox `resolveUploadPutUrl` is defense-in-depth only.
3. Package B: one source id, pending-only reissue, same-origin staging URL; materials retry must not call `retryComplete` alone when staging empty.
4. Package C: keep privacy/version fences in `failOpeningJob`; do not fake-fail from UI timer; Whisper `retryable:false` (`32be749`) must not regress.
5. Package D: opt-in `courseId` only; failed upload must not create membership; build on `ea998da`, do not reintroduce explore/marketplace.

## Next

Pipeline **C** IMPLEMENT → Integrator Accept C → Pipeline A server + B server → Experience A client + B client + D → Integrator Accept remaining → PM push/hermes as authorized.
