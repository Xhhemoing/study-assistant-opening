# P04 AI half accept — extract-study-actions (worker/domain slice)

**Date:** 2026-10-09 ~17:58 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release`  
**Workspace:** `/workspace/study-assistant-opening`  
**Scope:** Integrator accept of **AI half only** against `docs/superpowers/plans/opening-release/11-proactive-acceptance.md` § P04 — extract worker/domain slice AI handed over.  
**Verdict:** **ACCEPT** (AI half; agent-owned)  
**P04 verified:** **not marked** — Experience `action-digest` / action-service / route / integration not required for this half.  
**Browser:** **not run**.  
**tasks.json:** **not edited**.  
**Commit/push:** **not done**.

## Files reviewed

**Create**
- `packages/domain/src/opening/extract-study-actions.ts` (+ `extract-study-actions.test.ts`) — `resolveCandidateDueAt`, `extractStudyActionCandidates`; exported from `packages/domain/src/index.ts`
- `apps/worker/src/jobs/extract-study-actions.ts` (+ `extract-study-actions.test.ts`) — `createExtractStudyActionsHandler`
- `packages/database/src/migrations/0051_opening_extract_study_actions_job.sql` — formal file (no DRAFT); job-kind CHECK only

**Modify**
- `packages/contracts/src/opening/jobs.ts` — `jobKindSchema` includes `"extract-study-actions"` alongside `"parse-media"` and prior kinds
- `apps/worker/src/runtime/handlers.ts` — `"extract-study-actions"` handler slot
- `apps/worker/src/index.ts` — wires `createExtractStudyActionsHandler`; `listAuthorizedImportChunks: async () => []` with explicit thin-slice comment
- `apps/worker/src/runtime/run-job.test.ts` — handler key list includes `extract-study-actions`

## Migration 0051

| Item | Result |
|---|---|
| File | `packages/database/src/migrations/0051_opening_extract_study_actions_job.sql` |
| Content | **Job-kind CHECK only** — drops/re-adds `opening_jobs_kind_check` |
| Kinds | `'parse','tutor','retest','remind','build-course-knowledge','parse-media','extract-study-actions'` |
| Prior `parse-media` | **Preserved** (from 0050) |
| Rollback | Commented restore without `extract-study-actions` |
| DRAFT | **None** — formal numbered migration |

## Plan criteria matched (AI-relevant bullets only)

| # | Criterion (from § P04) | Result | Notes |
|---|---|---|---|
| 1 | Extract worker: authorized ImportReceipt + course chunks → candidates; must not emit accepted tasks | **PASS** | Handler lists chunks then `extractStudyActionCandidates`; hard-throws if any `status === "accepted"`; unit covers inject-accepted refusal |
| 2 | Dates from source send time + user timezone | **PASS** | `sentAt` + `timeZone` drive `resolveCandidateDueAt` / `endOfLocalDayIso`; absolute ISO + CN dates covered |
| 3 | Forward / 「下周」 without anchor → `needsConfirmation` | **PASS** | Forward clears `dueAt` + `forwarded_notice`; `下周` without `sentAt` → `relative_date_missing_sent_at`; bare `下周` even with `sentAt` → `relative_week_missing_weekday` |
| 4 | Only `pending` candidates (not accepted tasks) | **PASS** | Domain always sets `status: "pending"`; worker guard + tests |
| 5 | Must not invent sync-time as notification date | **PASS** | No `Date.now()` / sync clock as due; missing `sentAt` + non-absolute → `dueAt: null` + confirmation |
| 6 | `jobKindSchema` + handlers/index wiring | **PASS** | contracts + handlers + index + run-job key list |

**Out of scope for this half (not blockers):**
- Experience `buildActionDigest` / action-service / `action-digest` route / reject fixture (files may exist on branch; **not evaluated** here)
- Integration `opening-action-digest`
- K02 card points, P02 scheduling, revision/dedupe full digest UX
- Browser / live accept

## Tests re-run (actual)

```text
node node_modules/vitest/vitest.mjs run --project unit \
  packages/domain/src/opening/extract-study-actions.test.ts \
  apps/worker/src/jobs/extract-study-actions.test.ts \
  apps/worker/src/runtime/run-job.test.ts
# → Test Files  3 passed (3)
# → Tests  19 passed (19)
# Breakdown: domain extract 7 + worker extract 3 + run-job 9 = 19
# (extract slice alone = 10; claimed “domain+worker unit 19” matches with run-job wiring)
```

**tsc (optional, run):**
- `npx tsc -p packages/domain --noEmit` → exit 0
- `npx tsc -p apps/worker --noEmit` → exit 0

## Known gaps (ACCEPT half; not verified)

1. **`listAuthorizedImportChunks` stub** — `apps/worker/src/index.ts` returns `[]` pending Data ImportReceipt / course-chunk projection. Explicit comment. Extraction logic + unit tests (injected list) are sound; **not an ACCEPT blocker for AI half**.
2. **Experience digest half** — not required; not marked verified; integration not run.
3. **Relative weekday with sentAt** — thin slice still returns `needsConfirmation` (does not yet compute concrete next-weekday due); consistent with confirmation rule.
4. **Browser not run**; **P04 not verified**; **tasks.json not edited**; **no commit/push**.

## Verdict

**ACCEPT** — AI extract-study-actions worker/domain half meets § P04 AI-relevant date/confirmation/pending-candidate rules; migration 0051 and jobKind wiring OK; 19 unit tests green; tsc domain+worker green. Full P04 remains open until Experience digest + integration land and a separate verify pass.
