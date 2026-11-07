# Q01-prep — Understand: Cross-module negative and concurrency tests

**Date:** 2026-10-10 ~01:04 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release`  
**Owner (ledger):** QA  
**Plan source:** `docs/superpowers/plans/opening-release/08-delivery.md` §Q01  
**Gate:** Prep / Understand only — **no IMPLEMENT**, **no** `tasks.json` status change  
**PM:** authorized for read-only prep docs this pass

## Restatement

Q01 proves the opening release survives **unauthorized access**, **cross-principal isolation**, **concurrency races**, and **fault recovery** across modules — with zero unauthorized reads/writes in the tested cases. It is a QA gate on isolated services (handler/integration/contract), reusing the F03 `createOpeningFixture` helper (`requestAnonymous`, `otherScope`). Backup privacy assertions run against a **completed Q03** implementation before Q01 can be marked verified.

**Done when (full Q01 — not this prep):** Create-list red→green tests exist and pass on isolated services; complete saved flow asserts real DB rows/versions; fault + regression cases land; unit/contract/handler/integration gates green; backup checks against **completed** Q03. This prep pass only inventories and plans.

## What §Q01 requires (checklist paraphrase)

| Bullet | Intent |
|---|---|
| Write failing acceptance first | e.g. anonymous `GET /api/opening/memory` → **401** via `requestAnonymous` (no cookie; no test headers that alter prod auth) |
| Two-principal cases | Real cross-owner isolation for sources, conversations, memory, learning, plans |
| Complete saved flow | upload → parse → tutor → observation → memory proposal/confirm → plan proposal/accept → retest; assert DB rows + versions, not only HTTP 200 |
| Fault cases | lost reply after commit; worker crash before/after model; stale plan accept; deletion during writeback; MIME spoof; source prompt injection; unconfigured provider; budget exhaustion; every bugfix tied to failure ID |
| Gates + backup | unit/contract/handler/integration on isolated services; **backup checks require completed Q03** before Q01 verified |

**Create:**  
`tests/integration/handler/opening-loop.test.ts`,  
`tests/integration/opening-concurrency.test.ts`,  
`tests/integration/opening-failure-recovery.test.ts`,  
`tests/contract/opening-safety-boundaries.test.ts`

**Modify:** `tests/integration/opening-backup-privacy.test.ts` (Q03 creates it before this task).

## DependsOn status (`tasks.json` — read-only snapshot)

| Dep | Status | Notes |
|---|---|---|
| U03 | **verified** | |
| DL3 | **verified** | transactional retest enqueue / `retestId`-bound attempts (complete-flow plan→retest) |
| DL6 | **verified** | reference self-check (observation verdict path) |
| DL7 | **verified** | readiness + effective daily cap (unconfigured provider / budget fault cases) |
| DL10 | **verified** | local isolated-service runner on Windows/dev |
| Q03 | **active** (not verified) | packaging + backup/restore still open; **blocks Q01 verified** |
| **Q01** | **planned** | leave planned; evidence `[]` — do not flip |

Dependency note from plan (2026-10-08 user-approved): complete-flow plan→retest needs DL3; observation verdict checks need DL6; unconfigured provider / budget exhaustion use DL7; handler/integration on isolated services follow DL10.

## Blocked items (honest)

1. **Backup vs completed Q03** — §Q01: “Backup checks run against completed Q03 implementation before Q01 can be verified.” Q03 is still **`active`**. Partial backup/privacy tests and CLI restore slices exist under Q03 evidence, but Q03 is **not** completed/verified. Prep may inventory and propose Modify scope for `opening-backup-privacy.test.ts`; **must not** claim Q01 backup gate green or mark Q01 verified.
2. **Docker packaging** — Q03 Create-list Dockerfiles/compose are scaffolded; packaging gates evidence records **no image build / no compose up / no packaging-green claim**. This prep makes **no Docker claims**. Full packaging green is Q03’s job and still blocks treating Q01 as fully unblocked for verified.
3. **Q01 Create-list files** — 4 of 5 Create paths are **missing**; only Modify-target `opening-backup-privacy.test.ts` **exists** (see `q01-prep-coverage.md`). Scattered related auth/race/failure tests exist elsewhere but are **not** the Q01 Create-list gate files.
4. **No green / verified claim this pass** — docs + inventory only; red skeleton documented in markdown (optional `q01-prep-red-skeleton.md`); no CI-breaking stubs committed.

## In scope (this prep)

- Understand / Plan / Coverage / optional red-skeleton markdown under `docs/superpowers/evidence/2026-10-10-opening-release/`.
- Inventory existing tests vs Create list; map partial related coverage and gaps.
- Document READY_FOR_PM_REVIEW gate for prep docs before any later IMPLEMENT.

## Out of scope (this prep)

- Editing `tasks.json` Q01 `status` / `dependsOn` / `evidence` (leave **planned**).
- Marking Q01 active or verified.
- Touching hermes / redeploy / apps product code.
- Editing `15-research-hardening.md` or Q03 ledger / Q03 evidence.
- Commit / push (Integrator owns).
- Claiming Docker packaging green or Q03 completed.
- IMPLEMENT of Create-list tests (deferred until Plan accepted and Q03 allows backup-bound verification path).

## Success criteria (this prep only)

A reviewer can open the four prep docs and see: what Q01 is; dependsOn honesty (U03/DL* verified, Q03 active); Create-list exists vs missing counts; blockers; and a plan that stops at READY_FOR_PM_REVIEW without flipping ledger status.
