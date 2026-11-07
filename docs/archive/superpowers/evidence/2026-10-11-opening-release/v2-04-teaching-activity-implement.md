# V2-04 Teaching Activity Context — Implement Evidence

**Date:** 2026-10-11 (Asia/Shanghai)  
**Agent:** Data / executor (Grok Bot)  
**Branch tip HEAD:** `aa3f81ba26b244f13a6f10979a69c2912ed7345d` (`feat/opening-release`)  
**Migration:** `packages/database/src/migrations/0053_opening_teaching_activities.sql`  
**Status:** Implement complete on tip — **no push / no commit / no Accept** (Integrator Accept next)

## Authority followed

- `docs/superpowers/plans/ai-led-learning-v2/v2-04-migration-work-order-draft.md` (设计拍齐)
- `docs/superpowers/evidence/2026-10-11-opening-release/v2-04-pm-design-decisions.md`
- `docs/decisions/ADR-teaching-activity-context.md`
- Integrator assigned migration number **0053** (no collision; tip migrations ended at 0052)

## Files touched

### New
- `packages/database/src/migrations/0053_opening_teaching_activities.sql`
- `packages/contracts/src/opening/teaching-activity.ts`
- `packages/contracts/src/opening/teaching-activity.test.ts`
- `packages/database/src/schema/opening-teaching-activities.ts`
- `packages/database/src/repositories/opening-teaching-activities.ts`
- `packages/database/src/repositories/opening-teaching-activities.test.ts`
- `apps/web/src/features/opening/teaching/activity-service.ts`

### Updated (product / backup / dual-path)
- `packages/contracts/src/opening/index.ts` — export teaching-activity
- `packages/database/src/index.ts` — export schema + teaching activities repo
- `packages/database/src/repositories/opening-learning-facts.ts` — `lockLearningSession` no-course branch; `lockLearningActivityHistory` / `nextLearningActivityHistoryRevision`
- `packages/database/src/repositories/opening-learning.ts` — v1 `createSession` ensures `course_continue` activity + writes `activity_id`
- `packages/database/src/repositories/opening-learning-observations.ts` — INSERT sets `activity_id` from session
- `packages/database/src/repositories/opening-learning-attempts.ts` — attempt + item_version INSERT set `activity_id`
- `packages/database/src/schema/opening-learning.ts` / `opening-learning-attempts.ts` — nullable `courseId` + `activityId`
- `packages/database/src/repositories/opening-backup-records.ts` — `OPENING_BACKUP_TABLES` (+ teaching activities, activity history revisions, skill_evidence; skip eligibility)
- `packages/database/src/repositories/opening-backup-record-table-queries.ts` — read new tables; SELECTs include `activity_id`
- `packages/database/src/repositories/opening-backup-apply.ts` — `OPENING_RESTORE_ROW_COLUMNS`
- `packages/database/src/repositories/opening-backup-empty-namespace.ts` — namespace counts
- `packages/domain/src/opening/backup-apply-plan.ts` — `OPENING_RESTORE_APPLY_ORDER` (29 tables; activities before sessions; skill_evidence after observations)
- `packages/domain/src/opening/backup-policy.ts` — `TABLE_ALLOWLIST`
- `packages/domain/src/opening/backup-compose-validation.ts` — `BACKUP_TABLES`
- Backup-related unit test fixtures updated for 29-table inventory

### Explicitly not done
- No `tasks.json` status → verified
- No push / commit / stash / reset
- No Self-Accept
- No Experience Today UI beyond thin `activity-service`
- No retest / skill_evidence / `opening_course_knowledge` `course_id` NOT NULL changes
- No change to `opening_learning_history_revisions` PK
- v1 `learning.ts` `courseId` remains **required**

## Migration summary (`0053`)

1. CREATE `opening_teaching_activities` (work-order §2.1 sketch)
2. CREATE `opening_learning_activity_history_revisions` (option A)
3. A2: ADD nullable `activity_id` on sessions / observations / attempts / item_versions
4. A1 backfill: distinct `(workspace_id, owner_user_id, course_id)` footprints → user-owned `course_continue` activities (`client_key = 'legacy-course-continue:' || course_id`)
5. UPDATE four tables’ `activity_id` from synthetic activities
6. `ALTER COLUMN activity_id SET NOT NULL` + FKs → activities
7. `ALTER COLUMN course_id DROP NOT NULL` on the four tables
8. Indexes `(workspace_id, activity_id)`
9. Rollback notes as SQL comments (no DROP of user data in product rollback)

## Test commands + results

```text
PATH="./node_modules/.bin:$PATH" bash scripts/run-heavy.sh vitest run \
  packages/contracts/src/opening/teaching-activity.test.ts \
  packages/database/src/repositories/opening-teaching-activities.test.ts \
  packages/database/src/repositories/opening-learning.test.ts \
  packages/database/src/repositories/opening-backup-records.test.ts \
  packages/database/src/repositories/opening-backup-apply.test.ts \
  packages/domain/src/opening/backup-apply-plan.test.ts \
  packages/domain/src/opening/backup-compose.test.ts \
  packages/domain/src/opening/backup-learning-state.test.ts
# → 8 files, 92 tests passed

PATH="./node_modules/.bin:$PATH" bash scripts/run-heavy.sh vitest run \
  packages/database/src/repositories/opening-backup-entrypoint.test.ts \
  packages/database/src/repositories/opening-backup-compose.test.ts \
  packages/database/src/repositories/opening-backup-empty-namespace.test.ts \
  packages/database/src/repositories/opening-action-digest-decisions.test.ts
# → 4 files, 27 tests passed

tsc -p packages/contracts|domain|database --noEmit  # pass
npm run typecheck -w @aistudy/web  # pass
```

### Coverage vs work-order §8 / ADR D5 (unit)

| Scenario | Covered |
|---|---|
| Create activity without course | yes |
| Cross-owner reject | yes |
| clientKey same intent replay | yes |
| clientKey different intent CONFLICT | yes |
| Associate/unassociate does not rewrite `observation.course_id` | yes (mutations only touch activity row) |
| v1 required `courseId` schemas still require courseId | yes (`teaching-activity.test.ts`) |
| Backup list includes new tables + skill_evidence; skips eligibility | yes |
| Option A activity history revision advances | yes |
| No-course session lock via activity ownership (no courses archive JOIN) | yes |

Not run here: live DB migrate + full integration observation-without-course E2E (Integrator / CI migrate gate).

## Hard rules compliance

- Tip stayed on `aa3f81ba26b244f13a6f10979a69c2912ed7345d`
- **No** stash / reset / push / commit
- **No** Self-Accept — ready for Integrator Accept after review
- `tasks.json` status untouched

## Open follow-ups (Integrator / Experience)

1. Apply migrate on CI / staging; confirm backfill against non-empty learning footprints
2. Experience: Today「继续学习 / 开始学习」entry wiring to `activity-service` (out of this Data slice)
3. Full v2 observation/attempt adapters for null-course writes (helpers + `activity_id` writers landed; dedicated v2 observation input/API still thin)
4. Feature flag for new entry (rollback = flag off + retain data)
5. Optional: restore apply integration smoke with the three new tables populated

## Ready for Integrator Accept

Yes — implement evidence recorded; tip clean of push/commit; migration number 0053 with no collision.
