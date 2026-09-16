# F01 database query override guard — scoped implementation record

Status: scoped guard fix verified on 2026-09-14; F01 not verified, T03 remains blocked. Existing dependency edges are unchanged.

## Scope and plan

1. Extend `packages/config/src/test-database.test.ts` and create `tests/tooling/opening-test-db.test.mjs`: reject `database` query overrides, encoded/duplicate forms; CLI rejection must occur before child execution; ordinary `sslmode` remains accepted.
2. Run both test files red, attributing failure to the missing query guard rather than a database connection.
3. Amend only `packages/config/src/test-database.ts` and `scripts/opening-test-db.mjs` to reject this startup parameter.
4. Re-run the identical tests; run config typecheck, existing access-policy tests, relevant lint, and plan structure checks. Record results below.

## Root-cause evidence (no DB connection)

The current guard accepts `postgres://u:p@127.0.0.1/aistudy_opening_test?database=production`.
The installed `postgres` client's `options.database` is `aistudy_opening_test`, but `options.connection.database` is `production`.
`node_modules/postgres/src/index.js:437,483–486` forwards query parameters into `connection`; `connection.js:976–986` merges that object after the checked database name in the startup message.
The TypeScript and CLI guards both omit this check. This is a guard bypass demonstrated in option construction, not a connection to a real production database.

## Dependency/environment boundary

- Current manifest: F01 active; F03/I03/T01/I02/T02 planned; T03 blocked. No dependency removal or status promotion.
- `OPENING_TEST_DB` and `OPENING_TEST_DATABASE_URL` are missing; no PostgreSQL/Docker/Podman executable found in PATH or checked standard install locations.
- Existing uncommitted T03/L01/materials/UI work is preserved, not treated as verified.
- No application .env read; no database, storage, queue, paid model or deployment operation.

## Results — failure → cause → fix → recheck

1. RED: `node node_modules/vitest/vitest.mjs run --project unit packages/config/src/test-database.test.ts` → **3 failed / 3 passed**, `expected [Function] to throw an error` for database, duplicate and percent-encoded keys.
2. RED: `node --test tests/tooling/opening-test-db.test.mjs` → **4 failed / 1 passed**. Three missing exceptions; the unsafe CLI invocation actually ran its harmless `node --version` child and exited 0 instead of rejecting with 1. No DB connection.
3. Cause: both guards checked only URL authority/path, ignoring the driver's startup parameter override described above.
4. Fix: both guards reject `URLSearchParams.has('database')` before returning a validated URL. URLSearchParams covers decoded keys and duplicates. Non-routing `sslmode=disable` remains supported. No environment variable or production schema changed.
5. GREEN, identical commands: **6/6 unit tests**, **5/5 tooling tests**. Unsafe CLI returns1, emits no child stdout and reports the guard error.

Scoped regressions:

```text
node node_modules/vitest/vitest.mjs run --project unit packages/config/src/test-database.test.ts packages/config/src/env.test.ts apps/web/src/features/opening/access-policy.test.ts
Test Files 3 passed (3)
Tests 16 passed (16)

node --test tests/tooling/opening-test-db.test.mjs tests/tooling/opening-plan.test.mjs
tests 9 / pass 9 / fail 0

npm run typecheck -w @aistudy/config
> tsc -p tsconfig.json --noEmit
(exit 0)

node node_modules/eslint/bin/eslint.js packages/config/src/test-database.ts packages/config/src/test-database.test.ts scripts/opening-test-db.mjs tests/tooling/opening-test-db.test.mjs
(no diagnostics; exit 0)

node scripts/validate-opening-plan.mjs
Plan structure: PASS (27 tasks, acyclic dependencies, plan/evidence files present)
Ready tasks: P01
```

Targeted `git diff --check` exits0, with existing Git LF→CRLF conversion warnings; no functional failure. No commit or production deployment performed.

Graph maintenance: one `graphify update . --no-cluster` attempt after the code change timed out at45s after reporting827/827 AST files. Six zero-node configuration files and19 SQL files lacking `tree_sitter_sql` were reported. Root cause of post-scan timeout remains unknown; no retry or false update-success claim.

## Remaining prerequisite work

This patch closes only one F01 guard defect. Real guarded handler/owner/CSRF evidence is still required, and existing uncommitted application work has not received a full typecheck/build here.
Provide a dedicated loopback PostgreSQL database named `aistudy_opening_test`, configuring `OPENING_TEST_DATABASE_URL` and `OPENING_TEST_DB=1` locally, not credentials in chat. Do not use or rename an existing user/production database for testing.
After the remaining F01 gates: complete F03; then I03 and the I01→I02 / T01 paths; T02 requires I02+T01; only then close T03's T02+I03 dependency gate. P02→L01 stays unchanged.
Acceptance for this patch is the commands above plus diff review; acceptance of the dependent features still requires their protected integration and real-service gates. No migration, data mutation or database rollback is involved in this guard-only patch.
