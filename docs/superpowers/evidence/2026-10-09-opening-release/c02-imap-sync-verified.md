# C02 IMAP sync — integration verified (agent-owned)

**Date:** 2026-10-09 ~17:38 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release` @ `a9b87cb` (+ uncommitted Pipeline fixture/sync fixes)  
**Workspace:** `/workspace/study-assistant-opening`  
**Verifier:** AIstudy Integrator (not the implementer)  
**Verdict:** **verified** on isolated integration gate **5/5** (PM rule: mark verified from integration 5/5; school/browser remain gaps)

## Prior accept + fixture fix (cited)

- HTTP wiring accept: [`c02-imap-sync-check-accept.md`](./c02-imap-sync-check-accept.md) — IMAP check/sync no longer blanket-503; revoked→409; DingTalk check left separate. Integration was **5/5 FAIL** then (fixture LOGIN dialect).
- Fixture / sync follow-ups (Pipeline, uncommitted vs `a9b87cb`):
  - `tests/integration/opening-imap-server.ts` — parse command **verb** (not whole rest) so ImapFlow `LOGIN "user" "pass"` authenticates; support `UID FETCH` + `1:*` ranges; `LSUB`; destroy open sockets on close (avoids afterAll hang).
  - `apps/worker/src/connectors/imap-sync.ts` — receipt identity pre-check / replay skip before fetch; cursor advance via `nextImapCursor` after skip or commit (dedupe without double-import).

## Re-verify (this pass)

```text
# Integration — opening-imap-sync (= 5)  ★ gate
OPENING_TEST_DB=1 \
OPENING_TEST_DATABASE_URL=postgres://aistudy:aistudy@127.0.0.1:5432/aistudy_opening_test \
  node node_modules/vitest/vitest.mjs run --project integration \
  tests/integration/opening-imap-sync.test.ts
→ Test Files  1 passed (1)
→ Tests       5 passed (5)
→ Duration    ~6.20s
  Cases: import one wire message; replay no duplicate + stable UID cursor;
         upload fail does not advance cursor/receipt; mailbox generation /
         workspace isolation; revoked connection stale final commit no ticket.

# Unit — cheap C02 surface (= 10)
node node_modules/vitest/vitest.mjs run --project unit \
  apps/worker/src/connectors/imap-sync.test.ts \
  apps/web/src/features/opening/connections/service.test.ts
→ Test Files  2 passed (2)
→ Tests       10 passed (10)
  (imap-sync 3 + service 7)
```

## Related (not the C02 5/5 gate)

Handler `opening-connections` + `opening-imports-email` re-run under same DB env: imports-email **PASS**; connections **5/6** — one DingTalk `needs_authorization` **check** now returns **200** where the test still expects **503** (C03 local-check wiring drift; not IMAP integration). Does **not** block this C02 verified mark per PM.

## Explicit gaps (do not claim closed)

1. **School real IMAP** — not run; CAP01 live host/folder/read-one-mail/revoke still separate (`09-connections.md` § C02).
2. **Browser** — not run.
3. Handler expectation for DingTalk check status — track under C03 / connections suite, not as C02 IMAP fail.

## Ledger

- `tasks.json` C02 → `verified`; primary evidence this path; keep prior code-slice evidence entries.
- Commit/push: evidence + `tasks.json` only (Integrator ledger).
