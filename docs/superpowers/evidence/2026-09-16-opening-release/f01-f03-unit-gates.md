# F01 / F03 unit-level gate evidence — 2026-09-16

Repo: `E:/Project/study-assistant-opening`; branch `feat/opening-release`. LOCAL-ONLY.
Executed by two `xhh-verifier` subagent runs (`mu3nuwr8-f38bc95d`, `mu3nuwr8-fd8959ad`); typecheck re-run by lead. Handler/DB gates remain BLOCKED (no Docker on this host), so F01/F03 stay `blocked`, not `verified`.

## 1) F01/F02 regression gates (unit) — all green

```text
$ node node_modules/vitest/vitest.mjs run --project unit packages/contracts/src/opening/contracts.test.ts
Test Files  1 passed (1)   Tests  18 passed (18)

$ node node_modules/vitest/vitest.mjs run --project unit apps/web/src/features/opening/access-policy.test.ts apps/web/src/features/opening/access-middleware.test.ts
Test Files  2 passed (2)   Tests  14 passed (14)

$ node node_modules/vitest/vitest.mjs run --project unit apps/web/src/features/opening/tutor apps/web/src/features/opening/sources apps/web/src/features/opening/client apps/web/src/features/opening/assistant
Test Files  8 passed (8)   Tests  29 passed (29)

$ node node_modules/vitest/vitest.mjs run --project unit packages/domain/src/opening/assistance.test.ts packages/domain/src/opening/day-planner.test.ts packages/domain/src/opening/planning-time.test.ts
Test Files  3 passed (3)   Tests  35 passed (35)

$ node node_modules/vitest/vitest.mjs run --project unit packages/config/src/test-database.test.ts
Test Files  1 passed (1)   Tests  6 passed (6)
```

## 2) F03 foundation gates (unit + tooling) — all green

```text
$ node node_modules/vitest/vitest.mjs run --project unit packages/database/src/repositories/opening-sources.test.ts packages/database/src/repositories/course-membership.source.test.ts
Test Files  2 passed (2)   Tests  8 passed (8)

$ node --test tests/tooling/opening-capability-plan.test.mjs tests/tooling/opening-test-db.test.mjs
pass 14  fail 0

$ node scripts/validate-opening-plan.mjs
Plan structure: PASS (37 tasks, acyclic dependencies, plan/evidence files present)

$ node node_modules/vitest/vitest.mjs run --project unit apps/web/src/features/opening/sources/source-service.test.ts apps/web/src/features/opening/sources/upload-policy.test.ts
Test Files  2 passed (2)   Tests  5 passed (5)
```

## 3) Lead re-verification

```text
$ npm --script-shell="$(cygpath -w "$(command -v bash)")" run typecheck
TYPECHECK_EXIT=0   (domain/contracts/config/database/ai/ui/worker/web/e2e all clean)
```

## 4) Why F01/F03 remain blocked (not verified)

- Handler + integration projects need Postgres via `OPENING_TEST_DATABASE_URL` (exact loopback `aistudy_opening_test`, `OPENING_TEST_DB=1`). This host has no Docker CLI (`docker: command not found`), ports 5432/6379 closed; per `f01-access.md` §4 the F01 → verified flips only after a green handler run under that guard plus owner/registration confirmation against the isolated DB.
- 0019 header already reserves 0018 for memories/privacy (`Prerequisite migrations (reserved): … 0018 memories/privacy`); no renumbering.
- T03 partial: HTTP slice evidence `../2026-09-13-opening-release/t03-tutor-http-slice.md` now linked in `tasks.json`; full T03 still blocked on T02/I03 and missing `apps/worker/src/jobs/tutor-turn.ts`.
