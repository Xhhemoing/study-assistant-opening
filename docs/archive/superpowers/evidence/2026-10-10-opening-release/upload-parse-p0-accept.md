# ACCEPT：上传/解析 P0（whisper 可读失败 + ppt/eml 诚实）

**Date:** 2026-10-10 ~12:41 CST (Asia/Shanghai)  
**Reviewer:** Integrator ACCEPT (AIstudy) / Grok Bot executor  
**Branch:** `feat/opening-release`  
**Sources:** `upload-parse-p0-plan.md` · Integrator AGREE (`upload-parse-p0-integrator-review.md`) · Pipeline claim (`upload-parse-p0-implement.md`)  
**Verdict:** **ACCEPT**  
**Explicit:** No commit / no push / `tasks.json` not modified by this accept

---

## Verdict

**ACCEPT** against the AGREEd plan. Slice 1 (blocked_not_configured error + UI) and Slice 2 (dropzone honesty for `.ppt`/`.eml`) match acceptance criteria. Gates green. Shared dirty files with Experience upload-delete retain delete/dismiss; parse edits are only the retry gate / labels claimed.

---

## Gates (re-run by Integrator)

```bash
npx vitest run --project unit \
  apps/worker/src/jobs/parse-media.test.ts \
  apps/web/src/features/opening/inbox/upload-state.test.ts \
  apps/web/src/features/opening/inbox/upload-dropzone.test.ts \
  apps/web/src/features/opening/inbox/source-row.test.ts \
  apps/web/src/features/opening/sources/media-reader.test.ts \
  apps/web/src/features/opening/inbox/inbox-panel.test.ts
```

| Result | Count |
|---|---|
| Test files | **6 passed** |
| Tests | **33 passed** |
| Duration | ~3.3s |

Claim stated 5 files / 28 + inbox-panel 1 / 5; combined re-run = **6 / 33** — matches. No `tsc` claimed in implement.md; none re-run.

---

## Spot-checks vs plan

| Check | Result |
|---|---|
| `parse-media.ts`: audio-only + video `blocked_not_configured` → `markParseState(..., "failed", error)` with `{ code: "blocked_not_configured", message` non-empty Chinese, `retryable: false }` | **PASS** — shared `BLOCKED_NOT_CONFIGURED_ERROR`; both branches at audio-only (`!probe.hasVideo`) and video paths |
| `sourceStatusLabel`: failed shows `error.message` when present; PRIVACY still first | **PASS** |
| Retry UI: `error?.retryable !== false` hides「重新解析」 | **PASS** — `source-row.tsx` button gate + `inbox-panel.tsx` `onRetry` wiring |
| `media-reader`: `parse_failed_original_saved` uses `sourceStatusLabel(source)` only | **PASS** |
| Dropzone: `openingUploadAccept` / `typeLabels` no `.ppt`/`.eml`; `.pptx`/`.pdf` still accepted | **PASS** |
| `BY_EXTENSION` keeps `ppt`/`eml`; contracts MIME + email import route untouched | **PASS** — `packages/contracts/.../sources.ts` and `imports/email/route.ts` not in WT diff for this slice |
| Delete shortcut not wiped on shared source-row/inbox-panel | **PASS** — `onDelete` / queue dismiss / manage-delete remain; parse delta is retry gate only |

---

## P0 file list (this slice) vs mixed dirt

**Parse P0 product/test files (claim-aligned):**

- `apps/worker/src/jobs/parse-media.ts`
- `apps/worker/src/jobs/parse-media.test.ts`
- `apps/web/src/features/opening/inbox/upload-state.ts`
- `apps/web/src/features/opening/inbox/upload-state.test.ts`
- `apps/web/src/features/opening/inbox/upload-dropzone.tsx`
- `apps/web/src/features/opening/inbox/upload-dropzone.test.ts`
- `apps/web/src/features/opening/inbox/source-row.tsx` *(shared WT with upload-delete)*
- `apps/web/src/features/opening/inbox/source-row.test.ts` *(shared)*
- `apps/web/src/features/opening/inbox/inbox-panel.tsx` *(shared)*
- `apps/web/src/features/opening/inbox/inbox-panel.test.ts` *(shared)*
- `apps/web/src/features/opening/sources/media-reader.tsx`
- `apps/web/src/features/opening/sources/media-reader.test.ts`

**Evidence (this accept + prior plan chain):**  
`upload-parse-p0-plan.md`, `upload-parse-p0-integrator-review.md`, `upload-parse-p0-implement.md`, **this file**.

**Mixed dirty tree note (do not attribute to this P0):** R2+AI settings/readiness/docs, Experience upload-delete (`onDelete`, dismiss, upload-queue, source-actions-panel, etc.), and other unrelated modified paths remain in the working tree. When committing later, isolate parse P0 paths; for shared `source-row` / `inbox-panel`, keep upload-delete hunks out of a parse-only commit (or commit delete first / together with clear split).

---

## Scope confirmed

- No migration  
- No contracts MIME whitelist shrink  
- No email import API removal  
- No whisper/OCR install  
- No delete API changes in this slice  
- `docs/superpowers/plans/opening-release/tasks.json` clean (not modified)  
- **No commit / no push** by Integrator ACCEPT

---

## REJECT reasons

None.
