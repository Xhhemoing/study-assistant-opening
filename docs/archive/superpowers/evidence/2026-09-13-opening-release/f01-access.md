# F01 access / test-DB evidence pack (NOT verified) — 2026-09-13

Repo: `E:/Project/study-assistant-opening`; branch `feat/opening-release`. LOCAL-ONLY (no GitHub).

**Status:** evidence collection only. Do **not** set `tasks.json` F01 → `verified` from this file alone.

Implementing commit under review: `2e52af4` (`feat(opening): F01 test DB guard, private registration, owner setup`).

## 1) Unit gates (re-run by aistudy-verify)

```text
$ node node_modules/vitest/vitest.mjs run --project unit packages/config/src/test-database.test.ts apps/web/src/features/opening/access-policy.test.ts

Test Files  2 passed (2)
     Tests  6 passed (6)
```

## 2) Commit `2e52af4` file inventory

| Status | Path |
|---|---|
| M | `.github/workflows/ci.yml` |
| M | `apps/web/src/app/api/auth/register/route.ts` |
| M | `apps/web/src/app/register/page.tsx` |
| A | `apps/web/src/features/opening/access-policy.test.ts` |
| A | `apps/web/src/features/opening/access-policy.ts` |
| A | `apps/web/src/middleware.ts` |
| M | `packages/config/src/index.ts` |
| A | `packages/config/src/test-database.test.ts` |
| A | `packages/config/src/test-database.ts` |
| A | `scripts/opening-create-owner.ts` |
| A | `scripts/opening-test-db.mjs` |
| M | `tests/contract/ci-workflow.test.ts` |
| A | `tests/integration/handler/opening-access.test.ts` |
| M | `vitest.config.ts` |

## 3) Handler / integration guard when URL missing

`vitest` handler + integration projects use `scripts/opening-test-db.mjs` as `globalSetup`.

Re-run without `OPENING_TEST_DATABASE_URL` (and without `DATABASE_URL`):

```text
$ node node_modules/vitest/vitest.mjs run --project handler tests/integration/handler/opening-access.test.ts

Error: OPENING_TEST_DATABASE_URL is required for handler/integration projects
 ❯ Object.setup scripts/opening-test-db.mjs:47:11
```

Same message is thrown from `packages/config/src/test-database.ts` `setup()` when the env is empty. CLI wrapper prints `OPENING_TEST_DATABASE_URL is required` and exits 1.

Additional refusals (when URL present but unsafe) are covered by unit tests: `OPENING_TEST_DB=1` required, postgres scheme, loopback host, DB name exactly `aistudy_opening_test`.

## 4) Still required before verified (explicit gaps)

- Provide loopback `OPENING_TEST_DATABASE_URL` pointing at `aistudy_opening_test` with `OPENING_TEST_DB=1`.
- Green handler project including `tests/integration/handler/opening-access.test.ts` under that guard.
- Human confirm registration 403 / owner setup path against the isolated DB.
- Then (and only then) attach this file from `tasks.json` and flip F01 → `verified`.

## Suggested evidence path

`docs/superpowers/evidence/2026-09-13-opening-release/f01-access.md` (this file). Sibling draft note: `f01-evidence-draft.md` (shorter PM note; keep both until F01 closes).

## 5) Local runtime infrastructure gap (aistudy-verify / aistudy-pm, 2026-09-13)

On Fiona's machine at the time of F01 evidence collection:

- No PostgreSQL Windows service detected
- No `docker` on PATH
- No `psql` / `pg_isready` on PATH
- No repo `.env` present

So handler/integration green is blocked by **missing runtime**, not only a missing `OPENING_TEST_DATABASE_URL` string. Still **NOT verified**.
