# V2-12 Teaching commands — Implement Evidence

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Data implementer (executor / Grok Bot)  
**Branch:** `feat/opening-release`  
**Tip HEAD (baseline; dirty tree, no commit):** `3083809f7c29652f6a859a81bd402c486e5e66d1` (`3083809`)  
**Status:** **implemented, awaiting Integrator Implement ACCEPT** — do **not** self-ACCEPT; `tasks.json` not marked verified  
**Hard rules held:** No DDL / no new migration · No Experience UI · No push / hermes / stash / reset / commit · Exclusive tree

## Authority followed

- Plan ACCEPT: `docs/superpowers/evidence/2026-10-11-opening-release/v2-12-teaching-commands-plan-accept.md`
- Plan: `docs/superpowers/plans/ai-led-learning-v2/v2-12-teaching-commands-plan.md`
- Understand: `docs/superpowers/plans/ai-led-learning-v2/v2-12-teaching-commands-understand.md`
- PM defaults: no DDL; rewrite same-txn new Revision; why assist-only; path_version on skip/branch/return; commandLog 32 / branchStack 16; generate_in_flight→CONFLICT; forbid LWW
- Gates: `docs/superpowers/plans/opening-release/review-test-gates.md`
- Reuse: V2-04 activities (`content_version`/`path_version`/`checkpoint_json`), V2-05 teaching-content (ActivitySpec pin, getClientInit, drafts), library `updateDocument` CAS, V2-11 checkpoint keys (disjoint)

## Diff scope

### New

| Path | Role |
|---|---|
| `packages/contracts/src/opening/teaching-commands.ts` | Request/response/conflict schemas; kinds; log/stack caps; rewrite/path helpers |
| `packages/contracts/src/opening/teaching-commands.test.ts` | T1 contract tests |
| `packages/domain/src/opening/teaching-commands.ts` | `mergeCheckpointPreservingPrefs`, branch push/pop, skip side-effects lock, assertCommandAllowed, intent fingerprint, structured rewrite stub, why assist |
| `packages/domain/src/opening/teaching-commands.test.ts` | T3/T6–T8/T10/T11/T13–T16 domain unit |
| `packages/database/src/repositories/opening-teaching-commands.ts` | CAS command executor (why/rewrite/skip/branch/return); soft-idempotent clientKey; no observation writes |
| `packages/database/src/repositories/opening-teaching-commands.test.ts` | T2/T3/T8/T9/T10/T13–T16 repo unit (mock sql) |
| `apps/web/src/features/opening/teaching/command-service.ts` | Thin Data service |
| `apps/web/src/app/api/opening/teaching/activities/[id]/commands/route.ts` | POST commands route (Plan path) |

### Updated

| Path | Change |
|---|---|
| `packages/contracts/src/opening/index.ts` | Export teaching-commands |
| `packages/domain/src/index.ts` | Export teaching-commands domain API |
| `packages/database/src/index.ts` | Export teaching-commands repository |
| `apps/web/src/features/opening/runtime.ts` | `getTeachingCommandService` |

### Explicitly not touched

- **No** Experience command buttons / TeachingWorkspace chrome
- **No** new migration SQL / **no** `0057` (tip remains **0056_opening_intervention_settings.sql**)
- **No** learning observation rewrite for skip
- **No** preference-controls UI
- No push / commit / hermes / stash / reset / self-ACCEPT
- Unrelated untracked evidence / plan docs left as-is

## Behavior landed

| Kind | Behavior |
|---|---|
| `why` | Assist-only projection; appends `commandLog`; **no** content/path/revision bump |
| `rephrase` / `expand` / `example` | Same txn: library `updateDocument(expectedRevisionNumber)` → new Revision; pin ActivitySpec `revision_number` + bump `content_version`; preserve drafts; `generate_in_flight` → CONFLICT |
| `skip` | Checkpoint `skippedBlockIds` + cursor; **path_version++** only; **no** observation/incorrect write |
| `branch` | Push `checkpoint_json.branchStack` (max 16); path_version++; same activity |
| `return` | Pop stack; restore cursor; path_version++; empty → `branch_stack_empty` |
| CAS | `expectedVersion` (=content_version) required; optional `expectedPathVersion`; soft-idempotent same `clientKey`+intent → replay; mismatch → `client_key_intent_mismatch`; **never LWW** |
| Checkpoint keys | V2-12: `branchStack`, `commandLog`, `currentBlockId`, `skippedBlockIds` (+ internal `commandReplay`); preserves `interventionPrefs` / `interventionDecisions` / `drafts` |
| API | `POST /api/opening/teaching/activities/{id}/commands` — 200 success / 409 structured conflict body |

## Tests T1–T18

| ID | Status | Where / note |
|---|---|---|
| T1 | **pass** | `packages/contracts/src/opening/teaching-commands.test.ts` |
| T2 | **pass** (unit mock) | stale `expectedVersion` → `stale_content_version`; no activity/library mutate |
| T3 | **pass** | domain fingerprint + repo soft-idempotent replay / intent mismatch |
| T4 | **not_run** | Rewrite creates new library revision + old bytes unchanged — needs real DB / library rows |
| T5 | **not_run** | Rewrite bumps content_version + pins spec in one txn — needs DB |
| T6 | **pass** (domain) / **not_run** (DB rewrite path) | Draft survival helper unit-tested; full rewrite+draft preserve needs DB |
| T7 | **pass** (domain) / **not_run** (DB) | `draftsSurvivingBlockIds` lost ids; repo returns `draft_anchor_lost` when lost — DB rewrite not exercised |
| T8 | **pass** | `classifySkipSideEffects` + skip path asserts no observation table writes |
| T9 | **pass** (unit mock) | skip updates skippedBlockIds + path_version; content_version unchanged |
| T10 | **pass** | domain push/pop; repo empty return → `branch_stack_empty`; full push+return restore needs DB for persistence assert |
| T11 | **pass** | domain branch stack cap 16 |
| T12 | **not_run** | Dual-client rewrite race — needs DB |
| T13 | **pass** | domain + repo: generating + rephrase → `generate_in_flight`; skip allowed at gate |
| T14 | **pass** | `block_not_in_spec` |
| T15 | **pass** | merge preserves interventionPrefs/Decisions/drafts (domain + skip write payload) |
| T16 | **pass** | why assist; no library / content_version bump |
| T17 | **not_run** | clientInit redact after rewrite — needs DB + real revision body |
| T18 | **not_run** | Route auth other-owner — needs HTTP/handler env |

## Commands run + results

### Tip

```text
$ git rev-parse HEAD
3083809f7c29652f6a859a81bd402c486e5e66d1

$ git branch --show-current
feat/opening-release

$ ls packages/database/src/migrations/0057* 2>/dev/null || echo 'no 0057'
no 0057
```

### Unit (focused)

```text
$ PATH="./node_modules/.bin:$PATH" bash scripts/run-heavy.sh vitest run \
    packages/contracts/src/opening/teaching-commands.test.ts \
    packages/domain/src/opening/teaching-commands.test.ts \
    packages/database/src/repositories/opening-teaching-commands.test.ts

 Test Files  3 passed (3)
      Tests  27 passed (27)
   Duration  ~2.5s
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

### Integration / DB / HTTP

```text
T4 T5 T6(full) T7(full) T12 T17 T18 → not_run (no OPENING_TEST_DB / handler project exercised this slice)
```

## Soft gaps

1. M1 rewrite body = structured clone + `rewriteOf` note on target block (HTTP carries `prompt` only; no client HTML `blocksPatch`). Full LLM rewrite deferred to V2-07 job without envelope change.
2. Soft-idempotent replay after commandLog ring eviction (32) may miss — acceptable M1; replay map also capped ~32.
3. Experience command chrome deferred (separate Experience Implement).
4. Nested `library.updateDocument` inside activity txn relies on postgres.js savepoint nesting; unit mock flattens begin — production DB path for T4/T5 still `not_run`.
5. Route returns HTTP 409 for structured `ok:false` conflict bodies (success 200).

## Forbidden actions (confirmed not done)

- No self-ACCEPT / no `tasks.json` → verified  
- No commit / push / hermes / stash / reset  
- No DDL / no migration `0057`  
- No Experience UI  
