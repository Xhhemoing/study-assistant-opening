# V2-14 Learning resume — Implement ACCEPT (Data half)

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Reviewer:** AIstudy Integrator (executor / Grok Bot) — **≠** implementer (AIstudy Data)  
**Stage:** Independent Implement ACCEPT (Data half; no Experience UI)  
**Branch:** `feat/opening-release`  
**Baseline tip claimed (Plan ACCEPT / Implement):** `a8eb1937abd901691c4a926fa95f0832fe0aa584` (`a8eb193`)  
**Tip HEAD at Accept (dirty; no commit):** `a8eb1937abd901691c4a926fa95f0832fe0aa584` (`a8eb193`) — **exact match**  
**Verdict:** **ACCEPT**

## Authority / inputs

| Doc | Role |
|---|---|
| `docs/superpowers/plans/opening-release/review-test-gates.md` | Gates |
| `docs/superpowers/plans/ai-led-learning-v2/v2-14-learning-resume-plan.md` | Plan |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-14-learning-resume-plan-accept.md` | Plan ACCEPT |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-14-learning-resume-implement.md` | Data Implement claim |
| Style: `v2-13-teaching-answer-evidence-accept.md` | Accept sample |

## Tip / dirty tree

```text
$ git rev-parse HEAD
a8eb1937abd901691c4a926fa95f0832fe0aa584

$ git branch --show-current
feat/opening-release

$ git log -1 --oneline
a8eb193 feat(opening): V2-13 teaching/answer evidence semantics (0057)

$ date '+%Y-%m-%d %H:%M %Z'
2026-10-11 13:31 CST

$ test -z "$OPENING_TEST_DATABASE_URL" && echo unset
unset
```

### Commits vs uncommitted (V2-14)

| Layer | What | V2-14? |
|---|---|---|
| Tip commit `a8eb193` | V2-13 teaching/answer evidence (0057) — baseline | Baseline only |
| Uncommitted dirty product (M + ??) | contracts/domain teaching-resume; resume-service; GET resume / POST checkpoint / PATCH status; DB setStatus / saveCheckpoint CAS / material probe / help+attempts+obs heads; OpeningApi helpers | **Yes** — V2-14 Data Implement |
| Untracked docs/evidence | plan / understand / plan-accept / implement / this accept | Docs only |
| Other untracked (`rp5-gha-…`, `p0-assistant-list-…`) | Left untouched | **Not** V2-14 |

**No** stash / reset / commit / push / hermes on this Accept. Worked dirty tree as-is. Product behavior **not** edited.

## Migration / DDL

| Check | Result |
|---|---|
| New migration `0058*` | **Absent** (`ls …/0058*` → no 0058 migr) |
| Tip migrations end | `0057_opening_help_exposure_kind.sql` |
| Parallel resume table / new columns | **None** in diff |
| Nest only | `saveCheckpoint` writes `checkpoint_json` via `mergeCheckpointResumePatch` |
| T18 unit | `opening-teaching-resume-surface.test.ts` asserts no 0058 |

**DDL: NO** — holds.

## Stronger review (PM frozen / Plan hard rules)

| Lock | Diff finding |
|---|---|
| No DDL; nest `checkpoint_json` | `saveCheckpoint` UPDATE `checkpoint_json` only; no migr / no CREATE TABLE — **aligned** |
| Summary does **not** block resume | `resumeSummarySkipped()` always; `assertResumeIndependentOfSummary`; resume-service has **no** `summarizeLearning` / `read-service` import (T6 source assert) — **aligned** |
| Server authoritative / conflict juxtaposition | CAS `expectedVersion` → CONFLICT; `draft_anchor_lost` → 409 structured body (ok:false); OpeningApi treats 409 as parseable result — **aligned** (no silent LWW) |
| Gates fail-soft (permission / materials / unknown job) | Ownership via `assertOwnedActivity` → NOT_FOUND; `probeLearningSourcesAvailability` non-throwing + domain `probeMaterialsAvailability`; `mapGenerateStatusToJobGate` covers in_flight/unknown/stale/ready; drafts+thought still assembled — **aligned** |
| Route prefix **`teaching/activities`** for resume/checkpoint | `GET …/teaching/activities/[id]/resume`, `POST …/teaching/activities/[id]/checkpoint` — **aligned**. Status PATCH under `teaching-activities/[id]/status` (plan allowed sibling of client-init) — soft note below |
| Preserve V2-11/12 checkpoint keys | `mergeCheckpointResumePatch` overlays only drafts/currentBlockId/interactionParams/openProblemIds; domain `resumePatchPreservesCommandAndPrefsKeys` + T9 — **aligned** |
| Open problems derived | `deriveOpenProblems` from unsubmitted attempts + observation heads; checkpoint `openProblemIds` is non-authoritative `checkpoint_listed` only — **aligned** |
| No Experience resume-card | `resume-card.tsx` **ABSENT**; TeachingWorkspace chrome untouched — **aligned** |
| Not ConversationResume | Distinct `learningResumeSchema`; T16; resume route comment — **aligned** |
| Pause thin; complete ≠ mastery | `setStatus` active\|paused only; schema enum same — **aligned** |
| Tests not loosened | No `it.skip` / `.only` in claimed 7 test files |

### Soft gaps (non-blocking)

1. **`clientInit` nullable** when no ActivitySpec published (mid-generate) — Plan sketch had required clientInit; Implement allows null so jobGate + drafts remain readable. Reasonable fail-soft; Experience must null-check.
2. **Status route prefix** under `teaching-activities/{id}/status` (not `teaching/activities/…`) — Plan §2 explicitly allowed this sibling; matches client-init. Resume/checkpoint correctly use `teaching/activities`.
3. **Observation heads heuristic** (`effective_head_id IS NOT DISTINCT FROM id` OR original-root) — may need Integrator tighten later; derive unit-covered; live heads **not_run**.
4. Live DB ownership / CAS / sanitize / setStatus paths **not_run** (no `OPENING_TEST_DATABASE_URL`).

**Blockers:** **None**.

## Independent re-runs (Integrator)

### Vitest (exact Data claim set)

```text
$ PATH="./node_modules/.bin:$PATH" bash scripts/run-heavy.sh vitest run --project unit \
  packages/contracts/src/opening/teaching-resume.test.ts \
  packages/domain/src/opening/teaching-resume.test.ts \
  packages/database/src/repositories/opening-teaching-resume-surface.test.ts \
  packages/database/src/repositories/opening-teaching-activities.test.ts \
  apps/web/src/features/opening/teaching/resume-service.test.ts \
  apps/web/src/app/api/opening/teaching/activities/[id]/resume/route.test.ts \
  apps/web/src/app/api/opening/teaching/activities/[id]/checkpoint/route.test.ts

 Test Files  7 passed (7)
      Tests  35 passed (35)
   Duration  ~4.27s
exit 0
```

### Typecheck

```text
$ PATH="./node_modules/.bin:$PATH" bash scripts/run-heavy.sh tsc -p packages/contracts/tsconfig.json --noEmit
exit 0

$ PATH="./node_modules/.bin:$PATH" bash scripts/run-heavy.sh tsc -p packages/domain/tsconfig.json --noEmit
exit 0

$ PATH="./node_modules/.bin:$PATH" bash scripts/run-heavy.sh tsc -p packages/database/tsconfig.json --noEmit
exit 0

$ PATH="./node_modules/.bin:$PATH" bash scripts/run-heavy.sh tsc -p apps/web/tsconfig.json --noEmit
exit 0
```

## not_run (honest)

| Item | Reason |
|---|---|
| T2 live ownership NOT_FOUND against Postgres | `OPENING_TEST_DATABASE_URL` unset |
| T3/T5 live assemble + sanitize via real getClientInit+DB | no test DB; unit/surface only |
| T7 live CAS CONFLICT / T8 live draft_anchor_lost / T15 live setStatus | no test DB; code paths unit-covered |
| HTTP E2E against real Next server | Out of Data unit scope; route unit mocks only |
| Experience resume-card / Workspace continue | OOS (Experience half) |

## Forbidden actions (this Accept)

- **No** push / hermes / commit / stash / reset  
- **No** product behavior edits to force green  
- **No** `tasks.json` → verified (left alone; prefer prior pattern)  
- **No** Experience UI required or added  
- **No** invent migr `0058` / live ALTER

## Verdict

**ACCEPT** Data Implement of V2-14 Learning resume at dirty tip `a8eb193` (product uncommitted only; HEAD exact match to Plan ACCEPT baseline).

- Required runnable checks re-run green: vitest **7 files / 35 tests** exit 0; tsc contracts/domain/database/web all exit 0.  
- **No DDL / no 0058**; nest checkpoint_json; PM locks hold under stronger review.  
- Soft gaps + live DB/HTTP **`not_run`** listed honestly.  
- Experience resume-card remains a separate slice.
