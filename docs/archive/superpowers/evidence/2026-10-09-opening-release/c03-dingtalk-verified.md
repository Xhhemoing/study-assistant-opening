# C03 DingTalk adapter — integration verified (agent-owned)

**Date:** 2026-10-09 ~17:50 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release` @ `a9b87cb` (+ uncommitted Pipeline check/callback wiring as accepted earlier)  
**Workspace:** `/workspace/study-assistant-opening`  
**Verifier:** AIstudy Integrator (not the implementer)  
**Verdict:** **verified** on isolated integration gate **9/9** (PM rule: same pattern as C02 — mark verified from agent-owned unit + `test:integration -- opening-dingtalk`; real org auth/callback/file samples + browser remain gaps; **CAP02 must not claim live connect done**)

## Prior accepts (cited)

- Callback / sync boundary slice: [`../2026-10-06-opening-release/c03-dingtalk-callback-slice.md`](../2026-10-06-opening-release/c03-dingtalk-callback-slice.md) — client crypto, events route, durable receipt, attachment host allowlist; noted `/check` still 503 at that time.
- Check-slice ACCEPT: [`c03-dingtalk-check-accept.md`](./c03-dingtalk-check-accept.md) — local fail-closed DingTalk `check` (no remote probe); no-read→`needs_authorization`; read→`ready` / `unsupported_history_read`; revoked→409; manual `.eml` stays manual. Integration was already **9/9** with test DB; task left `active` (not verified) pending this agent-owned close decision.

## Re-verify (this pass)

```text
# Unit — sync-dingtalk + connections/service (= 12)
node node_modules/vitest/vitest.mjs run --project unit \
  apps/worker/src/jobs/sync-dingtalk.test.ts \
  apps/web/src/features/opening/connections/service.test.ts
→ Test Files  2 passed (2)
→ Tests       12 passed (12)
  (sync-dingtalk 5: sync needs_authorization / unsupported_history_read;
   check needs_authorization / ready / unsupported_history_read
   + service 7: IMAP boundary + DingTalk check routing / ready-without-probe)

# Integration — opening-dingtalk (= 9)  ★ gate
OPENING_TEST_DB=1 \
OPENING_TEST_DATABASE_URL=postgres://aistudy:aistudy@127.0.0.1:5432/aistudy_opening_test \
  node node_modules/vitest/vitest.mjs run --project integration \
  tests/integration/opening-dingtalk.test.ts
→ Test Files  1 passed (1)
→ Tests       9 passed (9)
→ Duration    ~3.83s
  Cases cover forged signature, expired callback, replay/duplicate event,
  pagination/rate-limit boundaries, revoke, cross-org ID, etc. (per § C03).
```

## Explicit gaps (do not claim closed)

1. **Real enterprise DingTalk authorization / live callback / notification+file samples** — not run; **CAP02 live gate remains open** (`09-connections.md` § C03: 真实组织授权/通知/文件样本单列验收; CAP02 不得标实接完成).
2. **Browser / real-use acceptance** — not run.
3. **History group-chat pull** — unsupported by design (`unsupported_history_read`); not a live connect claim.
4. Env: `OPENING_TEST_DATABASE_URL` must be supplied for handler/integration on this box (not in default `.env`).

## Ledger

- `tasks.json` C03 → `verified`; primary evidence this path; keep prior callback-slice + check-accept evidence entries.
- Commit/push: **not done** (Integrator instruction: Do NOT commit/push).
