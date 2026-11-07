# IMPLEMENT：上传/解析 P0（whisper 可读失败 + ppt/eml 诚实）

**Date:** 2026-10-10 ~12:40 CST (Asia/Shanghai)  
**Owner:** Pipeline (AIstudy) / Grok Bot executor  
**Branch:** `feat/opening-release`  
**Status:** **IMPLEMENTED** (no commit / no push / `tasks.json` untouched)  
**Plan:** `upload-parse-p0-plan.md`  
**Auth:** PM authorized; Integrator AGREEd (`upload-parse-p0-integrator-review.md`)

---

## Scope respected

- **No** commit / push  
- **No** `tasks.json` edits  
- **No** contracts MIME whitelist / email import API / whisper install / delete API  
- **No** intentional upload-delete / R2 stacking in this slice (workspace already had unrelated dirty files; this P0 only edited plan-listed paths)

**Note on pre-dirty plan files:** `source-row.tsx` / `inbox-panel.tsx` already carried upload-delete working-tree changes (`onDelete`, queue dismiss, etc.). This IMPLEMENT only changed their **retry gate** (`PRIVACY_EXCLUDED` code → `error?.retryable !== false`). Do not treat the pre-existing delete/dismiss hunks as part of this P0.

---

## Slice 1 — whisper `blocked_not_configured` error

| File | Change |
|---|---|
| `apps/worker/src/jobs/parse-media.ts` | Added `BLOCKED_NOT_CONFIGURED_ERROR` (`code: blocked_not_configured`, Chinese `message`, `retryable: false`). Both audio-only and video `markParseState(..., "failed")` paths pass it as 4th arg. |
| `apps/worker/src/jobs/parse-media.test.ts` | Assert `markParseState` receives that error on video (adapter missing) and audio (MediaConfigurationError) blocked paths. |
| `apps/web/src/features/opening/inbox/upload-state.ts` | `sourceStatusLabel`: PRIVACY still first; on `failed`, prefer `error.message` when present. |
| `apps/web/src/features/opening/inbox/upload-state.test.ts` | Covers blocked message / generic failed / PRIVACY priority. |
| `apps/web/src/features/opening/inbox/source-row.tsx` | Retry button: `error?.retryable !== false` (hides non-retryable incl. blocked + privacy). |
| `apps/web/src/features/opening/inbox/inbox-panel.tsx` | Same gate when wiring `onRetry` for failed parse. |
| `apps/web/src/features/opening/sources/media-reader.tsx` | For `parse_failed_original_saved`, status copy is only `sourceStatusLabel(source)` (surfaces stored error message). |
| `source-row.test.ts` / `media-reader.test.ts` | Non-retryable hides「重新解析」; blocked message surfaces. |

`BY_EXTENSION` ppt/eml mappings in `upload-state.ts` **kept**.

---

## Slice 2 — remove `.ppt` / `.eml` from dropzone

| File | Change |
|---|---|
| `apps/web/src/features/opening/inbox/upload-dropzone.tsx` | Removed `.ppt` / `.eml` from `openingUploadAccept` and `typeLabels`. |
| `apps/web/src/features/opening/inbox/upload-dropzone.test.ts` | Assert accept list; ppt/eml rejected; pptx/pdf/mp3 still accepted. |

Unchanged by design: `packages/contracts/.../sources.ts`, email import route, `parse-source` unsupported behavior.

---

## Tests

```bash
npx vitest run --project unit \
  apps/worker/src/jobs/parse-media.test.ts \
  apps/web/src/features/opening/inbox/upload-state.test.ts \
  apps/web/src/features/opening/inbox/upload-dropzone.test.ts \
  apps/web/src/features/opening/inbox/source-row.test.ts \
  apps/web/src/features/opening/sources/media-reader.test.ts
# → 5 files, 28 tests passed

npx vitest run --project unit apps/web/src/features/opening/inbox/inbox-panel.test.ts
# → 1 file, 5 tests passed
```

---

## Acceptance check (self)

1. Whisper not configured → persisted `error.code === blocked_not_configured`, non-empty Chinese message, `retryable: false`; UI shows message; no「重新解析」.  
2. Generic / retryable failed still shows retry; PRIVACY label still wins.  
3. Dropzone no longer accepts/lists `.ppt`/`.eml`; `.pptx`/`.pdf` still accepted.  
4. No migration / contracts / whisper install / delete API / `tasks.json` / commit / push.

---

## Explicit

**No commit. No push.** Ready for Integrator accept / parent follow-up.
