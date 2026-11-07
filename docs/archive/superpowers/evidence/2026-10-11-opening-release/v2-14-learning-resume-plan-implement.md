# V2-14 Learning resume — Plan-stage evidence (Understand + Plan only)

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Data (executor / Grok Bot)  
**Branch:** `feat/opening-release`  
**Tip HEAD:** `a8eb1937abd901691c4a926fa95f0832fe0aa584` (`a8eb193`) — matches PM tip baseline after V2-13 (`a8eb193`); working tree may have unrelated untracked docs — **not edited by this slice beyond listed paths**  
**Stage:** Understand → Plan only. **No product Implement. No ALTER. No push / hermes / stash / reset / commit.**  
**Status:** **Plan only — not ACCEPT** (await Integrator Plan ACCEPT/REJECT)  
**Gates:** `docs/superpowers/plans/opening-release/review-test-gates.md` (list what was read / run; do **not** self-ACCEPT)

## Diff scope (this slice)

### Written (docs only)

| Path | Role |
|---|---|
| `docs/superpowers/plans/ai-led-learning-v2/v2-14-learning-resume-understand.md` | Understand |
| `docs/superpowers/plans/ai-led-learning-v2/v2-14-learning-resume-plan.md` | Plan (await ACCEPT) |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-14-learning-resume-understand.md` | Understand-stage evidence |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-14-learning-resume-plan-implement.md` | This plan-stage evidence |

### Explicitly not touched

- No `apps/web/src/features/opening/teaching/resume-service.ts` product implementation
- No `apps/web/src/features/opening/teaching/resume-card.tsx` (Experience OOS)
- No `packages/contracts/src/opening/teaching-resume.ts` / `packages/domain/src/opening/teaching-resume.ts` product files
- No product edits to `read-service.ts`, teaching activity/content/commands repos, help/attempts repos
- No migration SQL under `packages/database/src/migrations/`
- No ALTER / migrate / psql
- No `tasks.json` status → verified / in_progress / planned changes
- No push / hermes / stash / reset / commit
- Unrelated untracked evidence elsewhere in tree not created/modified by this slice beyond the four paths above

## Tip / branch verification

```text
$ git rev-parse HEAD
a8eb1937abd901691c4a926fa95f0832fe0aa584

$ git branch --show-current
feat/opening-release

$ git log -1 --oneline
a8eb193 feat(opening): V2-13 teaching/answer evidence semantics (0057)

$ test ! -f apps/web/src/features/opening/teaching/resume-service.ts && echo RESUME_SERVICE_ABSENT
RESUME_SERVICE_ABSENT

$ test ! -f apps/web/src/features/opening/teaching/resume-card.tsx && echo RESUME_CARD_ABSENT
RESUME_CARD_ABSENT

$ ls packages/database/src/migrations/*.sql | tail -3
packages/database/src/migrations/0055_opening_compile_teaching_unit_job.sql
packages/database/src/migrations/0056_opening_intervention_settings.sql
packages/database/src/migrations/0057_opening_help_exposure_kind.sql
```

**Result:** tip `a8eb193`. Proposed resume-service / resume-card / teaching-resume contracts+domain **absent**. Migrations tip ends at **0057**; V2-14 Plan = **DDL NO** (nest checkpoint_json + derive open problems); placeholder **`00xx`** only if Integrator later assigns.

## Inventory commands / Reads

### Tip confirm

```text
$ git rev-parse HEAD
$ git status -sb
$ date '+%Y-%m-%d %H:%M %Z'
```

**Result:** exit 0 — HEAD `a8eb1937…`; branch `feat/opening-release`; local time CST 2026-10-11 ~13:19.

### Plan §V2-14 + tasks + gates + style

```text
$ Read docs/superpowers/plans/ai-led-learning-v2/plan.md L605–623 (+ §6.3 checkpoint)
$ Read docs/plans/2026-10-11-ai-led-learning-v2.md (charter G7)
$ Extract tasks.json V2-14
$ Read docs/superpowers/plans/opening-release/review-test-gates.md
$ Read v2-12-teaching-commands-understand.md / v2-12-teaching-commands-plan.md
$ Read v2-13-teaching-answer-evidence-understand.md / plan / evidence heads
```

### Required product inventory (read-only)

```text
$ Read apps/web/src/features/opening/learning/read-service.ts
$ Read apps/web/src/features/opening/teaching/activity-service.ts
$ Read apps/web/src/features/opening/teaching/teaching-content-service.ts
$ Read apps/web/src/features/opening/teaching/command-service.ts
$ Read packages/contracts/src/opening/teaching-activity.ts
$ Read packages/contracts/src/opening/teaching-content.ts (clientInit + drafts)
$ Read packages/contracts/src/opening/teaching-commands.ts
$ Read packages/domain/src/opening/teaching-commands.ts (checkpoint keys / merge)
$ Read packages/database/src/repositories/opening-teaching-content.ts (sanitize / getClientInit / saveDraftAnchors)
$ Read packages/database/src/repositories/opening-teaching-activities.ts (no setStatus; compile enqueue)
$ Read packages/database/src/repositories/opening-learning-facts.ts (admitLearningSources)
$ Read packages/database/src/repositories/opening-learning-help.ts (activity_id write; no list)
$ Read apps/worker/src/jobs/compile-teaching-unit.ts (unknown failure map)
$ Read apps/web/src/features/opening/tutor/conversation-continuity.ts (chat resume boundary)
$ rg API routes under teaching-activities / teaching/activities
$ rg localStorage under teaching/
$ ls migrations tip → 0057
```

## Plan decisions (summary for Integrator)

| Decision | Value |
|---|---|
| Smallest Data change | Compose `LearningResume` from existing activity + checkpoint + clientInit + activity-scoped fact reads; thin `resume-service.ts`; wire missing checkpoint/draft HTTP; thin pause status |
| DDL needed? | **NO** (default) |
| Placeholder if later | **`00xx`** — Integrator assigns; tip **0057** |
| Ownership | **Data:** contracts/domain/repos/resume-service/routes/OpeningApi helpers. **Experience:** `resume-card.tsx` **OOS** for Data Implement |
| PM locks 1–7 | Encoded in Plan §§1.3, 3, 8 |
| Open problems | **Derive** from attempts/observations (optional non-authoritative checkpoint cache) |
| Summary | Optional / skipped; **never** gates resume or draft save |
| Rejected | Chat-only resume; parallel table; local official state; LWW drafts; invent migration # |

## Acceptance checks preview (Implement — all `not_run` now)

T1–T18 listed in Plan §7 (ownership, assemble fields, thought train, sanitize, summary independence, CAS drafts, key preservation, job/material gates, open-problem derive, continuable actions, pause status, not ConversationResume, routes, no spurious migration).

## Self-check vs gates

- Diff scope listed ✓  
- Commands / reads listed ✓  
- No product tests claimed pass ✓ (Plan-stage `not_run`)  
- **Not** self-ACCEPT / not flipping tasks.json verified ✓  
- No push / hermes ✓  

## Outcome

Understand + Plan docs ready for **Integrator Plan ACCEPT**. No product code. Tip `a8eb193`. Migration **Y/N = N**. Experience `resume-card.tsx` documented as separate half / OOS for Data Implement.
