# RP5 accept — Sources storage: expect `parseState` `queued` after verified upload

**Date:** 2026-10-09 ~22:26 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release` @ `182cd420257e5da3a1b64cc9ffc03e6da9a66b04` (+ this test fix, uncommitted at accept time)  
**Workspace:** `/workspace/study-assistant-opening`  
**Owner:** INTEGRATOR (AIstudy Data claim; Integrator ACCEPT re-run)  
**Verdict:** **ACCEPT yes** — local integration **9/9** green for this slice; **RP5 status stays `active`** (**not verified**). Other GHA integration failures may remain.

## Claim (AIstudy Data)

Only `tests/integration/opening-sources-storage.test.ts`: expect `parseState` **`queued`** not `not_started` (+ comment). No production code change.

Root cause: `completeWithParseJob` intentionally sets `parse_state = 'queued'` and opens one parse job (`packages/database/src/repositories/opening-sources.ts`).

## Diff verified (RP5 sources-storage-queued scope)

| File | Change |
|---|---|
| `tests/integration/opening-sources-storage.test.ts` | `expect(record.parseState).toBe("queued")` + comment that `completeWithParseJob` queues parse |

`git diff HEAD -- tests/integration/opening-sources-storage.test.ts`: **3 lines** (1 deletion / 2 insertions) — expectation + comment only. No production / repository / service change in this slice.

### Extra working-tree dirty (out of scope — left unstaged)

Unrelated paths present at accept time (not part of this ACCEPT commit):
- `q03-live-minio-object-restore.md` / `q03-packaging-gaps.md`
- Untracked: `services/parser/opening_parser.egg-info/`
- UI / identity already on separate commits (`182cd42` / `bb0dd9a`)

## Integrator re-run (local)

Env: sourced repo `.env` (Redis/MinIO/AUTH) plus explicit test DB guards. Services listening: PostgreSQL `127.0.0.1:5432`, Redis `6379`, MinIO `9000`.

| Command | Result |
|---|---|
| `OPENING_TEST_DB=1 OPENING_TEST_DATABASE_URL=postgres://aistudy:aistudy@127.0.0.1:5432/aistudy_opening_test npx vitest run --project integration tests/integration/opening-sources-storage.test.ts` | **1 file / 9 PASS** (exit 0; ~2.9s) |

## Context vs prior GHA

`rp5-gha-after-unit-fixes.md` listed `opening-sources-storage.test.ts:67` — expected `not_started`, received `queued`. This ACCEPT aligns the assertion with intentional `completeWithParseJob` behavior.

Other integration failures from that run (learning consumer races, observation revision backup privacy) are **out of scope** and may still fail remotely after this push. Identity migration list was accepted separately (`rp5-identity-migration-list-accept.md`).

## Ledger

- Append this file to RP5 `evidence` in `tasks.json`
- RP5 **status remains `active`** until remote `quality` / full integration suite green on a pushed SHA
- **Do not** mark `verified` on ACCEPT alone
