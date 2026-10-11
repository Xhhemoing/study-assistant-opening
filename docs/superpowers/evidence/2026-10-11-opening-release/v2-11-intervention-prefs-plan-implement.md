# V2-11 Intervention prefs — Plan-stage evidence (Understand + Plan only)

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Data (executor / Grok Bot)  
**Branch:** `feat/opening-release`  
**Tip HEAD:** `0436946ed1dd58aa414313bb1283e9f2e7f162c3` — **matches required tip** (V2-10 merged)  
**Stage:** Understand → Plan only. **No product Implement. No ALTER. No push / hermes / stash / reset / commit.**  
**Status:** **Plan only — not ACCEPT** (await Integrator Plan ACCEPT/REJECT)  
**Gates:** `docs/superpowers/plans/opening-release/review-test-gates.md` (list what was read / run; do **not** self-ACCEPT)

## Diff scope (this slice)

### Written (docs only)

| Path | Role |
|---|---|
| `docs/superpowers/plans/ai-led-learning-v2/v2-11-intervention-prefs-understand.md` | Understand |
| `docs/superpowers/plans/ai-led-learning-v2/v2-11-intervention-prefs-plan.md` | Plan (await ACCEPT) |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-11-intervention-prefs-plan-implement.md` | This plan-stage evidence |

### Explicitly not touched

- No `packages/domain/src/opening/intervention-policy.ts`
- No `packages/contracts/src/opening/intervention-prefs.ts`
- No `apps/web/src/features/opening/teaching/preference-controls.tsx`
- No edits to `tutor-policy.ts` / `tutor-policy-adaptive.ts` / `ai-settings.ts` / `planning-settings.ts`
- No migration SQL under `packages/database/src/migrations/`
- No ALTER / migrate / psql
- No `tasks.json` status → verified / in_progress / planned changes
- No push / hermes / stash / reset / commit
- Unrelated untracked evidence in tree (e.g. `rp5-gha-…`, `p0-assistant-list-preview-failsoft-implement.md`) not created/modified by this slice

## Tip / branch verification

```text
$ git rev-parse HEAD
0436946ed1dd58aa414313bb1283e9f2e7f162c3

$ git branch --show-current
feat/opening-release

$ git log -1 --oneline
0436946 feat(opening): V2-10 teaching workspace UI + client-init

$ test ! -f packages/domain/src/opening/intervention-policy.ts \
  && test ! -f apps/web/src/features/opening/teaching/preference-controls.tsx \
  && echo absent
absent

$ ls packages/database/src/migrations/*.sql | tail -3
packages/database/src/migrations/0053_opening_teaching_activities.sql
packages/database/src/migrations/0054_opening_teaching_content.sql
packages/database/src/migrations/0055_opening_compile_teaching_unit_job.sql
```

**Result:** tip OK (`0436946`). Proposed product files **absent**. Migrations tip ends at **0055**; V2-11 Plan = **DDL yes** with placeholder **`00xx`** (Integrator assigns).

## Inventory commands / Reads

### Tip confirm

```text
$ git rev-parse HEAD
$ git status -sb
$ date '+%Y-%m-%d %H:%M %Z'
```

**Result:** exit 0 — HEAD matches required `0436946ed1dd58aa414313bb1283e9f2e7f162c3`; branch `feat/opening-release`; local time CST 2026-10-11.

### Plan §V2-11 + tasks + gates + style

```text
$ Read docs/superpowers/plans/ai-led-learning-v2/plan.md L545–563
$ Read docs/superpowers/plans/ai-led-learning-v2/tasks.json (V2-11 block ~L599–646)
$ Read docs/superpowers/plans/opening-release/review-test-gates.md
$ Read v2-05-teaching-content-understand.md / v2-05-teaching-content-plan.md (style)
$ Read docs/product/UX_AND_AI_POLICY.md (§3 AI modes, §5 anti-代学)
$ Read docs/decisions/ADR-teaching-activity-context.md (activity / facts path)
```

**Result:** scope/reuse/proposed paths/acceptance/rollback aligned; Data owns policy+persistence; Experience owns preference-controls UI.

### Settings nesting patterns

```text
$ Read packages/contracts/src/opening/planning-settings.ts
$ Read packages/contracts/src/opening/ai-settings.ts
$ Read packages/contracts/src/workspace-preferences.ts
$ Read packages/domain/src/opening/learning-preferences.ts
$ Read packages/database/src/schema/preferences.ts
$ Read packages/database/src/schema/courses.ts (assessment/retest columns)
$ Read packages/database/src/migrations/0036_opening_ai_settings.sql
$ Read packages/database/src/migrations/0047_opening_planning_settings.sql
$ Read packages/database/src/repositories/opening-ai-settings.ts
$ rg -n "planning-settings|ai-settings" apps/web/src/app/api apps/web/src/features
```

**Result:** exit 0 — jsonb-on-`workspace_preferences` + DEFAULT_* + invalidStoredSettings pattern; course×account learning prefs resolve; Plan nests `intervention_settings` as sibling jsonb (not parallel product; not inside `ai_settings`).

### Tutor policy / help / activity attach

```text
$ Read packages/domain/src/opening/tutor-policy.ts
$ Read packages/domain/src/opening/tutor-policy-adaptive.ts
$ Read packages/contracts/src/opening/teaching-activity.ts
$ Read packages/database/src/schema/opening-learning.ts (sessions, help_exposures)
$ Read packages/database/src/migrations/0053_opening_teaching_activities.sql (checkpoint_json)
$ rg -n "preference-controls|intervention-policy|DEFAULT_OPENING_PLANNING|quiet" \
    packages/domain packages/contracts apps/web/src/features/opening docs/product
```

**Result:** exit 0 — thin path can escalate `hinted`→`worked_example`; adaptive keeps worked_example request-driven; checkpoint_json available for session overlay + decision ring; preference-controls / intervention-policy **absent**.

### Prior evidence style

```text
$ Read docs/superpowers/evidence/2026-10-11-opening-release/v2-05-teaching-content-plan-implement.md (limit)
$ Read docs/superpowers/evidence/2026-10-11-opening-release/v2-10-teaching-workspace-plan-implement.md (limit)
```

**Result:** plan-stage evidence shape followed (diff scope, tip, inventory, tests `not_run`).

## Tests

| Suite / check | Status | Reason |
|---|---|---|
| `packages/domain/src/opening/intervention-policy.test.ts` | **`not_run`** | Plan stage — file not created |
| Contract / repo / API tests for intervention settings | **`not_run`** | Plan stage — no product Implement |
| Experience preference-controls UI tests | **`not_run`** | Experience owns UI; out of this Data slice |
| Vitest / typecheck / integration / browser | **`not_run`** | No product code changed |

## Plan decisions captured (for Accept checklist)

- Domain `decideIntervention` + `resolveInterventionPrefs`; decisions `none|defer|offer|respond` + reason.
- Nest `intervention_settings` jsonb on `workspace_preferences` + `courses`; session overlay + decision ring in activity `checkpoint_json`.
- Migration **yes** → `00xx_opening_intervention_settings.sql` (tip ends **0055**); **no** decisions table in M1.
- Rejected: parallel settings product; dwell-time stuck; auto-expand after hint; fixed N-minute nag.
- Open questions have Plan defaults (balanced default; ring=20; consecutive reject=2; sibling API route).

## Forbidden actions (confirmed not done)

- No commit / push / hermes / stash / reset  
- No ALTER / migrate  
- No product code  
- No self-ACCEPT / `tasks.json` → verified  

## Next

Integrator Plan ACCEPT/REJECT. On ACCEPT: Integrator assigns `00xx` → Data Implement (contracts/domain/repo/API) + Experience UI half separately.
