# RP5 accept — Privacy race + observation backup integration fixtures

**Date:** 2026-10-09 ~22:28 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release` @ `b866e935325505619b167a9132c7a35cf48239a4` (+ these test fixes, uncommitted at accept time)  
**Workspace:** `/workspace/study-assistant-opening`  
**Owner:** INTEGRATOR (AIstudy Data claim; Integrator ACCEPT re-run)  
**Verdict:** **ACCEPT yes** — local integration **6/6** then **5/5** green (sequential; no parallel truncate); **RP5 status stays `active`** (**not verified**). Full remote `quality` may still fail on other suites.

## Claim (AIstudy Data)

Tests only, no product/repo code:

1. `tests/integration/opening-learning-consumer-races.test.ts` — assert rejected candidate ids absent from `opening_jobs`; ignore retest-scan jobs enqueued by observation insert (6/6).
2. `tests/integration/opening-observation-revision-backup-privacy.test.ts` — `replace()` carries `answer: chain.original.answer` to avoid DL6 answer-lock VALIDATION (5/5). Run files sequentially (no parallel truncate).

## Diff verified (RP5 privacy-integration scope)

| File | Change |
|---|---|
| `opening-learning-consumer-races.test.ts` | Capture `legacyId`; assert `opening_jobs` has neither rejected candidate id; comment that observation insert enqueues `kind=retest` scan jobs |
| `opening-observation-revision-backup-privacy.test.ts` | Pass `answer: chain.original.answer` into `replace(...)` + DL6 comment |

`git diff HEAD --` those two paths: **2 files changed, 6 insertions(+), 2 deletions(-)** — fixture/assertion only. No repository, migration, or product changes.

### Extra working-tree dirty (out of scope — left unstaged)

- `docs/superpowers/evidence/2026-10-09-opening-release/q03-live-minio-object-restore.md`
- `docs/superpowers/evidence/2026-10-09-opening-release/q03-packaging-gaps.md`
- Untracked: `services/parser/opening_parser.egg-info/`

## Identity-migration slice (already accepted / pushed)

`bb0dd9a test(integration): extend identity compat applied list through 0052` is already on `feat/opening-release` (remote up to date). No uncommitted identity test change at this ACCEPT. Evidence: `rp5-identity-migration-list-accept.md`.

## Integrator re-run (local, sequential)

Env: `OPENING_TEST_DB=1`, `OPENING_TEST_DATABASE_URL=postgres://aistudy:aistudy@127.0.0.1:5432/aistudy_opening_test`, plus `.env` (MinIO/`S3_*`). Postgres accepting on `127.0.0.1:5432`; MinIO health live/ready HTTP 200.

| Order | Command | Result |
|---|---|---|
| 1 | `npm run test:integration -- tests/integration/opening-learning-consumer-races.test.ts` | **1 file / 6 PASS** (exit 0; ~3.6s tests wall ~4.5s) |
| 2 | `npm run test:integration -- tests/integration/opening-observation-revision-backup-privacy.test.ts` | **1 file / 5 PASS** (exit 0; ~3.9s tests wall ~4.9s) |

## Ledger

- Append this file to RP5 `evidence` in `tasks.json`
- RP5 **status remains `active`** until remote `quality` / full integration suite green on a pushed SHA
- **Do not** mark `verified` on ACCEPT alone
