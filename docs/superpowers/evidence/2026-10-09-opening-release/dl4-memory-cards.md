# DL4 Opening memory cards — agent-owned checks accepted

Verifier: AIstudy Integrator (not the implementer). Workspace: `/workspace/study-assistant-opening`, branch `feat/opening-release`. Uncommitted.

## Diff vs `13-daily-loop-gaps.md` § DL4

Detail in [`dl4-memory-cards-accept.md`](./dl4-memory-cards-accept.md) (**ACCEPT** ~17:30 CST). Summary:

**UI / client**
- `/opening/cards` page + `CardReviewView`: server due queue; front→reveal→四档 (忘记/困难/良好/简单); empty/error/logged-out; no mastery %.
- `CreateCardDialog` from assistant 「制成卡片」: snippet → `documentId` as `sourceDocumentId`; edit front/back; empty blocked; failure keeps input + reuses snippet id.
- Today: due count link only (`{N} 张记忆卡片到期` → `/opening/cards`); cards not written into tasks/plan.
- Naming separate from 补测/retest; grades go through existing `scheduleReview` + cards state (no new card tables/APIs).

**Routing**
- Middleware `/learn/review*` → `/opening/cards` (was `/opening/today`).
- Experience fixed `shell/navigation.test.ts` expectations to `/opening/cards` (accept gap #1).

## Verification (agent-owned, Integrator re-run 2026-10-09 ~17:32 CST)

**Nav fix + cards units (this close):**
- `node node_modules/vitest/vitest.mjs run --project unit` `apps/web/src/features/opening/shell/navigation.test.ts` + `apps/web/src/features/opening/cards/` + `apps/web/src/features/opening/access-middleware.test.ts` → **3** files, **27** passed (~1.8–2.0s). Breakdown: navigation **4**, cards-client **4**, access-middleware **19**.

**Cited from prior accept** ([`dl4-memory-cards-accept.md`](./dl4-memory-cards-accept.md)):
- Same cards + access-middleware scope → **23** passed (pre-nav-fix window).
- `vitest --project contract tests/contract/opening-no-mock.test.ts` → **4** passed.
- `tsc -p apps/web/tsconfig.json --noEmit` → exit 0.

## Not run

- **Browser** walk (create from assistant → review grades → today due link). Plan/`AGENTS.md` leave browser to the user; same follow-up pattern as DL5/DL9.
- **`tests/integration/handler/reviews.test.ts`** — `OPENING_TEST_DB` / `OPENING_TEST_DATABASE_URL` still unset; handler `globalSetup` refuses without isolated `aistudy_opening_test`. Plan’s “no `opening_learning_observations` from grade” remains **static-only** this pass.

## Ledger

- `tasks.json` DL4 → `verified` with this evidence path. No commit. **P04a and DL9 remain verified.**
