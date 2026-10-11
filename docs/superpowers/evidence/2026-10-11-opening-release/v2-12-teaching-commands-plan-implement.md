# V2-12 Teaching commands — Plan-stage evidence (Understand + Plan only)

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Data (executor / Grok Bot)  
**Branch:** `feat/opening-release`  
**Tip HEAD:** `3083809f7c29652f6a859a81bd402c486e5e66d1` — **matches required tip** (V2-11 full merged)  
**Stage:** Understand → Plan only. **No product Implement. No ALTER. No push / hermes / stash / reset / commit.**  
**Status:** **Plan only — not ACCEPT** (await Integrator Plan ACCEPT/REJECT)  
**Gates:** `docs/superpowers/plans/opening-release/review-test-gates.md` (list what was read / run; do **not** self-ACCEPT)

## Diff scope (this slice)

### Written (docs only)

| Path | Role |
|---|---|
| `docs/superpowers/plans/ai-led-learning-v2/v2-12-teaching-commands-understand.md` | Understand |
| `docs/superpowers/plans/ai-led-learning-v2/v2-12-teaching-commands-plan.md` | Plan (await ACCEPT) |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-12-teaching-commands-plan-implement.md` | This plan-stage evidence |

### Explicitly not touched

- No `apps/web/src/features/opening/teaching/command-service.ts`
- No `apps/web/src/app/api/opening/teaching/activities/[id]/commands/route.ts`
- No `packages/contracts/src/opening/teaching-commands.ts`
- No `packages/domain/src/opening/teaching-commands.ts`
- No edits to library / teaching-content / intervention-policy product code
- No migration SQL under `packages/database/src/migrations/`
- No ALTER / migrate / psql
- No `tasks.json` status → verified / in_progress / planned changes
- No push / hermes / stash / reset / commit
- Unrelated untracked evidence in tree (e.g. `rp5-gha-…`, `p0-assistant-list-preview-failsoft-implement.md`) not created/modified by this slice

## Tip / branch verification

```text
$ git rev-parse HEAD
3083809f7c29652f6a859a81bd402c486e5e66d1

$ git branch --show-current
feat/opening-release

$ git log -1 --oneline
3083809 feat(opening): V2-11 intervention preference-controls UI

$ test ! -f apps/web/src/features/opening/teaching/command-service.ts \
  && test ! -f apps/web/src/app/api/opening/teaching/activities/\[id\]/commands/route.ts \
  && echo absent
absent

$ ls packages/database/src/migrations/*.sql | tail -3
packages/database/src/migrations/0054_opening_teaching_content.sql
packages/database/src/migrations/0055_opening_compile_teaching_unit_job.sql
packages/database/src/migrations/0056_opening_intervention_settings.sql
```

**Result:** tip OK (`3083809`). Proposed product files **absent**. Migrations tip ends at **0056**; V2-12 Plan = **DDL no** (checkpoint-only); placeholder **`00xx`** only if PM later requires audited command table.

## Inventory commands / Reads

### Tip confirm

```text
$ git rev-parse HEAD
$ git status -sb
$ date '+%Y-%m-%d %H:%M %Z'
```

**Result:** exit 0 — HEAD matches required `3083809f7c29652f6a859a81bd402c486e5e66d1`; branch `feat/opening-release`; local time CST 2026-10-11 ~12:28.

### Plan §V2-12 + tasks + gates + style

```text
$ Read docs/superpowers/plans/ai-led-learning-v2/plan.md L565–583 (+ §6.3 L146–158)
$ Read docs/superpowers/plans/ai-led-learning-v2/tasks.json (V2-12 block ~L649–698)
$ Read docs/superpowers/plans/opening-release/review-test-gates.md
$ Read v2-11-intervention-prefs-understand.md / v2-11-intervention-prefs-plan.md (style)
$ Read v2-05-teaching-content-understand.md / v2-05-teaching-content-plan.md (CAS / drafts)
$ Read v2-10-teaching-workspace-understand.md (clientInit / nest workspace)
```

### Product attach surfaces (read-only)

```text
$ Read packages/contracts/src/opening/teaching-content.ts (publish / clientInit / drafts)
$ Read packages/contracts/src/opening/teaching-activity.ts (pathVersion / contentVersion / skipped status)
$ Read packages/database/src/repositories/opening-teaching-content.ts (getClientInit / saveDraftAnchors / publish CAS)
$ Read packages/database/src/repositories/library.ts updateDocument expectedRevisionNumber CONFLICT
$ rg interventionPrefs|drafts packages/domain/src/opening/intervention-policy.ts
$ ls apps/web/src/features/opening/teaching/ (workspace / prefs present; command-service absent)
```

**Result:** CAS patterns and checkpoint key disjointness identified; skip≠observation gap confirmed; no command product files.

## Plan summary (for Accept reviewer)

- **Envelope:** `why|rephrase|expand|example|skip|branch|return` + `activityId`/`blockId`/`expectedVersion`/`clientKey`.
- **Rewrite:** new library Revision + pin spec + bump `content_version`; never mutate old revision; preserve drafts.
- **Skip:** checkpoint only; **no** wrong-answer observation write.
- **Branch/return:** `checkpoint_json.branchStack` same activity; bump `path_version`.
- **Conflict:** explicit codes; forbid LWW; soft-idempotent clientKey.
- **DDL:** **none** (M1); tip migrations end **0056**.
- **Tests T1–T18:** all **`not_run`** (Plan stage).
- **Rejected:** LWW; chat-as-branch; mutate original revision; parallel product.

## Open questions (Plan defaults — escalate only if rejected)

1. DDL none / checkpoint stack.  
2. Rewrite bumps content_version + library revision together.  
3. `why` = assist-only (no revision).  
4. Skip writes no observation.  
5. `path_version` on skip/branch/return.  
6. M1 rewrite = server structured clone+note; LLM via later job OK.  
7. Success includes refreshed clientInit.  
8. commandLog ring 32; branchStack 16.

## Gate compliance

| Gate item | This slice |
|---|---|
| Diff scope listed | Yes (docs only) |
| Commands / reads listed | Yes |
| Results / tip | Yes — tip match |
| Planned Implement tests | T1–T18 all **`not_run`** |
| Self-ACCEPT / verified | **No** — await Plan ACCEPT |
| Push / hermes | **Not done** |

## Next

Await **Plan ACCEPT** from Integrator / designated Reviewer before any Implement / ALTER / product code.
