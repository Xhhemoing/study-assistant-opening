# C03 accept — DingTalk check (local fail-closed) slice

**Date:** 2026-10-09 ~17:25 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release` @ `a9b87cb` (+ uncommitted Pipeline check slice)  
**Workspace:** `/workspace/study-assistant-opening`  
**Scope:** Agent accept of Pipeline’s **C03 DingTalk connection check** against `docs/superpowers/plans/opening-release/09-connections.md` § C03.  
**Verdict:** **ACCEPT** (check slice; **not verified**; C03 task remains incomplete for full CAP02 live integration)  
**Browser:** **not run** — do not claim browser pass.  
**Real org auth / live DingTalk callback:** **not run**.  
**tasks.json:** **not edited** by this accept (C03 left `active`; other dirty task rows ignored). **verified:** **not marked**.  
**Commit/push:** **not done**.

## Claimed deliverable (this slice)

- DingTalk `check` is local fail-closed: **no remote probe**
- No internal read capability → `needs_authorization`
- With read capability → `ready` / `unsupported_history_read` (do not fake history pull)
- Revoked → HTTP **409**
- Manual upload / `.eml` fallback stays `manual` (no connection import receipt)
- Files: `sync-dingtalk.ts` (+`checkDingTalk`/`createCheckDingTalkHandler`), `sync-dingtalk.test.ts`, `connections/service.ts`, `service.test.ts`, `dingtalk-policy.ts` (comments), `opening-dingtalk.md`, `source-service.test.ts`, `opening-imports-email.test.ts`
- Claimed tests: unit-ish **5 files / 35**; tsc web+worker

## Prior related evidence

- `docs/superpowers/evidence/2026-10-06-opening-release/c03-dingtalk-callback-slice.md` — callback/sync boundary, client crypto, events route; explicitly noted **`/check` remained 503 fail-closed**. This accept covers the check wiring that closed that gap.
- C02 IMAP check/sync HTTP accept (`c02-imap-sync-check-accept.md`) shares the same `connections/service.ts` HTTP boundary patterns (injectable adapters, revoked→409).

## Files reviewed

**Changed (this slice vs HEAD)**
- `apps/worker/src/jobs/sync-dingtalk.ts` — adds `checkDingTalk` + `createCheckDingTalkHandler`; local scope/capability check only; no remote DingTalk API calls; `ready` means internal read capability present for callback/event ingestion, not history sync
- `apps/worker/src/jobs/sync-dingtalk.test.ts` — check boundary: no-read→`needs_authorization`; read+ready→`ready`; read+non-ready→`unsupported_history_read`
- `apps/web/src/features/opening/connections/service.ts` — injectable `checkDingTalk`; `kind==="dingtalk"` routes check through durable handler; revoked→409 before adapter
- `apps/web/src/app/api/opening/connections/[id]/check/route.ts` — returns JSON check result (same pattern as IMAP)
- `apps/worker/src/connectors/dingtalk-policy.ts` — comment map of internal capabilities ↔ official surfaces; `robot.send` ≠ read
- `docs/operations/opening-dingtalk.md` — documents check statuses, no remote probe, revoked 409, manual stays manual
- `apps/web/src/features/opening/sources/source-service.test.ts` — ordinary upload complete does not write `opening_import_receipts`
- `tests/integration/handler/opening-imports-email.test.ts` — manual `.eml` stays `manual`, no receipt rows

**New**
- `apps/web/src/features/opening/connections/service.test.ts` — HTTP boundary unit coverage including DingTalk check routing and ready-without-probe

**Unchanged but relevant (prior C03 callback slice)**
- `apps/worker/src/connectors/dingtalk-client.ts` (+ tests)
- `apps/web/src/features/opening/connections/dingtalk-callback-service.ts`
- `apps/web/src/app/api/opening/connections/dingtalk/events/route.ts`
- `tests/integration/opening-dingtalk.test.ts`

## Plan criteria checklist (this check slice)

| # | Criterion (from § C03 / claimed behavior) | Result | Notes |
|---|---|---|---|
| 1 | `canReadDingTalkResource` — `robot.send` does not imply `messages.read` | **PASS** | Policy exact-match + unit test; check/sync both gate on internal read caps |
| 2 | Check local fail-closed; **no remote probe** | **PASS** | `checkDingTalk` only reads connection + granted scopes; no fetch/SDK call |
| 3 | No read capability → `needs_authorization` | **PASS** | Unit + service inject tests |
| 4 | With read → `ready` / `unsupported_history_read`; do not fake history | **PASS** | `ready` only when connection.state is ready; sync still `unsupported_history_read` |
| 5 | Revoked → 409 | **PASS** | Service rejects before kind adapter; unit asserts CONFLICT 409 |
| 6 | Manual upload / `.eml` stays manual (no import receipt) | **PASS** | source-service unit + handler eml test |
| 7 | Operations doc records official URLs / SDK / no history API | **PASS** | `opening-dingtalk.md` updated for check semantics |
| 8 | Module ≤200 lines (global) | **PASS** | `sync-dingtalk.ts` 183; `service.ts` 142; `dingtalk-policy.ts` 20 |
| 9 | Integration `opening-dingtalk` | **PASS** (local DB) | 9/9 with `OPENING_TEST_DATABASE_URL` → `aistudy_opening_test` |
| 10 | Real org authorization / live callback / file samples | **GAP** | Not run; CAP02 must not be marked live-complete |
| 11 | Browser acceptance | **GAP** | Explicitly not run |
| 12 | Full C03 remaining (history API still absent; fixture dialect later) | **GAP** | History pull remains unsupported by design; dialect fixture deferred |

## Tests re-run (this accept)

**Unit (4 files under `--project unit` → 29 tests):**
```text
node node_modules/vitest/vitest.mjs run --project unit \
  apps/worker/src/jobs/sync-dingtalk.test.ts \
  apps/web/src/features/opening/connections/service.test.ts \
  apps/web/src/features/opening/sources/source-service.test.ts \
  apps/worker/src/connectors/dingtalk-policy.test.ts
# → 4 files / 29 passed
```

**Handler (claimed 5th file → 6 tests):**
```text
OPENING_TEST_DB=1 \
OPENING_TEST_DATABASE_URL=postgres://aistudy:aistudy@127.0.0.1:5432/aistudy_opening_test \
  node node_modules/vitest/vitest.mjs run --project handler \
  tests/integration/handler/opening-imports-email.test.ts
# → 1 file / 6 passed
```

**Claimed aggregate:** 5 files / **35** tests passed (29 unit + 6 handler).

**tsc:**
```text
npx tsc -p apps/web/tsconfig.json --noEmit     # exit 0
npx tsc -p apps/worker/tsconfig.json --noEmit  # exit 0
```

**Integration (DB URL worked on this box — claim listed as gap):**
```text
OPENING_TEST_DB=1 \
OPENING_TEST_DATABASE_URL=postgres://aistudy:aistudy@127.0.0.1:5432/aistudy_opening_test \
  node node_modules/vitest/vitest.mjs run --project integration \
  tests/integration/opening-dingtalk.test.ts
# → 1 file / 9 passed
```

Note: `OPENING_TEST_DATABASE_URL` is **not** set in default `.env`; accept exported it to the isolated `aistudy_opening_test` DB. Without that env, handler/integration projects refuse to start.

## Gaps (remaining; do not block this check-slice ACCEPT)

1. **Real enterprise DingTalk authorization / live callback / notification+file samples** — not run; keep C03 `active`, CAP02 not live-complete.
2. **Browser / real-use acceptance** — not run.
3. **Fixture dialect** — deferred (per claim).
4. **Env bootstrap** — `OPENING_TEST_DATABASE_URL` unset in `.env`; local CI/dev must supply it for handler/integration.
5. Full C03 is still not “verified”: check/sync honesty + callback slice exist, but live org gates remain.

## Accept notes

- Code matches claimed check behavior and § C03 honesty rules (no history fake, no robot.send→read, manual stays manual).
- Prior callback evidence correctly described check as still 503; this slice closes that HTTP path for `kind=dingtalk`.
- Integration suite **did** pass when DB URL was supplied; treat “needs OPENING_TEST_DATABASE_URL” as an env gap, not a failing test gap on this machine.
- **Not verified.** tasks.json untouched by accept. No commit/push.
