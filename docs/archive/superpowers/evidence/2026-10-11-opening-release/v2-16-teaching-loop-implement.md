# V2-16 Teaching loop — Implement Evidence (Integrator/QA)

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Integrator / QA (executor / Grok Bot)  
**Branch:** `feat/opening-release`  
**Baseline tip (assignment / Plan ACCEPT):** `74ba005b999c5d8f3c4269b9a3ed1162e6cc3071` (`74ba005`)  
**Tip HEAD at Implement write (dirty; no commit):** `74ba005b999c5d8f3c4269b9a3ed1162e6cc3071` (`74ba005`) — **exact match**; product/test changes uncommitted only  
**Status:** **implemented, awaiting Data independent Implement ACCEPT** — do **not** self-ACCEPT; `tasks.json` not marked verified  
**Hard rules held:** No push / hermes / stash / reset / commit · No DDL / no 0058 · No self-ACCEPT · Integrator ≠ accepter · Prefer no Experience exclusive-tree dual-edit

## Authority followed

- Plan ACCEPT: `docs/superpowers/evidence/2026-10-11-opening-release/v2-16-teaching-loop-plan-accept.md` (**ACCEPT** + PM open-decision locks)
- Plan: `docs/superpowers/plans/ai-led-learning-v2/v2-16-teaching-loop-plan.md`
- Understand: `docs/superpowers/plans/ai-led-learning-v2/v2-16-teaching-loop-understand.md`
- Gates: `docs/superpowers/plans/opening-release/review-test-gates.md`
- PM locks: dual flags for UI trial; synthetic fixture; `real_model=not_run`; L1–L6; five states; DDL NO

## Diff scope

### New

| Path | Role |
|---|---|
| `apps/web/src/features/opening/teaching/teaching-loop-flag.ts` | `isOpeningTeachingLoopEnabled` — `OPENING_TEACHING_LOOP` / `NEXT_PUBLIC_OPENING_TEACHING_LOOP`; default off |
| `apps/web/src/features/opening/teaching/teaching-loop-flag.test.ts` | Unit: default off; truthy `1/true/yes`; OPENING_* preferred over NEXT_PUBLIC_* |
| `tests/integration/opening-teaching-loop.test.ts` | Agent-isolated DB loop L1–L6 + five understandable states; dual flag injection; synthetic ready content |
| `tests/e2e/opening-teaching.spec.ts` | Playwright skeleton; `OPENING_E2E` skip; `pending_user` annotation for full visual script |

### Explicitly not touched

- Experience exclusive UI trees (`today-dashboard.tsx`, empty-state copy polish) — **thin entry guard deferred**; flag exported for sequenced Experience half if needed
- Data contracts/domain exclusive trees — **reuse only**
- AI compiler / provider knobs — **no dual-edit**
- Any migration SQL / inventing `0058`
- push / commit / hermes / stash / reset / self-ACCEPT / `tasks.json` verified flip
- Unrelated untracked evidence (`rp5-gha-…`, `p0-assistant-list-…`) left as-is

## Behavior landed

| Concern | Behavior |
|---|---|
| Flag | Default off; truthy only `1\|true\|yes`; mirrors workspace-flag helper |
| Dual flags | Integration `beforeAll`/`beforeEach` sets **both** `OPENING_TEACHING_LOOP` and `OPENING_TEACHING_WORKSPACE` (+ NEXT_PUBLIC_*) |
| L1 Enter | Activity create + associate-course under fixture workspace/course/sources |
| L2 AI teach | Synthetic unit + `publishActivitySpec` + `getClientInit`; `isTeachingWorkspaceContentUsable` true when ready+blocks; false when queued |
| L3 Local ask | `skip` CAS-ok; stale `expectedVersion` → `stale_content_version` |
| L4 Attempt | Session scoped to teaching `activity_id`; attempt + observation; resume `actualAttempts` lists it |
| L5 Pause/checkpoint | `setStatus(paused)` + `saveCheckpoint`; `interventionPrefs` + `commandLog` preserved |
| L6 Resume | `learningResumeSchema` package; gates owned/materials/job; ≠ `ConversationResume` |
| L7 optional | `openProblems` array present; no invented eligibility |
| States | no-course / model / budget / parse incomplete / source withdrawn asserted (model/budget via ai-readiness helpers; others via services) |
| Fixture | Synthetic + `backupRows` sources; **no new DDL** |
| real_model | **not_run** — never faked green |

## Tests T1–T16 (honest)

| ID | Status | Where / note |
|---|---|---|
| T1 | **pass** | Flag unit + integration dual-injection assert (flag unit ran green) |
| T2–T7 L1–L6 | **not_run** | Integration file present; agent DB `ECONNREFUSED` 127.0.0.1:5432 — no `OPENING_TEST_DB` live postgres on box |
| T8 withdrawn | **not_run** | Same — coded in integration file |
| T9 parse | **not_run** | Same — coded (VALIDATION on admit) |
| T10 L7 optional | **not_run** | Same — openProblems assert in L1–L6 script |
| T11 typecheck | **pass** | `npx tsc -p apps/web/tsconfig.json --noEmit` → OK |
| T12 e2e file | **pass** (presence) | `tests/e2e/opening-teaching.spec.ts` exists |
| T13 browser visual | **pending_user** | Spec annotates full visual script; Playwright not executed this gate |
| T14 real_model | **not_run** | CI does not store live model keys (PM lock); never fake green |
| T15 UX vs learning_effect | **recorded** | UX skeleton ≠ `learning_effect` — remains **unknown** |
| T16 CI pickup | **expect OK** | File under `tests/integration/**/*.test.ts`; no workflow redesign |

### Commands re-run (this Implement)

```text
$ git rev-parse HEAD
74ba005b999c5d8f3c4269b9a3ed1162e6cc3071

$ npx vitest run --project unit apps/web/src/features/opening/teaching/teaching-loop-flag.test.ts
# → 1 file, 3 tests passed

$ npx tsc -p apps/web/tsconfig.json --noEmit
# → OK (exit 0)

$ OPENING_TEST_DB=1 OPENING_TEST_DATABASE_URL=postgres://aistudy:aistudy@127.0.0.1:5432/aistudy_opening_test \
    npm run test:integration -- tests/integration/opening-teaching-loop.test.ts
# → ECONNREFUSED 127.0.0.1:5432 (globalSetup); integration **not_run**

$ test -f tests/e2e/opening-teaching.spec.ts && echo E2E_OK
E2E_OK

$ ls packages/database/src/migrations/*.sql | tail -1
0057_opening_help_exposure_kind.sql
# no 0058

$ date '+%Y-%m-%d %H:%M %Z'
2026-10-11 14:04 CST
```

### not_run (honest)

| Item | Reason |
|---|---|
| Integration L1–L6 + DB states | Agent postgres unavailable (`ECONNREFUSED`); tests written to fixture pattern for Data Accept re-run |
| Playwright live e2e | `OPENING_E2E` / browser not provisioned this gate |
| user_browser full visual | **pending_user** |
| real_model | No live provider secrets; PM: CI does not store keys |
| learning_effect | **unknown** (not claimed) |
| Thin Experience entry guard | Deferred — prefer not dual-edit Experience trees; flag ready for sequenced half |

## Rollback note

Unset / `0` / `false` on `OPENING_TEACHING_LOOP` → trial gate off; user content/checkpoint/attempts retained (compose tip modules; no parallel loop tables).

## Handoff

**Ready for AIstudy Data independent Implement ACCEPT** (Integrator ≠ accepter).  
Data should re-run flag vitest + integration against agent-isolated `aistudy_opening_test` when DB is up; confirm e2e file presence; list remaining `not_run` honestly; do **not** flip `tasks.json` verified until Accept completes.
