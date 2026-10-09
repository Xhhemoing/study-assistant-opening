# RP5 accept — Identity migration compatibility applied list through 0052

**Date:** 2026-10-09 ~22:25 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release` @ `926dade2f42684610b2b7ee1545fa0944548d706` (+ this test fix, uncommitted at accept time)  
**Workspace:** `/workspace/study-assistant-opening`  
**Owner:** INTEGRATOR (AIstudy Data claim; Integrator ACCEPT re-run)  
**Verdict:** **ACCEPT yes** — local integration 8/8 green for this slice; **RP5 status stays `active`** (**not verified**). Other GHA integration failures may remain.

## Claim (AIstudy Data)

Only `tests/integration/identity-migration-compatibility.test.ts` — three `result.applied` expectations extended with migrations `0046_opening_task_client_key` … `0052_opening_action_digest_decisions` (7 entries).

## Diff verified (RP5 identity-migration-list scope)

| File | Change |
|---|---|
| `tests/integration/identity-migration-compatibility.test.ts` | Three `result.applied` arrays: append `0046`…`0052` (7 `.sql` names each) |

`git diff HEAD -- tests/integration/identity-migration-compatibility.test.ts`: **21 insertions(+)** — only the seven migration filename strings, repeated at three assertion sites. No migration SQL, runner, or other test changes in this slice.

### Extra working-tree dirty (out of scope — left unstaged)

Unrelated paths present at accept time (not part of this ACCEPT commit):
- Opening UI / shell / search / settings / `packages/ui` edits
- `tests/integration/opening-sources-storage.test.ts`
- `q03-live-minio-object-restore.md` / `q03-packaging-gaps.md`
- Untracked: `ui-loop-converge-accept.md`, `services/parser/opening_parser.egg-info/`

## Integrator re-run (local)

| Command | Result |
|---|---|
| `OPENING_TEST_DB=1 OPENING_TEST_DATABASE_URL=postgres://aistudy:aistudy@127.0.0.1:5432/aistudy_opening_test npm run test:integration -- tests/integration/identity-migration-compatibility.test.ts` | **1 file / 8 PASS** (exit 0; ~4.5s) |

## Context vs prior GHA

`rp5-gha-after-unit-fixes.md` reported integration failures including three stale `identity-migration-compatibility` expectations ending at `0045_opening_imports.sql` while the runner applied through `0052`. This ACCEPT covers that slice only.

Other integration failures from that run (learning consumer races, observation revision backup privacy, sources storage) are **out of scope** and may still fail remotely after this push.

## Ledger

- Append this file to RP5 `evidence` in `tasks.json`
- RP5 **status remains `active`** until remote `quality` / full integration suite green on a pushed SHA
- **Do not** mark `verified` on ACCEPT alone
