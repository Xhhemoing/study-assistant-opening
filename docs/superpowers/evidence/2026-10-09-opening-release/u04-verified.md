# U04 Capabilities UI — verified (Integrator)

**Date:** 2026-10-09 ~19:30 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release` @ `a9b87cb` (+ uncommitted U04 Experience slices as already ACCEPTed)  
**Workspace:** `/workspace/study-assistant-opening`  
**Verifier:** AIstudy Integrator (ACCEPT / close; did not re-implement U04 UI)  
**Verdict:** **ACCEPT yes** → **verified**

Plan: `docs/superpowers/plans/opening-release/11-proactive-acceptance.md` § U04.  
Prior accept (kept): [`u04-capabilities-ui-accept.md`](./u04-capabilities-ui-accept.md) — Create/Modify + unit 11/5 + tsc; browser was the remaining gate.

## ACCEPT checklist vs § U04

| # | Criterion | Result | Notes |
|---|---|---|---|
| 1 | Browser fail test written (`等待授权` + fixture) | **PASS** | `tests/e2e/opening-capabilities.spec.ts` + `opening-capability-fixture.ts` |
| 2 | Create files present (connections / knowledge / action-digest / media-reader / page / e2e+fixture) | **PASS** | All plan Create paths on disk |
| 3 | Connections: scopes/sync/error/pause/revoke; no secret echo; clear after submit; manual ≠ auto | **PASS (prior accept + code)** | See accept note |
| 4 | Course: chapters + next step first; expandable knowledge; evidence targets | **PASS (prior accept + code)** | |
| 5 | Media: parse-failed / audio-only / insufficient visual separate; unavailable ≠ sample | **PASS (prior accept + unit)** | |
| 6 | Today ≤3 + one confirm card; accept/modify/reject/basis; no mastery % | **PASS (prior accept + browser)** | Browser asserts no mastery on today/course |
| 7 | Components ≤200 lines; real API / no page.route fake | **PASS (prior accept)** | |
| 8 | Browser e2e green (`npm run test:browser -- tests/e2e/opening-capabilities.spec.ts`) | **PASS ★** | **3 passed / 0 failed** (this pass) |
| 9 | web tsc | **PASS** | `npx tsc -p apps/web --noEmit` exit 0 |
| 10 | Capabilities UI unit | **PASS** | 5 files / 11 tests |

## Re-verify (this pass) — Integrator commands

```text
# ★ Primary gate — browser e2e (E2E DB on 127.0.0.1:5433)
cd /workspace/study-assistant-opening && \
  E2E_DATABASE_URL=postgres://postgres@127.0.0.1:5433/aistudy_opening_e2e \
  npm run test:browser -- tests/e2e/opening-capabilities.spec.ts
# → Running 3 tests using 1 worker
# → ✓ shows authorization failure rather than a working connector
# → ✓ today surfaces action digest without fabricating mastery
# → ✓ course page leads with knowledge chapters not a mastery meter
# → 3 passed (2.5m)

# Cheap gates
npx tsc -p apps/web --noEmit
# → TSC_EXIT=0

node node_modules/vitest/vitest.mjs run --project unit \
  apps/web/src/features/opening/connections/connection-status.test.ts \
  apps/web/src/features/opening/knowledge/course-knowledge.test.ts \
  apps/web/src/features/opening/sources/media-reader.test.ts \
  apps/web/src/features/opening/planning/action-digest.test.ts \
  apps/web/src/features/opening/planning/action-digest-card.test.ts
# → Test Files  5 passed (5)
# → Tests  11 passed (11)
```

Web server for browser gate built/started via Playwright webServer (`next build` in heavy-task); suite completed green.

## Remaining live gaps (do not claim closed)

1. **Plan browser extras** — 390×844 / 1440×900 screenshots, keyboard focus tour, long-title stress, video seek deep link, offline/refresh cross-device screenshots, real mobile file pick — not separately evidenced beyond the 3 e2e cases.
2. **Pause is page-local** — UI `pausedIds` blocks sync requests; not a server-side pause contract (noted in prior accept).
3. **Live connector / school / CAP quality** — U04 UI acceptance does not replace email/model/video quality or Q04 multisource-loop acceptance.
4. **Q04** — still planned; depends on U04.

## Ledger

- `tasks.json` U04 → `verified`
- Evidence array: keep `u04-capabilities-ui-accept.md` + add this `u04-verified.md`
- Commit/push: **not done** (Integrator: do not commit)
