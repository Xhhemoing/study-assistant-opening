# V01 optional follow-up accept — correction path best-effort `enqueueRebuild`

**Date:** 2026-10-09 ~18:17 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release`  
**Workspace:** `/workspace/study-assistant-opening`  
**Scope:** Agent accept of **PIPELINE** optional V01 follow-up: after correction `markNeedsCheckForSources`, best-effort **full-course** `enqueueRebuild` (not time-range).  
**Role:** AIstudy Integrator accepter (not the implementer).  
**Prior V01 evidence (cited, not re-litigated):**  
- `docs/superpowers/evidence/2026-10-09-opening-release/v01-verified.md` (agent-owned verified)  
- `docs/superpowers/evidence/2026-10-09-opening-release/v01-k01-invalidate-accept.md`  
- `docs/superpowers/evidence/2026-10-09-opening-release/v01-media-parse-copy-jobid-accept.md`  
- `docs/superpowers/evidence/2026-10-09-opening-release/v01-media-parse-followup-accept.md`  
- `docs/superpowers/evidence/2026-10-09-opening-release/v01-media-parse-accept.md`  
**Verdict:** **ACCEPT** (optional follow-up; **V01 verified status unchanged**)  
**Browser:** **not run** — do not claim browser pass.  
**Real classroom footage:** **not run**.  
**tasks.json:** **not edited**. V01 remains **`verified`**.  
**Commit/push:** **not done**.

## Claimed this round

| Claim | Result | Notes |
|---|---|---|
| `markNeedsCheckForSources` → `{ updated, courseIds }` | **PASS** | `packages/database/src/repositories/opening-knowledge.ts`: returns courseIds whose `source_versions` listed any id (even if already needs_check / not dirty) so callers can enqueue rebuilds |
| `applyCorrections` after mark enqueues rebuild per course | **PASS** | Loop `for (const courseId of marked.courseIds)` → `knowledge.enqueueRebuild(scope, courseId, { clientKey: \`media-correction:${sourceId}:v${bumped}\` })` |
| Rebuild is **whole course**, not time-range | **PASS** | Uses K01 `enqueueRebuild` → `build-course-knowledge` with `{ courseId }` only; comments document same limitation as needs_check |
| Enqueue failures swallowed; no rollback of version bump | **PASS** | `try/catch` empty; unit proves bump + mark + job receipt proceed when enqueue throws |
| Tests: media-segments-service **9**; V01 four-file unit **22** | **PASS (actual)** | Re-run matches claim exactly |
| Still open: whisper, true async job kind, browser/classroom | **CONFIRMED** | Unchanged live gaps from `v01-verified.md` |

## Files reviewed (this delta)

- `packages/database/src/repositories/opening-knowledge.ts` — `markNeedsCheckForSources` return type `{ updated, courseIds }`; `courseIds` collected for every matching course before dirty-only update skip  
- `apps/web/src/features/opening/media/media-segments-service.ts` — deps.knowledge pick includes `enqueueRebuild`; post-mark best-effort full-course enqueue; swallow failures  
- `apps/web/src/features/opening/media/media-segments-service.test.ts` — +enqueue per course ordering; swallow enqueue failure without skipping job receipt; mark-fail still blocks enqueue + receipt  

## Ordering (reviewed)

1. Source CAS bump + object copy **commits** (`commitCorrectionBump` / `sql.begin`)  
2. `markNeedsCheckForSources(scope, [sourceId])` — failure **surfaces** (source already consistent at bumped)  
3. Best-effort `enqueueRebuild` per `marked.courseIds` — failure **swallowed**  
4. Thin sync `parse-media` / `segments-correction` `{ jobId }` receipt (unchanged)

## Tests re-run (actual)

```text
node node_modules/vitest/vitest.mjs run --project unit \
  apps/web/src/features/opening/media/media-segments-service.test.ts \
  apps/worker/src/parsers/media-segments.test.ts \
  apps/worker/src/jobs/parse-media.test.ts \
  packages/database/src/storage/opening-s3.test.ts
→ Test Files  4 passed (4)
→ Tests       22 passed (22)
→ Duration    ~4.5s
Breakdown: media-segments-service 9 + parse-media 7 + opening-s3 3 + media-segments 3 = 22
(+2 vs v01-verified / k01-invalidate four-file count of 20: enqueue-per-course + swallow-failure)
```

## Known gaps (do not treat as newly closed)

1. **faster-whisper / offline weights** — live transcription still optional / `CONFIGURATION`.  
2. **True async correction job kind** — still thin sync `{ jobId }` receipt (`createOnce` → claim → succeeded, no outbox).  
3. **Browser / authorized classroom footage** — not run; plan live path remains human.  
4. **Full-course rebuild only** — not time-scoped to the corrected interval (K01 has no time-range rebuild API).  
5. **Source-level needs_check only** — unchanged from k01-invalidate accept.

## Ledger

- **ACCEPT** this optional enqueueRebuild follow-up.  
- **tasks.json V01** left **`verified`** — **not edited** by this accepter (evidence array / status untouched).  
- **No commit / no push.**
