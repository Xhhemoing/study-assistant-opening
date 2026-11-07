# V2-04 accept — Teaching Activity Context (implement)

**Date:** 2026-10-11 (Asia/Shanghai / CST)  
**Agent:** Integrator ACCEPT (executor / AIstudy Integrator)  
**Baseline tip HEAD:** `aa3f81ba26b244f13a6f10979a69c2912ed7345d` (`feat/opening-release`)  
**Migration under review:** `packages/database/src/migrations/0053_opening_teaching_activities.sql`  
**Implement evidence:** `docs/superpowers/evidence/2026-10-11-opening-release/v2-04-teaching-activity-implement.md`  
**Verdict:** **ACCEPT**

## Scope of this accept

Product/schema **implement** accept of V2-04 teaching-activity context against the locked work order + PM design decisions + ADR. Integrator verified claims independently (implementer ≠ accepter). **No** migrate apply / `psql` ALTER on live DB. **No** commit / push / stash / reset. Tip remained `aa3f81b`.

## Authority compared

| Artifact | Role |
|---|---|
| `docs/superpowers/plans/ai-led-learning-v2/v2-04-migration-work-order-draft.md` | Work-order DDL / ALTER / auth / backup / §8 |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-04-pm-design-decisions.md` | Locked A1+A2, option A, retest defer, backup+skill_evidence, Today entry, migr 0053 |
| `docs/decisions/ADR-teaching-activity-context.md` | D1–D8 / D3.1 A |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-04-migration-number-assigned.md` | Assigned **0053** |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-04-teaching-activity-implement.md` | Claimed inventory + tests |
| Working tree vs tip `aa3f81b` | SQL + schema/repo/contracts/backup/service diffs (uncommitted) |

## PM hard-check matrix (stronger review)

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | **0053 DDL correct + complete** | **PASS** | Only `0053_opening_teaching_activities.sql` (no second 0053). Tip migrations previously ended at `0052`. CREATE `opening_teaching_activities` matches work-order §2.1 (nullable `course_id` FK `ON DELETE SET NULL`, status/generate_status/intent_kind CHECKs, UNIQUE `(workspace, owner, client_key)`, owner+course indexes). ALTER set limited to sessions/observations/attempts/item_versions: add `activity_id`, SET NOT NULL + FKs, `course_id DROP NOT NULL`, `(workspace_id, activity_id)` indexes. **No** ALTER of `opening_learning_history_revisions` PK, `opening_retest_activities`, `opening_skill_evidence.course_id`, or `opening_course_knowledge`. Unauthorized ALTER outside the migration file: **none** (schema/repo diffs mirror 0053 only). |
| 2 | **A1+A2 backfill** | **PASS** (with noted soft gaps) | **A2 order correct:** `ADD COLUMN activity_id NULL` → A1 INSERT → UPDATE four tables → `SET NOT NULL` → FKs → `course_id DROP NOT NULL`. **A1 content:** distinct `(workspace_id, owner_user_id, course_id)` from sessions∪observations → user-owned synthetic rows `intent_kind='course_continue'`, `course_id` set, `client_key='legacy-course-continue:'||course_id`, **not** hidden, **no** ghost/sentinel/`INSERT INTO courses`. Soft gaps below. |
| 3 | **Revision option A** | **PASS** | CREATE `opening_learning_activity_history_revisions` PK `(workspace_id, owner_user_id, activity_id)`; course counter table untouched. Helpers `lockLearningActivityHistory` / `nextLearningActivityHistoryRevision` in `opening-learning-facts.ts`; v1 `lockLearningHistory` / `nextLearningHistoryRevision` unchanged. |
| 4 | **Backup + skill_evidence** | **PASS** | `OPENING_BACKUP_TABLES` (29): includes `opening_teaching_activities`, `opening_learning_activity_history_revisions`, `opening_skill_evidence`; **skips** `opening_learning_eligibility`; **excludes** `opening_course_knowledge`. Mirrored in domain `TABLE_ALLOWLIST` / `BACKUP_TABLES` / `OPENING_RESTORE_APPLY_ORDER` (activities before sessions; skill_evidence after observations). Backup SELECTs / restore columns carry `activity_id`. |
| 5 | **v1 `courseId` required (dual-path / Today)** | **PASS** (Data scope) | v1 `observationInputSchema.courseId` + `learningSessionCreateInputSchema.courseId` still **required** (`learning.ts` L100/L201); `retestCandidateSchema.courseId` required (L182). Asserted by `teaching-activity.test.ts`. v2 `teaching-activity.ts`: `courseId` optional/nullable. Dual-path auth: no-course `lockLearningSession` uses activity ownership (no `courses.archived_at` JOIN); course sessions keep course archive check. Thin `activity-service.ts` present; **Today UI wiring deferred to Experience** (see gaps). |
| 6 | **No ghost courses** | **PASS** | Migration and repos create **activities** pointing at real footprint/`input.courseId` courses only. No sentinel UUID, no default/system course row, no `INSERT INTO courses`. Aligns ADR D1/G3 and PM forbid list. |

## Additional concrete findings

### Retest / deferred

- `opening_retest_activities.course_id` remains `.notNull()` in schema; **no** retest file diffs vs tip; 0053 header explicitly excludes retest nullable FK — matches PM decision #3 (defer course-less retest).

### Dual-path auth (detail)

- `assertOwnedActivity` / create without course / associate-unassociate only touch `opening_teaching_activities` (unit test locks observation non-mutation).
- v1 `createSession` still requires live course and ensures `legacy-course-continue` activity + writes `activity_id`.
- Observation/attempt writers copy `activity_id` from session.
- **Gap (non-blocking for this accept):** when `session.course_id` is set and the course is archived, `lockLearningSession` still fails the course JOIN. Work-order auth table emphasizes no-course I/O; §8 #3 parenthetical “still-associated” is not fully met. Track for Data follow-up.

### A1 soft gaps (non-blocking; fix-before-apply recommended)

1. **Status hardcoded `'active'`** — PM text said “status derived”; implement uses constant `'active'` (still user-owned / not hidden). Soft deviation.
2. **Footprint UNION** is sessions∪observations only. Attempts FK→sessions so covered in normal data; `opening_learning_item_versions` has no session FK and could orphan after session deletes → theoretical `SET NOT NULL` migrate abort. **Recommend** Data widen footprint to UNION attempts + item_versions before live apply. Empty/normal DBs migrate cleanly; failure mode is abort, not silent corruption.

### Today entry

- PM decision #5 confirms Today「继续学习 / 开始学习」+ activity stream; `today-resume-view.tsx` still links assistant conversation, **not** yet `activity-service`. Implement evidence correctly scopes Today wiring to Experience. **Not a Data REJECT** for this slice; gap for Experience/PM.

### Mapper / thin v2 observation path

- `mapLearningObservation` still `courseId: String(row.course_id)` (null → `"null"` string) while DB column is now nullable. Acceptable while v1 observation input remains course-required; full null-course observation read/write adapters remain thin (implement follow-up #3). Not a design-lock break for this accept.

## Tests re-run by Integrator (not fabricated)

```text
vitest run (8 files): 92 passed
  teaching-activity.test.ts, opening-teaching-activities.test.ts, opening-learning.test.ts,
  opening-backup-records.test.ts, opening-backup-apply.test.ts,
  backup-apply-plan.test.ts, backup-compose.test.ts, backup-learning-state.test.ts

vitest run (4 files): 27 passed
  opening-backup-entrypoint.test.ts, opening-backup-compose.test.ts,
  opening-backup-empty-namespace.test.ts, opening-action-digest-decisions.test.ts

tsc -p packages/contracts|domain|database --noEmit  → pass
npm run typecheck -w @aistudy/web  → pass
```

Claimed **92+27** and typechecks **confirmed**. Live DB migrate + full no-course observation E2E **not** run (correct: do not apply 0053 here).

## Hard-rules compliance

| Rule | Result |
|---|---|
| Tip stays `aa3f81b` | Yes |
| No commit / push / stash / reset | Yes |
| No live migrate / psql ALTER | Yes (file review only) |
| No Self-Accept by implementer | Integrator accept written separately |
| `tasks.json` untouched | Yes (no status edit in tree for this accept) |

## Gaps for PM / Data / Experience

1. **Data (before apply):** widen A1 footprint UNION to include `opening_learning_attempts` + `opening_learning_item_versions`; optionally derive synthetic activity `status` instead of always `'active'`.
2. **Data:** decide whether archived-course + still-associated activity I/O should bypass course JOIN in `lockLearningSession` (§8 #3); add regression test.
3. **Data:** null-safe observation mapper + dedicated v2 null-course observation/attempt adapters when Experience enables entry.
4. **Experience:** wire Today「继续学习 / 开始学习」to `activity-service` / activity stream; feature flag for rollback.
5. **CI / staging:** apply 0053 on non-empty learning footprints; restore smoke with the three new backup tables populated.

## Verdict rationale

Locked PM decisions (option A, A1+A2 sequencing, nullable `course_id`, backup batch including `opening_skill_evidence`, retest deferred, migr **0053**, no ghost courses, v1 `courseId` required retained) are present and verified. Claimed unit/typecheck results reproduce. Soft gaps are documented for follow-up and do **not** overturn the design locks for this implement accept.

**ACCEPT** — ready for PM/CI migrate gate; do not treat this note as authorization to push.
