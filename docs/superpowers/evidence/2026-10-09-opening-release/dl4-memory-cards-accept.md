# DL4 Opening memory cards — accept

**Date:** 2026-10-09 ~17:30 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release` (workspace `/workspace/study-assistant-opening`)  
**Scope:** `docs/superpowers/plans/opening-release/13-daily-loop-gaps.md` § DL4  
**Verdict:** **ACCEPT** (with gaps below; not verified)  
**Browser:** **not run**  
**tasks.json:** not edited. **verified:** not marked. No commit/push.

## Files reviewed

**New (untracked)**
- `apps/web/src/app/(opening)/opening/cards/page.tsx`
- `apps/web/src/features/opening/cards/cards-client.ts`
- `apps/web/src/features/opening/cards/cards-client.test.ts`
- `apps/web/src/features/opening/cards/card-review-view.tsx`
- `apps/web/src/features/opening/cards/create-card-dialog.tsx`

**Changed (DL4-relevant)**
- `apps/web/src/features/opening/assistant/message-actions.tsx` — 「制成卡片」
- `apps/web/src/features/opening/assistant/message-list.tsx` — `onCreateCard` wiring
- `apps/web/src/features/opening/assistant/assistant-view.tsx` — `CreateCardDialog` + card draft
- `apps/web/src/features/opening/shell/opening-shell.tsx` — top-bar → `/opening/cards`
- `apps/web/src/features/opening/planning/today-dashboard.tsx` — due count link only
- `apps/web/src/middleware.ts` — `/learn/review*` → `/opening/cards`
- `apps/web/src/features/opening/access-middleware.test.ts` — asserts cards redirect

**Claim note:** “contract + access-middleware” — opening contract dirty diffs (`planning-settings` re-export, `build-course-knowledge` job kind) are **not** DL4. Cards client uses existing `@aistudy/contracts` reviews/SRS schemas (`/api/cards`, `/api/reviews`). No new card tables/APIs; reuses `packages/database` cards + `scheduleReview`.

## Plan checklist

| # | Criterion | Result | Notes |
|---|---|---|---|
| 1 | Fail-first unit: 503 throws (no sample cards); grade retry reuses idempotencyKey; no-mock scan covers new page | **PASS** | `cards-client.test.ts` (503 + identity reuse + real API paths). Contract scan green with `/opening/cards` reachable from `(opening)`. |
| 2 | Create from assistant: snippet → `documentId` as `sourceDocumentId`; edit front/back; empty blocked; failure keeps input | **PASS** | `CreateCardDialog` saves snippet first, then `POST /api/cards`. Empty sides disable submit; error path retains fields + reuses snippet id. Wired via message-actions / message-list / assistant-view. Materials path = tutor answers with provenance (same snippet flow); no separate materials-only UI (matches plan Modify list). |
| 3 | Review page: server due queue; front→reveal→four grades; empty/error/logged-out; no mastery % | **PASS** | `CardReviewView` + page. Labels 忘记/困难/良好/简单 (`ReviewGrade`). No mastery/稳固/percent UI. |
| 4 | Today: due count link only; cards not written into tasks/plan | **PASS** | `{N} 张记忆卡片到期` → `/opening/cards`. Silent fail → count 0. No task/plan mutation. |
| 5 | Naming separate from retest; no grades → learning observations/evidence | **PASS (static)** | Copy separates 记忆卡片 vs 补测. `cards-grade.ts` only `scheduleReview` + card state/events. Handler observation assertion **not re-run** (see below). |
| 6 | Reuse cards repo + SRS; no new card tables/APIs | **PASS** | Client hits `/api/cards` + `/api/reviews` only. Migrations untouched for cards. |
| 7 | Middleware `/learn/review` → `/opening/cards` | **PASS** | middleware + access-middleware.test. |

## Tests re-run

```text
node node_modules/vitest/vitest.mjs run --project unit \
  apps/web/src/features/opening/cards/ \
  apps/web/src/features/opening/access-middleware.test.ts
→ Test Files  2 passed (2)
→ Tests       23 passed (23)

node node_modules/vitest/vitest.mjs run --project contract \
  tests/contract/opening-no-mock.test.ts
→ Test Files  1 passed (1)
→ Tests       4 passed (4)

./node_modules/.bin/tsc -p apps/web/tsconfig.json --noEmit
→ exit 0
```

**Not run**
- `tests/integration/handler/reviews.test.ts` — `OPENING_TEST_DB` / `OPENING_TEST_DATABASE_URL` unset; Vitest handler `globalSetup` refuses without isolated `aistudy_opening_test`. Per accept brief: record as not run. Plan’s “no `opening_learning_observations` from grade” therefore **static-only** this pass (existing reviews.test asserts `learning_events` review rows, not opening observations).
- Browser — not run (user-owned per AGENTS.md).

## Gaps / observations (non-blocking for ACCEPT; fix before verified)

1. **Stale unit:** `apps/web/src/features/opening/shell/navigation.test.ts` still expects `legacyOpeningRedirectPath("/learn/review")` → `/opening/today`. Live helper returns `/opening/cards` (correct for DL4). Re-run of that file: **1 failed**. Update expectations to `/opening/cards` before merge/verified. Claimed cards+middleware scope stays green.
2. Handler reviews regression (observations / old-platform green) not executed this accept window.
3. Opening `packages/contracts` dirty files in the tree are unrelated to DL4; do not attribute them to this slice.

## Recommendation

**ACCEPT** DL4 agent-owned criteria. Do **not** mark verified; do **not** edit `tasks.json`. Fix `navigation.test.ts` and run handler reviews under `OPENING_TEST_DB=1` before ledger close.
