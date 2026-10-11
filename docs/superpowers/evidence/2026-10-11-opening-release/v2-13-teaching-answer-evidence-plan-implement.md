# V2-13 Teaching & answer evidence — Plan-stage evidence (Understand + Plan only)

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Data (executor / Grok Bot)  
**Branch:** `feat/opening-release`  
**Tip HEAD:** `9a508a72d16b23b70c6aa3701ff35348ce18c3f0` (`9a508a7`) — matches working tip; Experience dirty UI may exist on tree — **not edited**  
**Stage:** Understand → Plan only. **No product Implement. No ALTER. No push / hermes / stash / reset / commit.**  
**Status:** **Plan only — not ACCEPT** (await Integrator Plan ACCEPT/REJECT)  
**Gates:** `docs/superpowers/plans/opening-release/review-test-gates.md` (list what was read / run; do **not** self-ACCEPT)

## Diff scope (this slice)

### Written (docs only)

| Path | Role |
|---|---|
| `docs/superpowers/plans/ai-led-learning-v2/v2-13-teaching-answer-evidence-understand.md` | Understand |
| `docs/superpowers/plans/ai-led-learning-v2/v2-13-teaching-answer-evidence-plan.md` | Plan (await ACCEPT) |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-13-teaching-answer-evidence-understand.md` | Understand-stage evidence |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-13-teaching-answer-evidence-plan-implement.md` | This plan-stage evidence |

### Explicitly not touched

- No `packages/domain/src/opening/teaching-exposure.ts` product implementation
- No product edits to `packages/contracts/src/opening/learning.ts`, `retest-close-evidence.ts`, `opening-skill-evidence.ts`, `opening-learning-help.ts`, `tutor-turn.ts`
- No Experience UI under `apps/web/src/features/opening/teaching/`
- No migration SQL under `packages/database/src/migrations/`
- No ALTER / migrate / psql
- No `tasks.json` status → verified / in_progress / planned changes
- No push / hermes / stash / reset / commit
- Unrelated untracked evidence elsewhere in tree not created/modified by this slice

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

$ ls packages/database/src/migrations/*.sql | tail -3
packages/database/src/migrations/0054_opening_teaching_content.sql
packages/database/src/migrations/0055_opening_compile_teaching_unit_job.sql
packages/database/src/migrations/0056_opening_intervention_settings.sql
```

**Result:** tip `9a508a7`. Proposed `teaching-exposure.ts` **absent**. Migrations tip ends at **0056**; V2-13 Plan = **DDL YES** (`kind` [+ optional `activity_id`]); placeholder **`00xx`** — Integrator assigns.

## Inventory commands / Reads

### Tip confirm

```text
$ git rev-parse HEAD
$ git status -sb
$ date '+%Y-%m-%d %H:%M %Z'
```

**Result:** exit 0 — HEAD `9a508a72…`; branch `feat/opening-release`; local time CST 2026-10-11 ~13:00.

### Plan §V2-13 + tasks + gates + ADR + style

```text
$ Read docs/superpowers/plans/ai-led-learning-v2/plan.md L585–603
$ Read docs/plans/2026-10-11-ai-led-learning-v2.md (charter)
$ Extract tasks.json V2-13
$ Read docs/decisions/ADR-teaching-activity-context.md D3/D4
$ Read docs/superpowers/plans/opening-release/review-test-gates.md
$ Read v2-12-teaching-commands-understand.md / v2-12-teaching-commands-plan.md / v2-12-…-plan-implement.md
$ Read v2-06-teaching-evidence-understand.md (boundary only)
```

### Required product inventory (read-only)

```text
$ Read packages/contracts/src/opening/learning.ts
$ Read packages/contracts/src/opening/learning-evidence.ts
$ Read packages/contracts/src/opening/teaching-activity.ts
$ Read packages/domain/src/opening/retest-close-evidence.ts
$ Read packages/domain/src/opening/evidence-eligibility.ts
$ Read packages/domain/src/opening/evidence-eligibility-timing.ts
$ Read packages/domain/src/opening/assistance.ts
$ Read packages/database/src/repositories/opening-skill-evidence.ts
$ Read packages/database/src/repositories/opening-learning-help.ts
$ Read packages/database/src/repositories/opening-learning-observations.ts (activity_id insert)
$ Read apps/worker/src/jobs/tutor-turn.ts (L01 helpExposure)
$ Read apps/web/src/features/opening/learning/attempt-service.ts (prepareRetestSkillLink)
$ rg / Read migrations 0019 / 0028 / 0053 help & activity_id
```

**Result:** Gaps confirmed — no exposure `kind`; transfer default present; help_exposures lacks activity_id; course observationInput still requires courseId; teaching-exposure absent.

## Stronger review (Plan claims vs PM + files)

| Plan claim | Grounding |
|---|---|
| Add `kind` instruction\|hint\|solution | `helpExposureSchema` today only `level` hinted\|revealed (`learning.ts`) |
| Ignore instruction in item assistance | `evaluateAssistance` / `resolveAssistance` have no kind filter today |
| Keep wire `unverified` as PM unknown | `observationOutcomeSchema` |
| Remove transfer default | `RETEST_CLOSE_DEFAULT_DIMENSION` + `prepareRetestSkillLink` L67 |
| Course APIs unchanged | ADR D3 + `observationInputSchema.courseId` |
| Complete ≠ mastery | teaching `completed` status vs SkillEvidence link APIs — explicit guard planned |
| needs_check when unverifiable | summary/eligibility already; Plan forbids soft upgrade |
| Nest existing; DDL YES `00xx` | Extend `opening_help_exposures`; tip **0056** |
| tutor-turn thin field only | Data vs worker ownership table in Plan |
| Tests T1–T18 | All **`not_run`** at Plan stage |

## Plan summary (for Accept reviewer)

- **ExposureKind** on delivered help; instruction does not pollute item assistance.
- **Outcomes** stay correct/incorrect/unverified (unknown≡unverified); same observation path; course v1 unchanged; v2 activity adapter additive.
- **Remove** delayed default `transfer`; explicit dimension or no SkillEvidence link.
- **Stable** problem/item/version identity; no infer-from-rename.
- **Help evidenced**; activity complete ≠ mastery; unverifiable → needs_check.
- **DDL:** **YES** — Integrator assigns `00xx` (no number invented).
- **Tests T1–T18:** all **`not_run`**.
- **Rejected:** parallel mastery; enum rename; keep transfer default; tutor orchestration rewrite; Experience UI this slice.

## Open questions (Plan defaults — escalate only if rejected)

1. Keep wire `unverified` for unknown.  
2. Omitted dimension → no SkillEvidence link.  
3. Instruction on same help table via `kind`.  
4. DDL YES (`kind` + nullable `activity_id`).  
5. Tutor mapping explain∧¬problem → instruction.  
6. Optional item_version_id on help if Integrator OK.  
7. course_id nullable not in V2-13 default.

## Gate compliance

| Gate item | This slice |
|---|---|
| Diff scope listed | Yes (docs only) |
| Commands / reads listed | Yes |
| Results / tip | Yes — tip `9a508a7` |
| Planned Implement tests | T1–T18 all **`not_run`** |
| Self-ACCEPT / verified | **No** — await Plan ACCEPT |
| Push / hermes | **Not done** |
| tasks.json verified | **Not flipped** |

## Next

Await **Plan ACCEPT** from Integrator / designated Reviewer before any Implement / ALTER / product code. Integrator must assign migration number if ACCEPT includes DDL YES.
