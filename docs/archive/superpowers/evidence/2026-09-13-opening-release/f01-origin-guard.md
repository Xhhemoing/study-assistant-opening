# F01 same-origin fixture bypass — scoped implementation record

Date: 2026-09-14. Status: scoped policy/middleware regression checks passed; Web typecheck and full F01 acceptance remain blocked. No change to task dependencies or verified states.

## Scope and plan

1. Extend `apps/web/src/features/opening/access-policy.test.ts`; add `apps/web/src/features/opening/access-middleware.test.ts` testing the actual Next middleware with production environment settings.
2. Observe rejection tests fail for `Origin: http://opening-fixture.test` against a different configured application origin.
3. Remove the unconditional cross-origin fixture exemption in `apps/web/src/features/opening/access-policy.ts`; fixtures work only when their origin matches the configured application origin.
4. Update `tests/integration/handler/opening-access.test.ts` expectations/request URL accordingly, without bypassing its isolated DB gate.
5. Re-run unit tests, targeted lint, Web typecheck and plan structure checks; document unrelated pre-existing blockers rather than changing ongoing T03/L01 work.

## Reproduced cause

With NODE_ENV=production, `isAllowedCookieAuthOrigin(OPENING_TEST_FIXTURE_ORIGIN, 'https://study.example')` returns true.
`assertAllowedCookieAuthOrigin` returns early for the fixture constant before comparing the configured origin. Production middleware calls this same function with no test-only boundary.
This proves a cross-origin policy exemption, not an observed cookie theft or full exploit; browser cookie policy is a separate layer.

## Boundaries

- Keep exported fixture constant for tests; no new environment variable, flag or hidden bypass.
- Same-origin fixture requests remain valid by using a matching request URL / PUBLIC_BASE_URL.
- No database, credentials, production service, provider or migration operation.
- F01 still requires real protected access/owner checks; F03/T02/I03/T03 prerequisites remain unchanged.

## Results — failure → cause → fix → recheck

1. RED: `node node_modules/vitest/vitest.mjs run --project unit apps/web/src/features/opening/access-policy.test.ts apps/web/src/features/opening/access-middleware.test.ts` → **5 failed / 9 passed**. Production middleware returned200 instead of403 for POST/PUT/PATCH/DELETE from the foreign fixture origin; policy returnedtrue instead offalse.
2. Cause: unconditional early return for `OPENING_TEST_FIXTURE_ORIGIN` bypassed the configured application origin. It was active in the real middleware, not just a test helper.
3. Fix: remove that early return. Keep normal origin equality, and use matching request/configuration origins in fixtures; missing/foreign origins remain denied. Handler test expectations updated without disabling its globalSetup guard.
4. GREEN, identical command: **2 files / 14 tests passed**. Same-origin production and explicitly configured same-origin fixtures still continue; unsafe foreign fixture requests return403 with no middleware-next header.
5. Targeted ESLint for access-policy, its unit test, the new middleware test, and the handler test: no diagnostics, exit0.

## Web typecheck failure — pre-existing blocker, not hidden

Command: `npm run typecheck -w @aistudy/web`.
Output: `src/features/opening/runtime.ts(44,1): error TS1128: Declaration or statement expected.`; exit2. Host runner also reports `flock unavailable; running without cross-process locking`.
The untracked runtime file already contained a standalone extra `}` after `getTutorService` during the initial read, before this fix. This parse error is outside the changed policy/test files and blocks broader type analysis.
No T03 runtime code was changed in this slice; no recheck is claimed after an unfixed cause. The runtime owner must correct its syntax and rerun the same Web typecheck, then investigate any additional diagnostics it reveals.

## Remaining gates

- Guarded handler suite not run: isolated `OPENING_TEST_DATABASE_URL` / `OPENING_TEST_DB` are still absent. Unit tests exercise actual Next middleware but do not replace authenticated browser/DB/owner acceptance.
- No build, real browser, database setup, migrations, paid model calls, deployment or Git commit.
- F01 is not verified; T03 still waits for the original T02/I03 dependency chain. The previous DB-override fix and this origin fix are bounded prerequisites, not a claim that upstream infrastructure is finished.
- Acceptance: run the exact unit/lint commands above and review the narrow diff; resolve the existing runtime syntax blocker and supply the isolated DB before full F01 gates. No data rollback is involved.
