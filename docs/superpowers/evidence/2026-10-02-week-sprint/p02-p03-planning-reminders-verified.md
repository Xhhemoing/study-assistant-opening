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
