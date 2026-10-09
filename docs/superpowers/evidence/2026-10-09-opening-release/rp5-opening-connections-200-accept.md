# RP5 accept — opening-connections DingTalk check 200 needs_authorization

**Date:** 2026-10-09 ~22:48 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release` @ `988f2ac` (+ this test-only fix, uncommitted at accept time)  
**Workspace:** `/workspace/study-assistant-opening`  
**Owner:** INTEGRATOR (Data implemented; Integrator ACCEPT + commit/push)  
**Verdict:** **ACCEPT yes** — handler Vitest **6/6 PASS**; **RP5 status stays `active`** (**not verified**).  
**Handler / product code:** **unchanged**.  
**Docker/CI:** **not claimed**.

## Root cause

C03 DingTalk `check` returns intentional HTTP **200** + `{ ok: false, status: "needs_authorization", ... }` when unauthorized (local fail-closed, no remote probe). The handler integration test still expected the old stub **503**.

Contract: `docs/operations/opening-dingtalk.md` — no internal read capability / `needs_authorization` → `{ ok: false, kind: "dingtalk", status: "needs_authorization", allowedScopes }`; HTTP check for `kind==="dingtalk"` returns that JSON (not 503). Prior C03 check ACCEPT: `c03-dingtalk-check-accept.md`.

## Diff verified (this slice only)

| File | Change |
|---|---|
| `tests/integration/handler/opening-connections.test.ts` | After DingTalk create (`needs_authorization`), `check` assert **200** + body `{ ok: false, kind: "dingtalk", status: "needs_authorization", allowedScopes: [] }` instead of status **503** |

`git diff` on that path: **1 file**, test-only (503→200 / body asserts). No apps/web or worker product edits.

### Extra working-tree dirty (out of scope — left unstaged)

- Untracked: `services/parser/opening_parser.egg-info/`
- `opening-upload-desktop.test.ts` already committed separately as `988f2ac` (`rp5-upload-desktop-queued-accept.md`)

## Integrator re-run (local)

```bash
cd /workspace/study-assistant-opening
set -a && [ -f .env ] && . ./.env; set +a
OPENING_RELEASE=0 OPENING_TEST_DB=1 \
OPENING_TEST_DATABASE_URL=postgres://aistudy:aistudy@127.0.0.1:5432/aistudy_opening_test \
npx vitest run --project handler tests/integration/handler/opening-connections.test.ts
```

| Command | Result |
|---|---|
| Handler project `opening-connections.test.ts` (env as above) | **1 file / 6 PASS** (exit 0; ~2.97s) |

Note: `OPENING_TEST_DATABASE_URL` is **not** in default `.env`; supplied explicitly to isolated `aistudy_opening_test` on `127.0.0.1:5432` (same pattern as prior C03/RP5 accepts). Port **5433** is E2E (`aistudy_opening_e2e`), not this handler gate.

## Ledger

- Append this file to RP5 `evidence` in `tasks.json`
- RP5 **status remains `active`**
- **Do not** mark `verified` on ACCEPT alone
- Commit message: `test(handler): expect 200 needs_authorization on DingTalk check`
