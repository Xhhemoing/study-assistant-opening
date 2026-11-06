# V2-08 Teaching plan/compiler — Plan-stage evidence (Understand + Plan only)

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy AI (executor / Grok Bot)  
**Branch:** `feat/opening-release`  
**Tip HEAD:** `ae974983ce791894c2aa6d9459b06198d3152191` (`ae97498`) — **matches required tip** (includes V2-07 ACCEPT)  
**Stage:** Understand → Plan only. **No product Implement. No migrations/ALTER. No push / hermes / stash / reset / commit.**  
**Gates:** `docs/superpowers/plans/opening-release/review-test-gates.md` (list what was read / run; do **not** self-ACCEPT)

## Diff scope (this slice)

### Written (docs only)

| Path | Role |
|---|---|
| `docs/superpowers/plans/ai-led-learning-v2/v2-08-teaching-plan-understand.md` | Understand |
| `docs/superpowers/plans/ai-led-learning-v2/v2-08-teaching-plan-plan.md` | Plan (await ACCEPT) |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-08-teaching-plan-plan-implement.md` | This plan-stage evidence |

### Explicitly not touched

- No `packages/domain/src/opening/teaching-plan.ts`
- No `packages/ai/src/opening/teaching-compiler.ts`
- No edits to `tutor-policy.ts`, `compile-teaching-unit.ts`, `index.ts`, `teaching-evidence.ts`, `teaching-coverage.ts`, `day-planner.ts`
- No migration SQL under `packages/database/src/migrations/`
- No ALTER / migrate / psql
- No `tasks.json` status → verified / in_progress / planned changes
- No push / hermes / stash / reset / commit
- Unrelated untracked evidence files present in tree were **not** created or modified by this slice:
  - `docs/superpowers/evidence/2026-10-09-opening-release/rp5-gha-91b1c73-typecheck-fail.md`
  - `docs/superpowers/evidence/2026-10-11-opening-release/p0-assistant-list-preview-failsoft-implement.md`

## Tip / branch verification

```text
$ git rev-parse HEAD
ae974983ce791894c2aa6d9459b06198d3152191

$ git branch --show-current
feat/opening-release

$ git log -1 --oneline
ae97498 docs(opening): V2-07 teaching generation jobs ACCEPT evidence

$ ls packages/database/src/migrations/*.sql | tail -3
packages/database/src/migrations/0053_opening_teaching_activities.sql
packages/database/src/migrations/0054_opening_teaching_content.sql
packages/database/src/migrations/0055_opening_compile_teaching_unit_job.sql

$ test ! -f packages/domain/src/opening/teaching-plan.ts && test ! -f packages/ai/src/opening/teaching-compiler.ts && echo absent
absent
```

**Result:** tip OK. Migrations tip ends at **0055** (V2-07 job kind). V2-08 Plan prefers **no DDL**.

## Inventory commands / Reads

### Tip confirm

```text
$ git rev-parse HEAD
ae974983ce791894c2aa6d9459b06198d3152191

$ git status --short
?? docs/superpowers/evidence/2026-10-09-opening-release/rp5-gha-91b1c73-typecheck-fail.md
?? docs/superpowers/evidence/2026-10-11-opening-release/p0-assistant-list-preview-failsoft-implement.md
```

**Result:** exit 0 — matches required baseline `ae97498`. Dirty tree = unrelated untracked only; not touched.

### Plan §V2-08 + tasks + gates

```text
$ rg -n "V2-08｜实现提纲" docs/superpowers/plans/ai-led-learning-v2/plan.md
$ Read plan.md L485–503
$ Read tasks.json V2-08 (id V2-08, proposed_paths teaching-plan.ts / teaching-compiler.ts)
$ Read docs/superpowers/plans/opening-release/review-test-gates.md
$ Read v2-06-teaching-evidence-understand.md + plan + plan-implement evidence (style reference)
$ Read v2-07-teaching-generation-jobs-understand.md + plan (job stub context)
```

**Result:** scope/reuse/proposed paths/acceptance/rollback aligned with PM assignment; evidence format matches V2-06 plan-implement.

### V2-07 stub + wire points

```text
$ Read apps/worker/src/jobs/compile-teaching-unit.ts
$ rg -n "buildPublishInput|stub until V2-08|defaultStubPublish|createCompileTeachingUnitHandler" apps/worker/src/jobs/compile-teaching-unit.ts apps/worker/src/index.ts
$ ls apps/worker/src/jobs/compile-teaching-unit.ts apps/worker/src/jobs/compile-teaching-unit.test.ts
```

**Result:** exit 0 — `buildPublishInput?` hook present (L65–69); stub instruction L181; empty `blockOrder` stub publish L108–126; `index.ts` L118–152 wires stub provider + `ensureTeachingUnitId`; kind `compile-teaching-unit` registered.

### tutor-policy / planDay / mastery

```text
$ Read packages/domain/src/opening/tutor-policy.ts
$ rg -n "assertNoMasteryPercentage|preferCitationsForPage|recommendTutorAction" packages/domain/src/opening/tutor-policy.ts
$ rg -n "export function planDay" packages/domain/src/opening/day-planner.ts
$ head packages/domain/src/opening/day-planner.ts
```

**Result:** exit 0 — mastery ban L229–242; soft page cites; `planDay` is calendar scheduler orthogonal to teaching path.

### V2-05 / V2-06 landed surfaces

```text
$ Read packages/contracts/src/opening/teaching-content.ts (schemas)
$ Read packages/contracts/src/opening/teaching-activity.ts (pathVersion, generateStatus)
$ rg -n "export function assembleTeachingEvidencePack|classifyClaimSupport" packages/ai/src/opening/teaching-evidence.ts
$ rg -n "export function buildCoverageTable|SourceAnchor" packages/domain/src/opening/teaching-coverage.ts
$ rg -n "teaching-coverage|teaching-evidence" packages/domain/src/index.ts packages/ai/src/index.ts
```

**Result:** exit 0 — ActivitySpec / publish / goals / block roles present; evidence pack APIs exported; activity `pathVersion` exists.

### Fixtures

```text
$ head -80 tests/fixtures/opening/teaching/unit-rank-nullspace/lecture/activity-outline.json
```

**Result:** exit 0 — ordered activities with `goalIds` / `blockTypes` / `sourceIds` usable as first engineering sample.

### Additional Reads (completed; no product mutation)

| Path | Purpose |
|---|---|
| `plan.md` §V2-08; `tasks.json` V2-08 | Authority + PM wording |
| `review-test-gates.md` | Evidence rules |
| `v2-06-*` understand/plan/plan-implement | Shape mirror |
| `v2-07-*` understand/plan | Stub / job context |
| `compile-teaching-unit.ts` + `index.ts` wire | Extension points |
| `tutor-policy.ts` | Reuse entry / mastery ban |
| `day-planner.ts` | path ≠ planDay contrast |
| `teaching-content.ts` / `teaching-activity.ts` | Publish + pathVersion |
| `teaching-evidence.ts` / `teaching-coverage.ts` | Evidence attach |
| `activity-outline.json` | Fixture sample |
| migrations tip `0055_…` | No new DDL needed |

## Planned product tests (from Plan §8.2) — status

| ID | Status | Reason |
|---|---|---|
| C1–C11 (editable outline, current-only compile, path≠planDay, skippable prereq, history freeze, no page, intent variants, allowlist, held-out, worker wire, real model) | **`not_run`** | Plan stage only; modules not landed |
| `vitest` teaching-plan / teaching-compiler | **`not_run`** | No Implement |
| `vitest` teaching-evidence / coverage / tutor-policy / day-planner / compile-teaching-unit regressions | **`not_run`** | Docs-only; not re-executed this slice |
| `tsc` / typecheck | **`not_run`** | Docs-only |
| Real model smoke | **`not_run`** | No Implement / no provider run |
| Browser / E2E | **`not_run`** | N/A this slice |
| Migration apply | **`not_run`** | Plan prefers no DDL |
| push / hermes | **`not_run`** | Forbidden this slice |

## Plan summary (for Accept)

1. Domain `teaching-plan.ts` (outline/path/prereq/allowlist/history-freeze/mastery ban) + AI `teaching-compiler.ts` (propose outline → compile current + optional prefetch via V2-06 pack).  
2. Wire into V2-07 via existing `buildPublishInput` + replace stub provider — **no new job kind / no DDL**.  
3. Outline **editable before** compile; program clamps block types & sources.  
4. Teaching path **≠** `planDay`; prereqs **explainable + skippable**; **no** mastery % locks.  
5. Goal adjust revises **subsequent** only — does **not** rewrite learned history.  
6. First sample = V2-02 `activity-outline.json`.  
7. Post-model status remains **`needs_check`** (V2-09).  
8. Rollback = disable compiler flag; keep generated activities readable.  
9. AI owns compiler slice; Pipeline owns job shell; Experience owns later UI.

## Ask Integrator

**Please Plan ACCEPT** (or REJECT with gaps) before any product Implement.  
This evidence **does not** self-ACCEPT / self-verify / move `tasks.json`.

## Verdict this slice

- Understand + Plan **written**.  
- Tip still `ae97498…` at evidence time.  
- Confirm: **no Implement / no migration / no push / no hermes / no commit** performed by this agent.  
- Await Integrator **Plan ACCEPT**.
