# Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans; execute task-by-task with red/green evidence.

**Goal:** Freeze safe shared contracts and a real single-owner data foundation.
**Architecture:** Existing authentication remains authoritative; opening services are small modules beside the legacy services, not additions to the 1000-line auth service.
**Tech Stack:** TypeScript, Zod, Drizzle/PostgreSQL, Vitest.

## Global Constraints

Read the master plan and `interfaces.md`. Shared export files and migrations have one writer. No production credentials. New source files ≤200 lines.

### F01: Test DB guard, private registration and owner setup

**Owner:** INTEGRATOR. **Depends:** B02.
**Create:** `apps/web/src/middleware.ts`, `packages/config/src/test-database.ts`, `packages/config/src/test-database.test.ts`, `apps/web/src/features/opening/access-policy.ts`, `apps/web/src/features/opening/access-policy.test.ts`, `scripts/opening-create-owner.ts`, `scripts/opening-test-db.mjs`.
**Modify:** `packages/config/src/index.ts`, `apps/web/src/app/api/auth/register/route.ts`, `apps/web/src/app/register/page.tsx`, `vitest.config.ts`, `.github/workflows/ci.yml`, `tests/contract/ci-workflow.test.ts`.
**Tests:** the two unit files; `tests/integration/handler/opening-access.test.ts`.
**Interfaces:** `assertOpeningTestDatabase(url:string, enabled:string|undefined): URL`; `allowRegistration({openingRelease:boolean}): boolean`. Owner CLI reads password from protected stdin, never argv or logs, and refuses creation if owner exists.

- [ ] Add failing tests, including:
```ts
import { expect, it } from 'vitest';
import { assertOpeningTestDatabase } from './test-database';
it('refuses destructive tests without explicit isolated database', () => {
  expect(() => assertOpeningTestDatabase('postgres://u:p@localhost/aistudy', '1')).toThrow();
  expect(() => assertOpeningTestDatabase('postgres://u:p@example.org/aistudy_opening_test', '1')).toThrow();
  expect(() => assertOpeningTestDatabase('postgres://u:p@localhost/aistudy_opening_test', undefined)).toThrow();
});
```
- [ ] Run `node node_modules/vitest/vitest.mjs run --project unit packages/config/src/test-database.test.ts apps/web/src/features/opening/access-policy.test.ts`; expect missing implementation/assertion failure.
- [ ] Implement guard: require `OPENING_TEST_DB=1`, loopback host, exact database `aistudy_opening_test`; reject otherwise before connecting. Test wrapper validates `OPENING_TEST_DATABASE_URL`, then sets child DATABASE_URL only. Add guard globalSetup to integration/handler projects before destructive existing tests run. Update the isolated branch's CI service DB name and explicit test flags/URL together, plus its workflow contract assertions; CI must never rely on the application's default DATABASE_URL.
- [ ] In opening mode registration endpoint returns 403 and public registration page redirects to login. Reuse password hashing and createUserWithWorkspace in CLI, without importing the giant auth service into client code. Add same-origin validation for unsafe cookie-auth routes; missing/foreign Origin denied except explicit test fixture origin.
- [ ] Rerun unit and guarded handler tests; test CSRF, invalid cookie, first-owner only. Commit only listed files after checks; blocked DB tests stay blocked.

### F02: Freeze opening contracts and fixture builders

**Owner:** INTEGRATOR. **Depends:** B02.
**Create:** `packages/contracts/src/opening/{foundation,sources,jobs,tutor,memory,learning,planning,index}.ts`, `packages/contracts/src/opening/contracts.test.ts`.
**Modify:** `packages/contracts/src/index.ts` (one grouped export).
**Interfaces:** all names and fields in `interfaces.md`; schema names `uploadInputSchema`, `sourceRecordSchema`, `turnInputSchema`, `memoryDecisionSchema`, `observationInputSchema`, `acceptPlanInputSchema`, `weekSessionSchema`.

- [ ] Add complete invalid/valid fixtures and failing test:
```ts
import { expect, it } from 'vitest';
import { uploadInputSchema } from './sources';
it('rejects unsupported formats and traversing names', () => {
  const base = {name:'a.pdf',mime:'application/pdf',bytes:12,sha256:'a'.repeat(64)};
  expect(uploadInputSchema.safeParse(base).success).toBe(true);
  expect(uploadInputSchema.safeParse({...base,name:'../a.pdf'}).success).toBe(false);
  expect(uploadInputSchema.safeParse({...base,mime:'text/html'}).success).toBe(false);
});
```
- [ ] Run `node node_modules/vitest/vitest.mjs run --project unit packages/contracts/src/opening/contracts.test.ts`; require a real red result.
- [ ] Implement Zod `.strict()` input schemas; UUIDs, ISO timestamps, positive bounded sizes, nonnegative integer versions, finite priority, trimmed text limits. Temporary memory requires expiresAt; startPeriod≤endPeriod; duplicate weeks deduplicated only by domain functions, never silently by input validation.
- [ ] Test unknown body fields, client-supplied owner, malformed SHA, oversized content, unverified outcomes, ephemeral mode and wrong version. Existing v1 learning-event schemas remain unchanged.
- [ ] Rerun contracts and package typecheck; publish field/signature changes into interfaces.md and commit as a single API checkpoint before downstream parallel work.

### F03: Sources/jobs/outbox/budget persistence and test fixture

**Owner:** DATA. **Depends:** F01,F02.
**Create:** `packages/database/src/schema/opening-sources.ts`, `packages/database/src/schema/opening-jobs.ts`, `packages/database/src/schema/opening-budget.ts`, `packages/database/src/migrations/0016_opening_sources_jobs.sql`, `packages/database/src/repositories/opening-sources.ts`, `packages/database/src/repositories/opening-jobs.ts`, `packages/database/src/repositories/opening-budget.ts`, `tests/integration/opening-fixture.ts`, `tests/integration/opening-foundation.test.ts`, `apps/web/src/features/opening/runtime.ts`.
**Modify:** `packages/database/src/index.ts`.
**Interfaces:** `createOpeningSourceRepository(sql)`, `createOpeningJobRepository(sql)`, `createOpeningBudgetRepository(sql)`; source methods `create(scope,input)`, `get(scope,id)`, `list(scope)`; jobs `createOnce(scope,{key,kind,payload,privacyEpoch})`, `get(scope,id)`. Runtime composes auth and opening repositories, not a second identity store.

- [ ] Implement protected fixture API from interfaces.md, then a failing repository test:
```ts
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createOpeningSourceRepository } from '@aistudy/database';
import { createOpeningFixture, type OpeningFixture } from './opening-fixture';
let f: OpeningFixture;
beforeAll(async () => { f = await createOpeningFixture(); });
afterAll(async () => { await f?.close(); });
it('never reads another workspace source', async () => {
  const repo = createOpeningSourceRepository(f.sql);
  const record = await repo.create(f.scope, {name:'a.pdf',mime:'application/pdf',bytes:12,sha256:'a'.repeat(64)});
  await expect(repo.get(f.otherScope, record.id)).rejects.toMatchObject({code:'NOT_FOUND'});
});
```
- [ ] Run guarded `npm run test:integration -- --run tests/integration/opening-foundation.test.ts`; initially expect missing migration/repository. The fixture may initialize identity and SQL without storage or tutor services; no downstream HTTP route is required for this task.
- [ ] Migration creates source metadata, job payload/results, outbox and budget reservations; unique `(workspace_id,key)`; FK ownership joins; job payload stores source IDs, never API keys or signed URLs. Source create + parse-job outbox insertion occur in one transaction.
- [ ] Repository test must prove duplicate same key same payload returns original; same key different payload ->409; concurrent budget reservation cannot overspend; unknown external outcome retains reservation; persisted source state differs from parse state.
- [ ] Rerun migration order + foundation tests + typecheck. DATA records rollback: disable writers, export newly created tables, drop only unreferenced new tables in test rollback drill; production rollback remains separate approval. Commit 0016 before later migration tasks.
