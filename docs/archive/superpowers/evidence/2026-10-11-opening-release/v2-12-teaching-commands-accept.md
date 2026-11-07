# V2-12 Teaching commands — Implement ACCEPT

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Reviewer:** AIstudy Integrator (executor / Grok Bot)  
**Stage:** Independent Implement ACCEPT (Data half; no Experience UI)  
**Branch:** `feat/opening-release`  
**Tip HEAD (dirty product tree, no commit):** `3083809f7c29652f6a859a81bd402c486e5e66d1` (`3083809`)  
**Verdict:** **ACCEPT**

## Authority / inputs

| Doc | Role |
|---|---|
| `docs/superpowers/plans/opening-release/review-test-gates.md` | Gates |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-12-teaching-commands-plan-accept.md` | Plan ACCEPT |
| `docs/superpowers/plans/ai-led-learning-v2/v2-12-teaching-commands-plan.md` | Plan |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-12-teaching-commands-implement.md` | Implement claim |
| PM locks | no DDL; rewrite same-txn Revision+content_version; why assist-only; path_version on skip/branch/return; commandLog 32 / branchStack 16; generate_in_flight→CONFLICT; forbid LWW; local ask/rewrite/skip/branch; recoverable side path |

## Tip / dirty tree

```text
$ git rev-parse HEAD
3083809f7c29652f6a859a81bd402c486e5e66d1

$ git branch --show-current
feat/opening-release

$ git log -1 --oneline
3083809 feat(opening): V2-11 intervention preference-controls UI

$ ls packages/database/src/migrations/0057* 2>/dev/null || echo 'no 0057'
no 0057
```

**Dirty (expected; no commit):** contracts/domain/database teaching-commands (+tests), command-service, POST `…/activities/[id]/commands` route, index/runtime exports. **No** TeachingWorkspace chrome diff. Migrations tip remains **0056**.

## Stronger review

### 1. Contracts / domain / repo / command-service / route

| Surface | Finding |
|---|---|
| `packages/contracts/src/opening/teaching-commands.ts` | 7 kinds; strict request; conflict codes incl. `generate_in_flight` / `draft_anchor_lost` / CAS codes; log max **32** / stack max **16**; rewrite vs path kind helpers — **aligned** |
| `packages/domain/src/opening/teaching-commands.ts` | `mergeCheckpointPreservingPrefs` (keeps prefs/decisions/drafts); push/pop + cap 16; `classifySkipSideEffects` locked `writesObservation:false`; `assertCommandAllowed` rewrite→`generate_in_flight`, return empty→`branch_stack_empty`, `block_not_in_spec`; fingerprint + soft-idempotent lookup; structured rewrite stub; why assist — **aligned** |
| `packages/database/src/repositories/opening-teaching-commands.ts` | `FOR UPDATE` + `expectedVersion`/`expectedPathVersion` CAS; soft-idempotent clientKey; rewrite → `library.updateDocument(expectedRevisionNumber)` + pin spec + bump `content_version` same txn; skip/branch/return → `path_version++` only; why no content/path bump; no observation writes; never LWW — **aligned** |
| `apps/web/src/features/opening/teaching/command-service.ts` | Thin parse + `assertOwned` + execute; maps NOT_FOUND/VALIDATION/CONFLICT — **aligned** |
| `apps/web/src/app/api/opening/teaching/activities/[id]/commands/route.ts` | POST only; 200 success / **409** structured conflict; Cache-Control no-store — **aligned** |
| Exports | contracts/domain/database index + `getTeachingCommandService` in runtime — **present** |

### 2. Hard locks

| Lock | Result |
|---|---|
| No new migration / no DDL | **Confirmed** — no `0057`; tip migrations end `0056_opening_intervention_settings.sql` |
| CAS / forbid LWW | Stale version returns conflict with **zero** activity/library UPDATE; update WHERE includes `content_version` (and path CAS when path bump) |
| `generate_in_flight` → CONFLICT | Rewrite kinds gated; skip/branch/return allowed at domain gate |
| Recoverable branch | Same-activity `branchStack` push/pop; empty → `branch_stack_empty` |
| why assist-only | Assist projection + commandLog; no library / content_version bump |
| path_version on skip/branch/return | Confirmed in repo paths |
| No Experience UI | `teaching-workspace.tsx` / preference-controls **untouched**; only Data `command-service` + route |

### 3. Tests not loosened

- Focused unit assertions remain strict (T1–T3, T8–T11, T13–T16 behaviors).
- No `it.skip` / `.only` in the three claimed files.
- One **documenter** stub exists: `expect(true).toBe(true)` under “DB-dependent seams” listing T4/T5/T6/T7/T12/T17/T18 — **not** treated as a behavioral pass; soft gaps stay **`not_run`** (honest). Does **not** loosen product assertions.

### 4. Soft gaps / `not_run` (honest)

| ID | Status | Reason |
|---|---|---|
| T4 | **not_run** | New library revision + old bytes unchanged — needs real DB / library rows |
| T5 | **not_run** | Rewrite bumps content_version + pins spec same txn — needs DB |
| T6 (full) | **not_run** | Draft survive across real rewrite txn — domain helper covered; DB path not |
| T7 (full) | **not_run** | `draft_anchor_lost` on rewrite — domain helper covered; DB rewrite not exercised |
| T12 | **not_run** | Dual-client rewrite race — needs DB |
| T17 | **not_run** | clientInit redact after rewrite — needs DB + revision body |
| T18 | **not_run** | Route auth other-owner — needs HTTP/handler env |

Plan-required browser/E2E not in Data half scope; Experience UI deferred — does **not** block this Data ACCEPT.

## Independent re-runs (Integrator)

### Vitest (exact claim commands)

```text
$ PATH="./node_modules/.bin:$PATH" bash scripts/run-heavy.sh vitest run \
    packages/contracts/src/opening/teaching-commands.test.ts \
    packages/domain/src/opening/teaching-commands.test.ts \
    packages/database/src/repositories/opening-teaching-commands.test.ts

 Test Files  3 passed (3)
      Tests  27 passed (27)
   Duration  ~2.4s
exit 0
```

### Typecheck

```text
$ PATH="./node_modules/.bin:$PATH" bash scripts/run-heavy.sh tsc -p packages/contracts/tsconfig.json --noEmit
exit 0

$ PATH="./node_modules/.bin:$PATH" bash scripts/run-heavy.sh tsc -p packages/domain/tsconfig.json --noEmit
exit 0

$ PATH="./node_modules/.bin:$PATH" bash scripts/run-heavy.sh tsc -p packages/database/tsconfig.json --noEmit
exit 0
```

## Soft gaps (one line)

M1 rewrite stub + Experience UI deferred + commandLog/replay ring eviction soft-idempotent edge + nested library txn DB paths T4/T5/T6-full/T7-full/T12/T17/T18 **not_run** + documenter `expect(true)` bookmark (non-behavioral) — none force REJECT / none need DDL.

## Forbidden actions (this Accept)

- **No** push / hermes / commit / stash / reset  
- **No** migrate / DDL  
- **No** product fix (would REJECT instead)  
- **No** Experience UI required or added  

## Verdict

**ACCEPT** Data Implement of V2-12 Teaching commands at dirty tip `3083809`.

- Required runnable checks re-run green (vitest 3/27; tsc contracts/domain/database exit 0).  
- Soft gaps honestly **`not_run`**.  
- CAS / no LWW / no DDL / generate_in_flight CONFLICT / recoverable branch / why assist-only hold under stronger review.  
- Experience command chrome remains a separate slice.
