# T01 / U01 verified — 2026-09-16

Repo: `E:/Project/study-assistant-opening`; branch `feat/opening-release`. LOCAL-ONLY.
Executed by `xhh/gpt-5.6-luna-fast` workers (`mu3zkybe-edeb3fe2` T01; `mu3zkybf-294c07c8` U01 timed out mid-run, files audited and completed by lead). Test DBs: `aistudy_opening_test` (integration) and `aistudy_opening_e2e` (browser) on portable PG 17.5 at 127.0.0.1:5433.

## 1) T01 → verified (provider adapter, budget ledger, usage)

Files: `packages/ai/src/opening/{provider,errors,usage}.ts` (+tests), `apps/worker/src/runtime/budgeted-call.ts` (+test), additive `packages/ai/src/index.ts`, `packages/config/src/env.ts`, `packages/database/src/repositories/opening-budget.ts` (settle/markUnknown ledger extension), `tests/integration/opening-budget.test.ts`.

Lead corrections to worker output (evidence chain):
1. `markUnknown` had set state='completed' (frees cap space); fixed to RETAIN the reservation ('reserved') — unknown remote outcomes must keep counting against the cap until reconciliation. Covered by integration test "an unknown post-send outcome retains the reservation".
2. `release/complete` signatures restored to the committed requestId contract; settle/markUnknown address by reservationId.
3. `budgeted-call` error matching switched from message sniffing to error codes (PROVIDER_TIMEOUT/PROVIDER_NETWORK → markUnknown; definitive outcomes → release).
4. Added missing coverage: provider-level 401/429/500 classification, abort→PROVIDER_TIMEOUT retryable, budgeted-call unit tests (disabled/pre-send/unknown paths), guarded budget integration suite.

```text
$ node node_modules/vitest/vitest.mjs run --project unit packages/ai/src/opening apps/worker/src/runtime
Test Files  4 passed (4)   Tests  13 passed (13)
$ OPENING_TEST_DB=1 ... vitest run --project integration tests/integration/opening-budget.test.ts tests/integration/opening-foundation.test.ts
Test Files  2 passed (2)   Tests  10 passed (10)
$ npx tsc -p packages/ai/tsconfig.json --noEmit && npx tsc -p apps/worker/tsconfig.json --noEmit → clean; eslint touched files → clean
```

Real-model quality/cost remains Q02; provider here is protocol-only (no network calls made).

## 2) U01 → verified (opening shell, three entries, legacy masquerade prevention)

Files: `apps/web/src/features/opening/shell/{navigation,opening-shell,empty-state}.ts(x)` (+navigation.test), `(opening)/opening/{layout,today,assistant,courses,courses/[id]}`, bounded `app/page.tsx` + `middleware.ts` branches, `tests/e2e/opening-{shell,release-redirects}.spec.ts`, `tests/e2e/opening-auth.ts`.

Lead corrections: JSX bug (missing `{` rendered literal "currentCourse}"), current-course label now conditional; middleware restored to expanded formatting while keeping redirect logic; e2e rewritten to authenticate via seeded owner + `/api/auth/login` (registration is disabled in opening mode).

```text
$ node node_modules/vitest/vitest.mjs run --project unit apps/web/src/features/opening
Test Files  11 passed (11)   Tests  44 passed (44)
$ E2E_DATABASE_URL=... vitest playwright: tests/e2e/opening-shell.spec.ts
4 passed (nav at 390x844 & 1440x900, honest empty state, keyboard Tab/Enter flow, server login gate)
$ ... OPENING_RELEASE=1: tests/e2e/opening-release-redirects.spec.ts
2 passed (root → /opening/today for owner; /learn /explore /preview/* redirect — no mock masquerade)
```

Deferred (documented, non-blocking): long-label overflow assertion and rendered-screenshot capture; both are UX hardening for U03/Q02.

## 3) Cross-cutting defect found and fixed: F01 CSRF middleware vs browser suite

The F01 middleware requires a same-origin Origin header on cookie-auth mutations; Playwright's APIRequestContext does not send one. Empirically proven against a production server (no-Origin POST → 403, with-Origin → reaches login). This broke ALL existing e2e API flows on the branch (browser gate had never run since F01 — same class as the baseline gap found in the F01/F03 run).

Fix: 47 `request.post` call sites across 17 spec files now send `headers: { origin: baseURL ?? "http://127.0.0.1:3000" }` (three helper-scoped sites use the literal). Regression proof: `tests/e2e/free-exploration.spec.ts` 2 passed (register 201 → exploration flow) after the fix; its pre-existing strict-mode selector ambiguity ("Alternative path" matched option + button) also fixed to `getByRole("button", ...)`.

## 4) Final full-gate sweep

```text
$ node node_modules/vitest/vitest.mjs run --project unit
Test Files  136 passed (136)   Tests  644 passed (644)
$ npm run typecheck → TYPECHECK_EXIT=0 ; npx tsc -p tsconfig.e2e.json --noEmit → clean ; eslint touched areas → clean
```
