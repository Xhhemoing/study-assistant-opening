# V2-14 Learning resume — Implement Evidence (Data half)

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Data implementer (executor / Grok Bot)  
**Branch:** `feat/opening-release`  
**Baseline tip (assignment / Plan ACCEPT):** `a8eb1937abd901691c4a926fa95f0832fe0aa584` (`a8eb193`)  
**Tip HEAD at Implement write (dirty; no commit):** `a8eb1937abd901691c4a926fa95f0832fe0aa584` (`a8eb193`) — **exact match**; product changes uncommitted only  
**Status:** **implemented, awaiting Integrator Implement ACCEPT** — do **not** self-ACCEPT; `tasks.json` not marked verified  
**Hard rules held:** No push / hermes / stash / reset / commit · No DDL · No Experience UI (`resume-card.tsx` OOS) · Exclusive Data tree

## Authority followed

- Plan ACCEPT: `docs/superpowers/evidence/2026-10-11-opening-release/v2-14-learning-resume-plan-accept.md`
- Plan: `docs/superpowers/plans/ai-led-learning-v2/v2-14-learning-resume-plan.md`
- Understand: `docs/superpowers/plans/ai-led-learning-v2/v2-14-learning-resume-understand.md`
- Gates: `docs/superpowers/plans/opening-release/review-test-gates.md`
- PM locks: LearningResume + resume-service + GET resume / POST checkpoint; nest `checkpoint_json` only; material probe fail-soft; open problems derive from facts; summary never blocks; CAS + preserve V2-11/V2-12 keys; server authority; Experience UI delayed

## Diff scope

### New

| Path | Role |
|---|---|
| `packages/contracts/src/opening/teaching-resume.ts` (+ test) | LearningResume / checkpoint / status schemas |
| `packages/domain/src/opening/teaching-resume.ts` (+ test) | merge/gates/derive/continuable/summary-independence |
| `apps/web/src/features/opening/teaching/resume-service.ts` (+ test) | assemble + saveCheckpoint + setStatus facade |
| `apps/web/src/app/api/opening/teaching/activities/[id]/resume/route.ts` (+ test) | GET LearningResume |
| `apps/web/src/app/api/opening/teaching/activities/[id]/checkpoint/route.ts` (+ test) | POST checkpoint CAS |
| `apps/web/src/app/api/opening/teaching-activities/[id]/status/route.ts` | PATCH active↔paused |
| `packages/database/src/repositories/opening-teaching-resume-surface.test.ts` | Surface / T18 no-0058 |

### Updated

| Path | Change |
|---|---|
| `packages/contracts/src/opening/index.ts` | export teaching-resume |
| `packages/domain/src/index.ts` | export teaching-resume helpers |
| `packages/database/src/index.ts` | export probe + listDeliveredHelpByActivity + listObservationHeadsByActivity |
| `packages/database/.../opening-teaching-activities.ts` (+ test) | `setStatus` active\|paused + optional expectedUpdatedAt CAS |
| `packages/database/.../opening-teaching-content.ts` | `saveCheckpoint` CAS + `mergeCheckpointResumePatch` |
| `packages/database/.../opening-learning-facts.ts` | `probeLearningSourcesAvailability` (non-throwing) |
| `packages/database/.../opening-learning-help.ts` | `listDeliveredHelpByActivity` |
| `packages/database/.../opening-learning-attempts.ts` | `listByActivity` (+ observation outcome join) |
| `packages/database/.../opening-learning-observations.ts` | `listObservationHeadsByActivity` |
| `apps/web/.../runtime.ts` | `getTeachingResumeService` |
| `apps/web/.../client/api.ts` | `getTeachingResume` / `postTeachingCheckpoint` / `patchTeachingActivityStatus` |

### Explicitly not touched

- **Experience** `resume-card.tsx` / Workspace continue chrome
- `learning/read-service.ts` (pattern ref only; assemble never calls summarize)
- Tutor `ConversationResume` / chat resume routes
- Any migration SQL / inventing `0058`
- push / commit / hermes / stash / reset / self-ACCEPT / `tasks.json` verified flip
- Unrelated untracked evidence (`rp5-gha-…`, `p0-assistant-list-…`) left as-is

## Behavior landed

| Rule | Behavior |
|---|---|
| Breakpoint package | GET resume returns contentVersion/pathVersion, thoughtTrain, drafts, attempts, help, openProblems, gates, continuableActions; clientInit nullable when no ActivitySpec (mid-generate) |
| Nest only | Writes go to `checkpoint_json` via merge; **no DDL** |
| Materials | Soft probe → `available\|partial\|unavailable` + unavailableSourceIds (does not throw like admit) |
| Open problems | Derived from unsubmitted attempts + observation heads; optional `openProblemIds` cache non-authoritative |
| Summary | Always `summary.status=skipped`; no AI/summarize call on resume or checkpoint |
| CAS | Checkpoint/draft writes require `expectedVersion`; stale → CONFLICT; draft_anchor_lost → 409 structured |
| Merge | `mergeCheckpointResumePatch` preserves interventionPrefs/Decisions + V2-12 command keys |
| Pause | Thin `setStatus` / PATCH status active↔paused; complete ≠ mastery unchanged |
| Not chat | LearningResume ≠ ConversationResume (T16) |

## Tests T1–T18

| ID | Status | Where / note |
|---|---|---|
| T1 | **pass** | `teaching-resume.test.ts` (contracts) — parse; reject missing activityId/contentVersion |
| T2 | **not_run** | Live DB ownership NOT_FOUND — no `OPENING_TEST_DB` / HTTP integration this slice; ownership via `assertOwnedActivity` wired |
| T3 | **pass** (unit) | Domain + resume-service surface; full assemble with DB **not_run** |
| T4 | **pass** | domain `extractThoughtTrain` |
| T5 | **not_run** | Live sanitize via getClientInit+DB; sanitize helper reused; unit surface only |
| T6 | **pass** | resume-service source: no summarize call / no read-service import; `assertResumeIndependentOfSummary` |
| T7 | **not_run** | Live CAS CONFLICT against DB; code path throws CONFLICT on stale expectedVersion |
| T8 | **pass** (route unit) | checkpoint route returns 409 `draft_anchor_lost`; live DB **not_run** |
| T9 | **pass** | domain merge preserves prefs + commandLog |
| T10 | **pass** | domain mapGenerateStatusToJobGate in_flight |
| T11 | **pass** | domain jobGate unknown |
| T12 | **pass** | domain probeMaterialsAvailability |
| T13 | **pass** | domain deriveOpenProblems |
| T14 | **pass** | domain command_return iff branchStack |
| T15 | **pass** (unit mock) | activities `setStatus` test; live DB **not_run** |
| T16 | **pass** | contracts LearningResume ≠ ConversationResume |
| T17 | **pass** | resume + checkpoint route unit (auth mock + zod) |
| T18 | **pass** | no `0058` migration; tip migrations end `0057` |

### Commands re-run (this Implement)

```text
$ npx vitest run --project unit \
  packages/contracts/src/opening/teaching-resume.test.ts \
  packages/domain/src/opening/teaching-resume.test.ts \
  packages/database/src/repositories/opening-teaching-resume-surface.test.ts \
  packages/database/src/repositories/opening-teaching-activities.test.ts \
  apps/web/src/features/opening/teaching/resume-service.test.ts \
  apps/web/src/app/api/opening/teaching/activities/[id]/resume/route.test.ts \
  apps/web/src/app/api/opening/teaching/activities/[id]/checkpoint/route.test.ts
# → 7 files, 35 tests passed

$ npx tsc -p packages/contracts/tsconfig.json --noEmit   # OK
$ npx tsc -p packages/domain/tsconfig.json --noEmit      # OK
$ npx tsc -p packages/database/tsconfig.json --noEmit    # OK
$ npx tsc -p apps/web/tsconfig.json --noEmit             # OK

$ git rev-parse HEAD
a8eb1937abd901691c4a926fa95f0832fe0aa584

$ date '+%Y-%m-%d %H:%M %Z'
2026-10-11 13:28 CST
```

### not_run (honest)

| Check | Reason |
|---|---|
| T2 / T3 live assemble / T5 live sanitize / T7 live CAS / T8 live draft_anchor_lost / T15 live setStatus | No `OPENING_TEST_DB` / integration project not run this slice |
| HTTP E2E against real Next server | Out of Data unit scope; routes covered by mocked unit only |
| Experience resume-card / Workspace continue | OOS (Experience half) |

## Soft gaps (for Integrator)

1. `clientInit` is **nullable** when no ActivitySpec is published (mid-generate / empty) so jobGate + drafts remain readable — Plan sketch had required clientInit.
2. Route prefix: GET/POST under `teaching/activities/{id}/…` (matches commands); status PATCH under `teaching-activities/{id}/status` (matches client-init sibling).
3. Open-problem heads query uses effective_head OR original-root heuristic; Integrator may tighten.

## Accept readiness

Ready for **Integrator Implement ACCEPT**: Data product tree complete per Plan file list; DDL **NO**; Experience card absent; tip still `a8eb193` dirty; tests T1/T4/T6/T9–T14/T16–T18 green; DB/HTTP live **not_run** honestly listed. This evidence does **not** self-ACCEPT.
