# V2-13 Teaching & answer evidence — Understand-stage evidence

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Data (executor / Grok Bot)  
**Branch:** `feat/opening-release`  
**Tip HEAD:** `9a508a72d16b23b70c6aa3701ff35348ce18c3f0` (`9a508a7`) — Experience may have dirty UI on tree; docs-only slice  
**Stage:** Understand only (paired Plan written same turn). **No product Implement. No ALTER. No push / hermes / stash / reset / commit.**  
**Status:** Understand complete → Plan written; **not ACCEPT**  
**Gates:** `docs/superpowers/plans/opening-release/review-test-gates.md`

## Diff scope (this stage)

### Written

| Path | Role |
|---|---|
| `docs/superpowers/plans/ai-led-learning-v2/v2-13-teaching-answer-evidence-understand.md` | Understand |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-13-teaching-answer-evidence-understand.md` | This evidence |

### Explicitly not touched

- No `packages/domain/src/opening/teaching-exposure.ts` product file
- No edits to `learning.ts` / `retest-close-evidence.ts` / `opening-skill-evidence.ts` / `tutor-turn.ts` product code
- No Experience UI files
- No migration SQL; no ALTER
- No `tasks.json` verified / in_progress flip
- No push / hermes / stash / reset / commit

## Tip / branch verification

```text
$ git rev-parse HEAD
9a508a72d16b23b70c6aa3701ff35348ce18c3f0

$ git branch --show-current
feat/opening-release

$ git log -1 --oneline
9a508a7 feat(opening): V2-12 teaching command controls UI

$ test ! -f packages/domain/src/opening/teaching-exposure.ts && echo ABSENT
ABSENT

$ ls packages/database/src/migrations/*.sql | tail -1
packages/database/src/migrations/0056_opening_intervention_settings.sql

$ date '+%Y-%m-%d %H:%M %Z'
2026-10-11 13:00 CST
```

## Inventory Reads (commands / paths)

### Authority

- `docs/plans/2026-10-11-ai-led-learning-v2.md` (charter G6/G8, facts ledger)
- `docs/superpowers/plans/ai-led-learning-v2/plan.md` §V2-13 (~L585–603)
- `docs/superpowers/plans/ai-led-learning-v2/tasks.json` id V2-13
- `docs/decisions/ADR-teaching-activity-context.md` D3/D4
- `docs/superpowers/plans/opening-release/review-test-gates.md`
- Style: `v2-12-teaching-commands-understand.md` / plan / plan-implement evidence
- Boundary: `v2-06-teaching-evidence-understand.md` head (claim pack ≠ attempt semantics)

### Required inventory paths

- `packages/contracts/src/opening/learning.ts` — outcomes, assistance, helpExposure, observationInput, summary needs_check
- `packages/contracts/src/opening/learning-evidence.ts` — eligibility shape
- `packages/contracts/src/opening/teaching-activity.ts` — activityObservationInputSketch; completed status
- `packages/contracts/src/opening/knowledge.ts` — skillEvidence dimensions
- `packages/domain/src/opening/retest-close-evidence.ts` — **RETEST_CLOSE_DEFAULT_DIMENSION = transfer**
- `packages/domain/src/opening/evidence-eligibility.ts` + `evidence-eligibility-timing.ts` — assistance/help association
- `packages/domain/src/opening/assistance.ts` — resolveAssistance
- `packages/database/src/repositories/opening-skill-evidence.ts` — link / flagsForNode
- `packages/database/src/repositories/opening-learning-help.ts` — insertOpeningDeliveredHelp
- `packages/database/src/repositories/opening-learning-observations.ts` — activity_id insert path
- `apps/worker/src/jobs/tutor-turn.ts` — L01 helpExposure with problemId null on hint/explain
- Migrations `0019` help table; `0028` help columns; `0053` activity_id (sessions/obs/attempts/item_versions — **not** help_exposures); tip **0056**
- `apps/web/src/features/opening/learning/attempt-service.ts` — prepareRetestSkillLink consumer (read-only)

## Stronger-review (restatement vs PM)

| PM wording | Restatement encoding | Risk if drifted |
|---|---|---|
| correct/incorrect/**unknown** | Wire keeps **`unverified`** as unknown slot | Breaking course rename |
| Remove delayed default **transfer** | Target `RETEST_CLOSE_DEFAULT_DIMENSION` / prepareRetest default | Leaving silent transfer inflation |
| instruction vs hint/solution | Missing `kind` on helpExposure + tutor null problemId | Concept teaching pollutes items |
| Complete ≠ mastery | Guard activity completed side effects | Progress mistaken for SkillEvidence |
| Nest existing model | Extend help/eligibility; no parallel ledger | Second scoring system |
| Course unchanged | Keep observationInput courseId required | v1 client break |

## Understand outcome

- Outcome / OOS / open decisions recorded in Understand doc.
- PM locks 1–6 mapped to real symbols.
- Ready for Plan (Plan written in same delivery turn).

## Gate compliance

| Gate item | This stage |
|---|---|
| Diff scope | Docs only |
| Reads listed | Yes |
| Product code / ALTER | **None** |
| Self-ACCEPT / verified | **No** |
| Push / hermes | **Not done** |
