# C02 accept — IMAP sync/check HTTP wiring slice

**Date:** 2026-10-09 ~17:13 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release` @ `a9b87cb` (+ uncommitted Pipeline slice)  
**Workspace:** `/workspace/study-assistant-opening`  
**Scope:** Agent accept of Pipeline’s **C02 IMAP sync/check wired to connection HTTP** against `docs/superpowers/plans/opening-release/09-connections.md` § C02 (and C01B note that check/sync were 503 fail-closed until C02).  
**Verdict:** **ACCEPT** (HTTP wiring slice; **not verified**; C02 task remains incomplete for full CAP01)  
**Browser:** **not run** — do not claim browser pass.  
**School real IMAP:** **not run**.  
**tasks.json:** **not edited** by this accept (C02 row left `active`; prior unrelated DL8/DL9 dirty status ignored). **verified:** **not marked**.  
**Commit/push:** **not done**.

## Claimed deliverable (this slice)

- IMAP `check` / `sync` no longer blanket-503 for `kind=imap`
- Changed: `connections/service.ts`, `sync-mail.ts` (+ `createCheckMailHandler`), check route, `opening-mail.md`; new `service.test.ts`; handler revoked→409
- Unit 9/9, handler 6/6, tsc web+worker
- Integration `opening-imap-sync` still blocked (fixture ImapFlow LOGIN BAD — not introduced by this slice)

## Files reviewed

**Changed**
- `apps/web/src/features/opening/connections/service.ts` — injectible `checkMail`/`syncMail`; IMAP paths call handlers; revoked→409 before adapter; DingTalk check remains 503; host/credential/folder errors mapped
- `apps/web/src/app/api/opening/connections/[id]/check/route.ts` — returns JSON check result (no longer throws after stub)
- `apps/worker/src/jobs/sync-mail.ts` — adds `createCheckMailHandler` (allowlist → decrypt → ImapFlow connect, read-only mailboxOpen or list, logout; no STORE/EXPUNGE/send)
- `docs/operations/opening-mail.md` — documents HTTP check/sync / revoked 409 / DingTalk check still 503
- `tests/integration/handler/opening-connections.test.ts` — revoked IMAP check/sync → 409; body must not contain old adapter-stub message

**New**
- `apps/web/src/features/opening/connections/service.test.ts` — HTTP boundary unit coverage (injected adapters)

**Unchanged but relevant (prior C02 slices)**
- `apps/worker/src/connectors/imap-sync.ts` (+ unit tests) — cursor / syncMailbox
- `apps/web/src/app/api/opening/connections/[id]/sync/route.ts` — already returned `unavailable()` result; now IMAP path is live

## Plan criteria checklist (this slice)

| # | Criterion | Result | Notes |
|---|---|---|---|
| 1 | IMAP sync wired to connection HTTP (`POST …/sync`) | **PASS** | `unavailable` → `createSyncMailHandler` for `kind=imap` |
| 2 | IMAP check wired to connection HTTP (`POST …/check`) | **PASS** | `checkUnavailable` → `createCheckMailHandler`; route returns `{ ok: true, kind: "imap" }` on success |
| 3 | No blanket 503 for IMAP when adapter path is taken | **PASS** | Stub 503 only for non-IMAP check / unknown kinds; IMAP errors mapped (host 400, missing credential 503, generic IMAP fail 503) |
| 4 | Revoked → 409 for check and sync | **PASS** | Service throws CONFLICT 409 before handler; handler + unit assert |
| 5 | Check is read-only (no STORE/EXPUNGE/send) | **PASS** | `mailboxOpen(..., { readOnly: true })` or `list`; ops doc restates |
| 6 | Host allowlist / vault decrypt / rejectUnauthorized TLS | **PASS** | Shared with sync handler patterns |
| 7 | DingTalk check remains fail-closed 503 | **PASS** | Unit asserts; slice does not invent remote DingTalk check |
| 8 | Ops doc updated for HTTP boundary | **PASS** | `docs/operations/opening-mail.md` |
| 9 | Full C02 isolated IMAP integration gate | **GAP** | Confirmed failing; known fixture LOGIN parse issue — **does not block this HTTP-wiring accept** per PM |
| 10 | School live IMAP acceptance | **GAP** | Not run (out of scope) |
| 11 | Browser | **GAP** | Not run |
| 12 | Module ≤200 lines (global constraint) | **NOTE** | `sync-mail.ts` is **207** lines after adding check handler — follow-up split recommended; not treated as BLOCK for this wiring slice |

## Tests re-run (actual)

```text
# Unit — service.test (6) + imap-sync.test (3) = 9
node node_modules/vitest/vitest.mjs run --project unit \
  apps/web/src/features/opening/connections/service.test.ts \
  apps/worker/src/connectors/imap-sync.test.ts
# → Test Files 2 passed | Tests 9 passed (9)

# Handler — opening-connections = 6
OPENING_TEST_DB=1 \
OPENING_TEST_DATABASE_URL=postgres://aistudy:aistudy@127.0.0.1:5432/aistudy_opening_test \
OPENING_IMAP_ALLOWED_HOSTS=mail.example.edu \
DATABASE_URL=postgres://aistudy:aistudy@127.0.0.1:5432/aistudy_opening_test \
  node node_modules/vitest/vitest.mjs run --project handler \
  tests/integration/handler/opening-connections.test.ts
# → Test Files 1 passed | Tests 6 passed (6)

# tsc
node node_modules/typescript/bin/tsc -p apps/web/tsconfig.json --noEmit     # exit 0
node node_modules/typescript/bin/tsc -p apps/worker/tsconfig.json --noEmit  # exit 0
```

### Integration attempt (known gap — confirm only)

```text
OPENING_TEST_DB=1 OPENING_TEST_DATABASE_URL=postgres://aistudy:aistudy@127.0.0.1:5432/aistudy_opening_test \
  node node_modules/vitest/vitest.mjs run --project integration \
  tests/integration/opening-imap-sync.test.ts
# → 5/5 failed
# ImapFlow: executedCommand LOGIN … responseStatus BAD responseText "unknown command"
# Root cause in fixture (pre-existing, not this slice):
#   tests/integration/opening-imap-server.ts matches `command === "LOGIN"`
#   but ImapFlow sends `LOGIN "user" "pass"` → rest uppercased ≠ exact "LOGIN"
#   (should be startsWith("LOGIN") like LIST/EXAMINE). afterAll also hook-timeout.
```

School real IMAP connect: **not run**. Browser: **not run**.

## Known gaps (record; do not block HTTP-wiring ACCEPT)

1. **Integration fixture BAD LOGIN** — `opening-imap-server.ts` exact-match on `LOGIN` rejects ImapFlow’s `LOGIN "…" "…"`; blocks `tests/integration/opening-imap-sync.test.ts`. Fix is fixture-side; not introduced by sync/check HTTP wiring.
2. **School real IMAP** — not run; CAP01 live acceptance still separate.
3. **Browser** — not run.
4. **Full C02 verified / CAP01 complete** — not claimed; task stays active until integration + school gates (and remaining plan items) close.
5. **`sync-mail.ts` 207 lines** — slightly over ≤200 global constraint; suggest extracting check handler later.

## Verdict rationale

Code and unit/handler/tsc match the claimed HTTP wiring: IMAP check/sync are no longer a blanket adapter stub; revoked stays 409; DingTalk check remains 503. Integration and school/browser gaps are explicitly known and do not block accept of this slice. **Not verified.** tasks.json untouched by accept.
