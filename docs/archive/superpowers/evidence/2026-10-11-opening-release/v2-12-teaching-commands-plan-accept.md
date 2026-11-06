# V2-12 Teaching commands — Plan ACCEPT

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Reviewer:** AIstudy Integrator (executor / Grok Bot)  
**Stage:** Plan ACCEPT only — **no product Implement · no ALTER · no commit / push / hermes**  
**Branch:** `feat/opening-release`  
**Tip HEAD:** `3083809f7c29652f6a859a81bd402c486e5e66d1`  
**Verdict:** **ACCEPT**

## Authority / inputs read

| Doc | Role |
|---|---|
| `docs/superpowers/plans/ai-led-learning-v2/v2-12-teaching-commands-understand.md` | Understand (full) |
| `docs/superpowers/plans/ai-led-learning-v2/v2-12-teaching-commands-plan.md` | Plan under review (full) |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-12-teaching-commands-plan-implement.md` | Claim / plan-stage evidence |
| `docs/superpowers/plans/opening-release/review-test-gates.md` | Gates |
| `docs/superpowers/plans/ai-led-learning-v2/plan.md` §V2-12 + §6.3 | Authority |
| `docs/superpowers/plans/ai-led-learning-v2/tasks.json` V2-12 | Task (status `proposed`) |
| PM frozen defaults (steering) | No DDL; rewrite same-txn; why assist-only; path_version on skip/branch/return; log 32 / stack 16; generate_in_flight→CONFLICT; forbid LWW; local ask/rewrite/skip/branch; recoverable side path |

## Tip / tree verification

```text
$ git rev-parse HEAD
3083809f7c29652f6a859a81bd402c486e5e66d1

$ git branch --show-current
feat/opening-release

$ git log -1 --oneline
3083809 feat(opening): V2-11 intervention preference-controls UI

$ ls packages/database/src/migrations/*.sql | tail -3
0054_opening_teaching_content.sql
0055_opening_compile_teaching_unit_job.sql
0056_opening_intervention_settings.sql

$ test ! -f apps/web/src/features/opening/teaching/command-service.ts \
  && test ! -f packages/contracts/src/opening/teaching-commands.ts \
  && echo absent
absent

$ ls packages/database/src/migrations/0057* 2>/dev/null || echo 'no 0057 migr'
no 0057 migr
```

**Result:** tip matches required `3083809`. Product command files **absent**. Migrations tip ends **0056**; **no** invented `0057`. Plan/understand/claim evidence are untracked docs only (expected at Plan stage).

## Stronger review (spot-check vs tip)

### 1. ActivitySpec publish CAS (V2-05)

- `opening-teaching-content.ts` `publishActivitySpec`: `FOR UPDATE`, `expectedVersion` match, soft-idempotent sameSpecGraph, CONFLICT on stale / race — **confirmed**.
- Plan §3.1 rewrite txn reuses this pattern: lock activity → library `updateDocument(expectedRevisionNumber)` → pin spec + bump `content_version` in **one txn** — **aligned**.

### 2. Library revision CAS

- `library.ts` `updateDocument({ expectedRevisionNumber })` CONFLICT when revision drifted — **confirmed**.
- Plan forbids in-place mutate of old revision rows; rewrite appends N+1 — **aligned** with PM lock.

### 3. TeachingWorkspace / nest

- Tip has `teaching-workspace.tsx`, `block-renderer.tsx`, `component-catalog.ts`, clientInit via `teaching-content-service.getClientInit` — **confirmed**.
- Plan nests POST commands under activity API + Experience affordances on workspace; rejects parallel chat product — **aligned**.
- Experience UI half correctly **not** in Data Implement; awaits Plan ACCEPT + separate Experience slice / PM — **aligned**.

### 4. V2-05 drafts / redact / clientInit

- `saveDraftAnchors` + `draft_anchor_lost`; `redactBlocksForClientInit` — **confirmed**.
- Plan T6/T7/T17 require draft preserve, explicit lost mismatch, redact after rewrite — tests cannot pass without real CAS/draft behavior.

### 5. path_version / checkpoint (no DDL)

- `0053_opening_teaching_activities.sql`: `path_version INTEGER NOT NULL DEFAULT 1`, `checkpoint_json JSONB`, `client_key` — **already present**.
- Plan activates `path_version` for skip/branch/return via existing column + checkpoint keys (`branchStack`, `commandLog`, `currentBlockId`, `skippedBlockIds`) — **no new column/table**.

### 6. Intervention non-conflict (V2-11)

- Checkpoint already holds `interventionPrefs` / `interventionDecisions` / `drafts`; `mergeSessionInterventionPrefs` preserves other keys — **confirmed**.
- Plan requires `mergeCheckpointPreservingPrefs` + T15; commands not gated by quiet/proactive — **aligned**.

### 7. generate_in_flight + clientKey patterns

- `generateStatus` includes `queued`/`generating` with fence helpers — **confirmed**.
- Plan: rewrite → `CONFLICT` `generate_in_flight`; skip/branch/return allowed — **matches PM freeze**.
- Existing soft-idempotent `clientKey` patterns (tutor/assistant/learning) inform command log replay; Plan scopes command keys to checkpoint ring (not create `client_key` column) — sound.

### 8. plan.md / tasks.json scope

- §V2-12: bind activityId+blockId+contentVersion; why/rephrase/expand/example/skip/branch/return; new Revision; clientKey+expectedVersion; no LWW; recoverable same-activity branch — **Plan covers all**.
- §6.3 sketch lists next/skip/rephrase/expand/branch/return; Plan adds `why`/`example` per §V2-12 — acceptable expansion within task scope.
- Acceptance: change route without losing content; branch = recoverable same-activity path — encoded in rules 4–7 + T4–T12.

## PM frozen defaults checklist

| Frozen default | Plan location | Match? |
|---|---|---|
| No DDL | §4 Migration needed: **NO** | YES |
| Rewrite = same-txn new Revision + bump `content_version` | §1.3 r3, §3.1 | YES |
| `why` assist-only (no body / version bump) | §1.4, open Q3, T16 | YES |
| `path_version` on skip/branch/return | §1.4, §3.2–3.3 | YES |
| commandLog max 32 / branchStack max 16 | §1.3 r6, open Q8, T11 | YES |
| rewrite + generate_in_flight → CONFLICT | §1.3 r9, T13 | YES |
| Forbid LWW (CAS) | §1.3 r8, §3.4, T2/T12 | YES |
| Local ask/rewrite/skip/branch; recoverable side path | Concepts + rejected alts + T10 | YES |

## Migration stance (M1 claim)

**HOLD: no new migration number.**

- Plan default = checkpoint_json only; **rejects** new `opening_teaching_commands` table and new activity columns for M1.
- No silent DDL in Plan file list (§12); no `0057` invented; placeholder `00xx` only if PM later flips to audited table (Integrator assigns).
- Tip migrations end **0056_opening_intervention_settings.sql** — verified on disk.
- **Claim M1 no new migr: CONFIRMED.**

## Tests cannot pass without required behavior

| Requirement | Tests that force it |
|---|---|
| CAS / no LWW | T2 stale version; T3 clientKey intent; T12 dual-client |
| New Revision (not mutate old) | T4 read old N unchanged; T5 pin + bump same txn |
| Recoverable branch | T10 push/pop restore cursor; empty → `branch_stack_empty`; T11 cap 16 |
| Skip ≠ wrong-answer | T8 no observation insert; T9 path_version only |
| Draft / prefs preserve | T6/T7/T15 |
| generate_in_flight | T13 |
| why non-mutate | T16 |

Plan-stage: all T1–T18 **`not_run`** (correct). No greenwashing possible at Plan gate.

## Soft gaps (non-blocking; for Implement / Experience)

1. **M1 rewrite body** = server structured clone+note stub; full LLM rewrite deferred to V2-07 job without envelope change — Implement must keep HTTP `prompt`-only (no client HTML `blocksPatch`).
2. **Experience command chrome** still awaits separate Experience Implement after contracts stable (Plan §6) — not Data scope.
3. **Command-log soft-idempotent** after ring eviction (32) may miss replay — acceptable M1; document in Implement evidence if edge hit.
4. **Optional `expectedPathVersion`** — omitters can race on path-only edits; content CAS still required; OK if clients send path CAS when available.
5. **`return` blockId optional** — keep Zod/`assertCommandAllowed` consistent at Implement.
6. **plan.md §6.3 `next`** not in V2-12 kind enum — out of scope / later; Plan correctly limits to seven kinds from §V2-12.

None of the above contradict PM locks or force DDL.

## Gate compliance

| Gate | This Accept |
|---|---|
| Stronger review vs plan/understand/PM | Done |
| Tip / SHA named | `3083809` |
| Re-run Implement tests | **N/A** — Plan stage; no product code; T1–T18 remain `not_run` |
| Self-ACCEPT of Implement | N/A (Plan ACCEPT only) |
| Push / hermes | **Not done** |
| Commit | **Not done** |

## Verdict

**ACCEPT** Plan `v2-12-teaching-commands-plan.md` at tip `3083809`.

- Migr: **none** (M1 claim holds).
- Ready for separate Data Implement after this Accept (contracts → domain → command-service CAS → route → T1–T18).
- Experience UI remains deferred.
- This Accept does **not** authorize ALTER, product code, commit, push, or hermes.

## Soft gaps (one line)

M1 rewrite stub + Experience UI deferred + commandLog ring eviction soft-idempotent edge + optional path CAS + no `next` kind — none block ACCEPT / none need DDL.
