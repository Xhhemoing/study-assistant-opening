# V2-04 — Migration work-order DRAFT prep (evidence)

**Date:** 2026-10-11 (Asia/Shanghai)  
**Agent:** AIstudy Data (executor subagent)  
**Baseline tip:** `1a4cf465c86da7f08b6fda3044f9b0f932b80824`  
**Branch:** `feat/opening-release`  
**Task:** V2-04 — prepare migration/work-order **draft only** (teaching activity context)  
**Upstream:** V2-03 ADR 已批准（设计）; revision-key **option A**

## Deliverable

| Path | Action |
|---|---|
| `docs/superpowers/plans/ai-led-learning-v2/v2-04-migration-work-order-draft.md` | **Created** — full work-order draft |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-04-migration-work-order-draft.md` | **Created** — this evidence |

## What the draft contains

1. Goal/scope aligned to free-start activity; owner+workspace required; course optional; associate without moving facts  
2. DDL sketches: `opening_teaching_activities`, `opening_learning_activity_history_revisions` (option A PK)  
3. ALTER checklist: sessions / observations / attempts / item_versions → nullable `course_id` + `activity_id NOT NULL`; history course PK unchanged  
4. Auth rewrite checklist vs `assertOwnedCourse` / `lockLearningSession` JOIN courses  
5. Contracts dual path: v1 keep required courseId; v2 `teaching-activity.ts` field sketch only  
6. Backup: register new tables day one; skill_evidence/eligibility flagged as PM open Q  
7. Feature flag / rollback: close entry, keep data, no DROP, no irreversible backfill  
8. ADR D5 + V2-04 counterexample/verification cases  
9. Deferred: V2-05 body, V2-07 pipeline, retest-without-course, sentinel UUID forbidden  
10. Approval gate: M0 green + PM opens implement slice before any ALTER  
11. Integrator note: 0048 real table is `opening_course_knowledge`

## Sources read (read-only)

- `docs/decisions/ADR-teaching-activity-context.md`
- `docs/superpowers/evidence/2026-10-11-opening-release/v2-03-activity-compat-adr-implement.md`
- `docs/superpowers/evidence/2026-10-11-opening-release/v2-03-activity-compat-adr-accept.md` (0048 wording)
- `docs/superpowers/plans/ai-led-learning-v2/tasks.json` (V2-04)
- `docs/superpowers/plans/ai-led-learning-v2/plan.md` (§6.1, V2-04)
- Migrations: `0019`, `0028`, `0037`, `0038`, `0030`, `0048`, `0049`
- `opening-learning-facts.ts`, `opening-backup-records.ts`, `packages/contracts/src/opening/learning.ts`

## Commands run

```text
git rev-parse HEAD          # 1a4cf465c86da7f08b6fda3044f9b0f932b80824
git branch --show-current   # feat/opening-release
Read / rg on ADR, plan, tasks, migrations, facts, backup, contracts
Wrote draft work-order + this evidence only
```

## Explicit non-actions

- **No** `ALTER` / migrate runner / `psql` schema change  
- **No** product code (`teaching-activity.ts`, repos, services) created  
- **No** `tasks.json` status edit  
- **No** commit / push / stash / reset  
- **No** DROP or irreversible backfill  

## Open questions still needing PM (carried into work-order §6/§10)

1. Open V2-04 **implement** only after M0 (V2-01+V2-02) green  
2. Existing-row `activity_id` backfill strategy (A1 synthetic course_continue activities vs A2 phased nullable)  
3. Retest-without-course: defer task-type retests vs same-wave nullable FK  
4. Fold `opening_skill_evidence` (+ eligibility) into `OPENING_BACKUP_TABLES` in same batch?  
5. Confirm Today continue/start entry only (Paula embed)  

## Decision one-liner

**Draft ready for PM review: option A activity history table + teaching_activities meta + nullable course_id/activity_id on learning fact tables; dual API; backup day one; execute only after M0 green and explicit implement approval — nothing migrated in this slice.**
