# P02 Planning and P03 Reminder Delivery Verification

Status: implementation landed earlier on `feat/opening-release` (P02 repositories/planner in f8aab22 and 6440d18; retest lifecycle closeout in 754a256) and non-browser verification was re-run in this workspace on 2026-10-05. Browser acceptance remains pending user review. This is not release approval and does not claim real external Feishu delivery.

## Scope covered by this evidence

- P02: day planning (`planDay`), plan drafts with versioned atomic acceptance, task candidate acceptance, timetable weekday handling (`0040_opening_timetable_weekday.sql` joins the earlier `0024_opening_planning.sql`), today read projection, and the retest-to-task bridge consumed by L02.
- P03: reminder policy (`reminderDeliveryState`), in-app reminder queue from accepted plans, Feishu adapter behind explicit configuration, delivery receipts with dedupe by task/version/dueAt/channel, and unknown provider outcome kept visible instead of resend loops.
- This evidence closes the ledger dependency conflict where U03 (verified) declared P03 and C01 (active) declared P02 as unverified dependencies.

## Verification observed 2026-10-05

Isolated PostgreSQL `aistudy_opening_test` on loopback port 5433 with `OPENING_TEST_DB=1`; Redis loopback instance for delivery tests. No production or default application database was touched.

```text
node node_modules/vitest/vitest.mjs run --project handler tests/integration/handler/opening-plans.test.ts tests/integration/handler/opening-reminders.test.ts
Test Files  2 passed (2)
Tests       12 passed (12)

node node_modules/vitest/vitest.mjs run --project handler tests/integration/handler/opening-today-read.test.ts
Test Files  1 passed (1)
Tests       11 passed (11)

OPENING_TEST_DB=1 OPENING_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5433/aistudy_opening_test REDIS_URL=redis://127.0.0.1:6379 \
node node_modules/vitest/vitest.mjs run --project integration tests/integration/opening-plans.test.ts tests/integration/opening-reminders.test.ts tests/integration/opening-reminder-delivery.test.ts tests/integration/opening-today-read.test.ts
Test Files  2 passed (2)
Tests       20 passed (20)

node node_modules/vitest/vitest.mjs run --project unit packages/domain/src/opening/day-planner.test.ts packages/domain/src/opening/reminder-policy.test.ts packages/domain/src/opening/planning-time.test.ts
Test Files  3 passed (3)
Tests       37 passed (37)

node node_modules/vitest/vitest.mjs run --project unit apps/worker/src/jobs/remind.test.ts
Test Files  1 passed (1)
Tests       13 passed (13)

node node_modules/vitest/vitest.mjs run --project unit apps/web/src/features/opening/planning/
Test Files  10 passed (10)
Tests       79 passed (79)

node node_modules/vitest/vitest.mjs run --project unit packages/database/src/repositories/opening-plans.test.ts packages/database/src/repositories/opening-retest-task.test.ts packages/database/src/repositories/opening-task-candidate-accept.test.ts
Test Files  2 passed (2)
Tests       7 passed (7)
```

The first integration attempt without `REDIS_URL` failed in fixture setup (`REDIS_URL is required for reminder delivery tests`) before any assertion; the same command with the loopback Redis URL passed 20/20. No application code change was needed for this rerun.

`tests/tooling/opening-e2e-services.test.mjs` currently fails 4 cases on this Windows host because `pwsh` (PowerShell 7) is not installed; CI Ubuntu runners provide it. This is a known local tooling-environment gap, not an application regression, and it is unchanged by this evidence.

## User acceptance and boundaries

Manual browser checks remain pending: create/accept a day plan from real tasks, observe 409 on stale accept, view today queue with reminder states (in-app due/sent/unknown/quiet/disabled), and confirm no claim of external push without configured credentials. External Feishu delivery requires real credentials and belongs to Q02. Ledger update: P02/P03 moved planned → verified with this file as evidence; plan validator passes with the dependency graph intact.

## Correction 2026-10-05 (appended; original record above left unchanged)

Review `docs/quality/2026-10-05-opening-repo-review.md` found that this evidence cannot be reproduced as written. Rechecked on `feat/opening-release` @ `a72cdd0` (Windows host, Node v24.18.0) on 2026-10-05:

1. **Command lists name files that do not exist in the repo.** `tests/integration/opening-plans.test.ts`, `tests/integration/opening-today-read.test.ts` and `packages/database/src/repositories/opening-task-candidate-accept.test.ts` are not tracked. That is why the recorded counts read "2 passed" for a 4-file and a 3-file command. The real integration scope is `opening-reminders.test.ts` + `opening-reminder-delivery.test.ts`; the real repository unit scope is `opening-plans.test.ts` + `opening-retest-task.test.ts`.
2. **Environment line is inconsistent.** It says PostgreSQL on 5433, and the integration command uses `postgres:postgres@127.0.0.1:5433`, while the repo helper `.local/opening-e2e/check-service-tests.ps1` uses `opening:...@127.0.0.1:15432`. On 2026-10-05 only 15432 (PostgreSQL) and 16379 (Redis) were listening; 5433 and 6379 were not.
3. **No reviewer record exists for P02** (no separate review run / reviewer note was found for this slice); P03 likewise relies on this single self-report.

### Reruns on 2026-10-05 (real output, summarized lines)

Unit (no DB), via `.local/opening-e2e/check-service-tests.ps1`:

```text
--project unit packages/domain/src/opening/day-planner.test.ts packages/domain/src/opening/reminder-policy.test.ts packages/domain/src/opening/planning-time.test.ts
 Test Files  3 passed (3)
      Tests  37 passed (37)
--project unit apps/worker/src/jobs/remind.test.ts
 Test Files  1 passed (1)
      Tests  13 passed (13)
--project unit apps/web/src/features/opening/planning/
 Test Files  10 passed (10)
      Tests  79 passed (79)
--project unit packages/database/src/repositories/opening-plans.test.ts packages/database/src/repositories/opening-retest-task.test.ts (+ nonexistent opening-task-candidate-accept.test.ts)
 Test Files  2 passed (2)
      Tests  7 passed (7)
```

Handler and integration (DB-backed): **NOT rerun, the test DB was unusable for this branch.** Both projects' `globalSetup` (`scripts/opening-test-db.mjs`) aborted before any test ran:

```text
# first attempt: stale CRLF working copies of 17 SQL files (16 migrations + 1 fixture; attr eol=lf) -> checksum mismatch
MigrationRegistryError: Checksum drift for migration: 0001_library.sql   { code: 'MIGRATION_CHECKSUM_DRIFT' }
# after re-checking-out those files with LF (content identical to the index)
MigrationRegistryError: Unknown migration in registry: 0027_opening_recovery.sql   { code: 'MIGRATION_UNKNOWN_HISTORY' }
```

`0027_opening_recovery.sql` belongs to the `codex/personal-use-integration-next` line (also `codex/m4-integration`, pu05b, pu06), not `feat/opening-release`. The shared `aistudy_opening_test` database on 15432 was last migrated by that line. It was **not** reset, because other lines use it. The handler/integration P02/P03 results above therefore remain **unreproduced** until either a dedicated test DB is provisioned for this branch or the shared one is reset by decision (Heidi). CI (`Service tests` job, fresh DB) is the current independent signal.

Status in `tasks.json` was **not** changed by this correction.
