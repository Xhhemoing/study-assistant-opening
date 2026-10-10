# Upload-parse P0 Plan — Integrator review

**Date:** 2026-10-10 ~12:39 CST  
**Reviewer:** INTEGRATOR  
**Source:** `upload-parse-p0-plan.md`  
**Verdict:** **AGREE** (Plan only; IMPLEMENT after PM auth)

## Why AGREE

- Slice 1 matches code: `parse-media` already calls `markParseState(..., "failed")` without error; repo already accepts 4th arg; UI retry only special-cases PRIVACY today → empty retry loop is real.
- Slice 2 decision is the right minimal UX: drop `.ppt`/`.eml` from dropzone accept; keep contracts + email import; no migration.
- Non-goals clear (no whisper install, no OCR, no upload-delete overlap, no video P1).
- Acceptance criteria testable.

## Implement notes (non-blocking)

1. Prefer `error.retryable === false` as the retry gate (covers PRIVACY + blocked_not_configured + future).
2. Keep `BY_EXTENSION` ppt/eml for import/MIME; only strip `openingUploadAccept` / `typeLabels`.
3. Touch Experience UI only for label/retry (upload-state, source-row, inbox-panel, media-reader as listed) — do not mix into unpushed upload-delete or R2 diffs when committing.
4. Optional eml `storedOnly` return alignment is fine if discovered; not required for AGREE.

## Next

PM authorize → Pipeline IMPLEMENT → Integrator Accept.
