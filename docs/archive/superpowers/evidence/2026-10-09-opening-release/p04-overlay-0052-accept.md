# P04 Data 0052 overlay + Experience durable switch — ACCEPT

**Date:** 2026-10-09 ~18:10 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release` @ `a9b87cb` (+ uncommitted Data 0052 / Experience durable route switch)  
**Workspace:** `/workspace/study-assistant-opening`  
**Verifier:** AIstudy Integrator (not the implementer)  
**Verdict:** **ACCEPT** (Data overlay + Experience durable wiring; agent-owned)  
**P04 verified:** see companion [`p04-verified.md`](./p04-verified.md) — **YES** after this pass (unit + integration green).  
**Browser:** **not run** — do not claim browser pass.  
**Commit/push:** **not done**.

## Prior accepts (cited; not re-litigated)

- AI extract half: [`p04-ai-extract-study-actions-accept.md`](./p04-ai-extract-study-actions-accept.md) — extract-study-actions + migration 0051.
- Experience digest half: [`p04-experience-action-digest-accept.md`](./p04-experience-action-digest-accept.md) — domain/web digest, service, route, card (then still in-memory overlay).
- Import-chunks wiring: [`p04-import-chunks-wiring-accept.md`](./p04-import-chunks-wiring-accept.md) — Data `listAuthorizedImportChunks` + worker re-wire (noted waiting 0052).

Plan: `docs/superpowers/plans/opening-release/11-proactive-acceptance.md` § P04.

## Claims checked

| Claim | Result |
|---|---|
| Migration `0052_opening_action_digest_decisions.sql` | **PASS** — durable decisions table; statuses `accepted\|rejected\|superseded`; id=candidate_id; dedupe + partial unique client_key |
| Schema + repo `createOpeningActionDigestDecisionsRepository` | **PASS** — list / upsert / recordDecision; exported from `@aistudy/database` |
| Same id+status idempotent; conflict status → CONFLICT | **PASS** — unit + review |
| Reject by dedupeKey → no re-prompt (list surfaces rejected) | **PASS** — overlay list + domain `buildActionDigest` (integration) |
| Accept refuses revoked connection sources; reject still allowed | **PASS** — unit + integration |
| Experience route defaults to decisions repo (0052); in-memory only in tests | **PASS** — `action-digest/route.ts` uses `decisionStoreOverride ?? createOpeningActionDigestDecisionsRepository(sql)` |
| Data unit **7** | **PASS** — 7/7 |
| Experience digest/service/card (+ decisions) **27** | **PASS** — 27/27 |
| database + web `tsc` | **PASS** — both exit 0 |
| Integration `opening-action-digest` with test DB | **PASS** — **3/3** (todo removed; re-run this pass) |

## Files reviewed

**Create (Data)**
- `packages/database/src/migrations/0052_opening_action_digest_decisions.sql`
- `packages/database/src/schema/opening-action-digest-decisions.ts`
- `packages/database/src/repositories/opening-action-digest-decisions.ts` (+ `.test.ts`)

**Modify (Experience durable switch)**
- `apps/web/src/app/api/opening/action-digest/route.ts` — production store = 0052 repo; test seam keeps in-memory override
- `apps/web/src/features/opening/planning/action-service.ts` — comment documents 0052 production / in-memory tests

**Integration**
- `tests/integration/opening-action-digest.test.ts` — real cases (no `it.todo`); `describe.skipIf(!OPENING_TEST_DB)`

## Migration 0052 (test DB)

Applied via `DATABASE_URL=postgres://aistudy:aistudy@127.0.0.1:5432/aistudy_opening_test npm run db:migrate` this pass (also applied pending `0051_opening_extract_study_actions_job.sql`). Table `opening_action_digest_decisions` present afterward.

## Tests re-run (actual)

```text
# Data decisions unit (= 7)
node node_modules/vitest/vitest.mjs run --project unit \
  packages/database/src/repositories/opening-action-digest-decisions.test.ts
→ Test Files  1 passed (1)
→ Tests       7 passed (7)

# Experience digest/service/card + decisions (= 27)
node node_modules/vitest/vitest.mjs run --project unit \
  packages/domain/src/opening/action-digest.test.ts \
  apps/web/src/features/opening/planning/action-service.test.ts \
  apps/web/src/features/opening/planning/action-digest-card.test.ts \
  packages/database/src/repositories/opening-action-digest-decisions.test.ts
→ Test Files  4 passed (4)
→ Tests       27 passed (27)
  Breakdown: action-digest 11 + action-service 7 + action-digest-card 2 + decisions 7 = 27

# Integration — opening-action-digest (= 3)  ★ gate
OPENING_TEST_DB=1 \
OPENING_TEST_DATABASE_URL=postgres://aistudy:aistudy@127.0.0.1:5432/aistudy_opening_test \
  node node_modules/vitest/vitest.mjs run --project integration \
  tests/integration/opening-action-digest.test.ts
→ Test Files  1 passed (1)
→ Tests       3 passed (3)
  Cases: accept idempotent + rejected not re-prompted;
         source correction supersedes pending / delta-only prompt;
         revoked connection late accept refused (reject still allowed).

# tsc
npx tsc -p packages/database --noEmit → exit 0
npx tsc -p apps/web --noEmit → exit 0
```

## Explicit gaps (do not claim closed)

1. **Browser / U04 e2e** — not run.
2. **Live school mail/DingTalk → real extract → Today digest UX** — not run (C02/C03 live gaps remain separate).
3. Fatigue/rest / full § P04 manual scenario checklist beyond agent-owned unit+integration — not claimed.

## Ledger note

- Half ACCEPT recorded here; full P04 agent-owned close in [`p04-verified.md`](./p04-verified.md).
- `tasks.json` P04 → `verified` only if verified companion written (this Integrator pass does both).
- Commit/push: **not done**.
