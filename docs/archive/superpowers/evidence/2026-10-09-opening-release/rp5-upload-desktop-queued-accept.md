# RP5 accept — Handler upload-desktop: expect `parseState` `queued` after complete

**Date:** 2026-10-09 ~22:48 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release` @ `a476832eb965c02eb7cf24bce79f344a4f7e869d` (+ this test fix, uncommitted at accept time)  
**Workspace:** `/workspace/study-assistant-opening`  
**Owner:** INTEGRATOR (Integrator ACCEPT; Pipeline slice was specified but not left dirty — accepter applied the one-line expectation + comment matching sources-storage)  
**Verdict:** **ACCEPT yes** — local handler **2/2** green for this slice; **RP5 status stays `active`** (**not verified**). Other handler/integration failures may remain remotely.

## Claim

Only `tests/integration/handler/opening-upload-desktop.test.ts`: expect `parseState` **`queued`** not `not_started` (+ comment aligning with `completeWithParseJob`). No production code change.

Root cause: `completeWithParseJob` sets `parse_state = 'queued'` and opens one parse job (`packages/database/src/repositories/opening-sources.ts` ~line 177). Desktop complete handler uses that path (`apps/web/src/features/opening/sources/source-service.ts`).

## Diff verified (RP5 upload-desktop-queued scope)

| File | Change |
|---|---|
| `tests/integration/handler/opening-upload-desktop.test.ts` | `parseState: "queued"` + comment that `completeWithParseJob` queues parse |

Meaningful change only: expectation + comment in that one test file.

### Extra working-tree dirty (out of scope — left unstaged)

- Untracked: `services/parser/opening_parser.egg-info/`
- Evidence/Q03/other docs, `apps/web`, opening-connections — not part of this ACCEPT commit

## Integrator re-run (local)

Env: sourced repo `.env` plus `OPENING_RELEASE=0` (so register is not blocked), `OPENING_TEST_DB=1`, `OPENING_TEST_DATABASE_URL=postgres://aistudy:aistudy@127.0.0.1:5432/aistudy_opening_test`.

| Command | Result |
|---|---|
| `OPENING_RELEASE=0 OPENING_TEST_DB=1 OPENING_TEST_DATABASE_URL=postgres://aistudy:aistudy@127.0.0.1:5432/aistudy_opening_test npx vitest run --project handler tests/integration/handler/opening-upload-desktop.test.ts` | **1 file / 2 PASS** (exit 0; ~2.7s) |

## Context vs prior GHA

GHA failure on `a3d1443` was `parseState` queued vs not_started at `opening-upload-desktop.test.ts:107`. This ACCEPT aligns the assertion with intentional `completeWithParseJob` behavior (same pattern as `rp5-sources-storage-queued-accept.md` / `b866e93`).

## Ledger

- Append this file to RP5 `evidence` in `tasks.json`
- RP5 **status remains `active`** until remote `quality` / full suite green on a pushed SHA
- **Do not** mark `verified` on ACCEPT alone
