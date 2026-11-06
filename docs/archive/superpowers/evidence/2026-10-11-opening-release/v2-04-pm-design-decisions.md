# V2-04 PM design decisions (pre-implement)

**Date:** 2026-10-11 (Asia/Shanghai)  
**Agent:** Projects Manager  
**Baseline tip:** `1a4cf465c86da7f08b6fda3044f9b0f932b80824`  
**Source draft:** `docs/superpowers/plans/ai-led-learning-v2/v2-04-migration-work-order-draft.md`  
**Draft ACCEPT:** `…/v2-04-migration-work-order-draft-accept.md`

## Status

These decisions lock the **design answers** in draft §10 items 3–7.  
They are **not** authorization to ALTER, migrate, land product code, commit, push, or open the V2-04 implement slice.

**Implement gate remains:** M0 green (V2-01 CI ACCEPT + V2-02 already combined ACCEPT) **and** a separate explicit PM open of the implement slice.

## Decisions

| # | Question | PM decision |
|---|---|---|
| 1 | Revision-key | **Option A** remains (`opening_learning_activity_history_revisions`); course counter untouched. |
| 2 | Existing-row `activity_id` backfill (§3.3) | **A1 content + A2 sequencing:** for each distinct `(workspace, owner, course)` learning footprint, create one user-owned synthetic `opening_teaching_activities` row (`intent_kind='course_continue'`, `course_id` set, status derived, not hidden); DDL adds **nullable** `activity_id` first → backfill → then `SET NOT NULL`. Forbidden: ghost/sentinel/system courses; irreversible polish of correct/independent/migrated/transfer. |
| 3 | Retest-without-course | **Defer for M1:** only course-associated activities generate task-type retests; no-course keeps observation layer. **No** same-wave nullable FK on `opening_retest_activities`. |
| 4 | Backup batch | Same approved migration batch must register new activity tables **and** fold in **`opening_skill_evidence`**. **Skip** `opening_learning_eligibility` (rebuildable) unless restore tests later require it. `opening_course_knowledge` stays out of this wave. |
| 5 | Product entry (Paula embed / ADR D7) | **Confirmed:** entry stays Today「继续学习 / 开始学习」+ activity stream (e.g. `today-resume-view.tsx`). **No** standalone teaching app shell / parallel landing. |
| 6 | Migration number | Integrator assigns against live `schema_migrations` when implement opens. Tip migrations end at **0052**; expected next candidate **0053** (+ split only if Integrator finds collision). Placeholder `00xx` until then. |

## Explicit non-actions

- Do **not** run migrate / `psql` ALTER / create product files yet.  
- Do **not** treat this note as implement open.  
- V2-01 CI ACCEPT still required for M0.
