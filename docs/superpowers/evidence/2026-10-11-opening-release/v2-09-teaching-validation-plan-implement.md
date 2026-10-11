# V2-09 Teaching validation — Plan-stage evidence (Understand + Plan only)

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy AI (executor / Grok Bot)  
**Branch:** `feat/opening-release`  
**Tip HEAD:** `f5dae08c4b6d28c0a1a74118d916a9a36fb544e6` (`f5dae08`) — **matches required tip** (includes V2-08 ACCEPT merge)  
**Stage:** Understand → Plan only. **No product Implement. No migrations/ALTER. No push / hermes / stash / reset / commit.**  
**Gates:** `docs/superpowers/plans/opening-release/review-test-gates.md` (list what was read / run; do **not** self-ACCEPT)

## Diff scope (this slice)

### Written (docs only)

| Path | Role |
|---|---|
| `docs/superpowers/plans/ai-led-learning-v2/v2-09-teaching-validation-understand.md` | Understand |
| `docs/superpowers/plans/ai-led-learning-v2/v2-09-teaching-validation-plan.md` | Plan (await ACCEPT) |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-09-teaching-validation-plan-implement.md` | This plan-stage evidence |

### Explicitly not touched

- No `packages/domain/src/opening/teaching-validation.ts`
- No `packages/ai/src/opening/teaching-verifiers.ts`
- No edits to `tutor-turn.ts`, `tutor-policy.ts`, `teaching-compiler.ts`, `teaching-plan.ts`, `teaching-evidence.ts`, `teaching-coverage.ts`, `compile-teaching-unit.ts`, `index.ts`, contracts, or database repos
- No `apps/web` (Experience V2-10 parallel — observed sibling untracked `v2-10-teaching-workspace-understand.md`; not modified)
- No migration SQL under `packages/database/src/migrations/`
- No ALTER / migrate / psql
- No `tasks.json` status → verified / in_progress / planned changes
- No push / hermes / stash / reset / commit
- Unrelated untracked evidence files present in tree were **not** created or modified by this slice:
  - `docs/superpowers/evidence/2026-10-09-opening-release/rp5-gha-91b1c73-typecheck-fail.md`
  - `docs/superpowers/evidence/2026-10-11-opening-release/p0-assistant-list-preview-failsoft-implement.md`

## Tip / branch verification

```text
$ git rev-parse HEAD
f5dae08c4b6d28c0a1a74118d916a9a36fb544e6

$ git branch --show-current
feat/opening-release

$ git log -1 --oneline
f5dae08 feat(opening): V2-08 teaching plan outline + compiler

$ ls packages/database/src/migrations/*.sql | tail -3
packages/database/src/migrations/0053_opening_teaching_activities.sql
packages/database/src/migrations/0054_opening_teaching_content.sql
packages/database/src/migrations/0055_opening_compile_teaching_unit_job.sql

$ test ! -f packages/domain/src/opening/teaching-validation.ts \
  && test ! -f packages/ai/src/opening/teaching-verifiers.ts && echo absent
absent
```

**Result:** tip OK. Migrations tip ends at **0055**. Verification statuses already in **0054**. V2-09 Plan prefers **no DDL**. Proposed modules **absent** (to be created only after Plan ACCEPT + Implement gate).

## Inventory commands / Reads

### Tip confirm

```text
$ git rev-parse HEAD
f5dae08c4b6d28c0a1a74118d916a9a36fb544e6

$ git status --short
?? docs/superpowers/evidence/2026-10-09-opening-release/rp5-gha-91b1c73-typecheck-fail.md
?? docs/superpowers/evidence/2026-10-11-opening-release/p0-assistant-list-preview-failsoft-implement.md
# (plus this slice's docs as they were written; Experience may add v2-10 understand in parallel)
```

**Result:** exit 0 — matches required baseline `f5dae08`. Dirty tree = unrelated untracked + this slice docs (+ optional Experience V2-10 docs); product code not touched.

### Plan §V2-09 + tasks + gates + V2-08 mirror

```text
$ rg -n "V2-09｜对教学内容" docs/superpowers/plans/ai-led-learning-v2/plan.md
$ Read plan.md L505–523
$ Read tasks.json V2-09 (proposed_paths teaching-validation.ts / teaching-verifiers.ts)
$ Read docs/superpowers/plans/opening-release/review-test-gates.md
$ Read v2-08-teaching-plan-understand.md + v2-08-teaching-plan-plan.md
$ Read v2-08-teaching-plan-plan-implement.md (evidence shape)
```

**Result:** scope/reuse/proposed paths/acceptance/rollback aligned with PM assignment; evidence format mirrors V2-08 plan-implement.

### Status enums + migrations (no DDL needed)

```text
$ rg -n "teachingVerificationStatusSchema|structure_ok|verified" packages/contracts/src/opening/teaching-content.ts
$ rg -n "teachingActivityGenerateStatusSchema|needs_check|unknown|ready" packages/contracts/src/opening/teaching-activity.ts
$ Read packages/database/src/migrations/0054_opening_teaching_content.sql (CHECK verification_status)
$ Read packages/database/src/migrations/0053_opening_teaching_activities.sql (CHECK generate_status)
```

**Result:** exit 0 —
- verification: `unchecked|structure_ok|needs_check|verified|rejected|stale`
- generate: includes `needs_check|ready|unknown`
- Structure vs fact can map to `structure_ok` vs `verified` without ALTER.

### V2-08 compile + V2-07 job

```text
$ rg -n "verificationStatus: \"needs_check\"" packages/ai/src/opening/teaching-compiler.ts
$ rg -n "generate_status|needs_check|verificationStatus" apps/worker/src/jobs/compile-teaching-unit.ts
$ ls packages/ai/src/opening/teaching-compiler.ts packages/domain/src/opening/teaching-plan.ts
```

**Result:** exit 0 — compiler L366 sets `needs_check`; worker L273 sets activity `generate_status=needs_check` after model; V2-08 modules present on tip.

### V2-06 evidence / coverage

```text
$ rg -n "export function classifyClaimSupport|assembleTeachingEvidencePack|assertNoHeldOutLeak" packages/ai/src/opening/teaching-evidence.ts
$ rg -n "CoverageStatus|ClaimEvidenceKind|conflict|uncovered|buildCoverageTable" packages/domain/src/opening/teaching-coverage.ts
```

**Result:** exit 0 — claim support + conflict/uncovered available for fact layer / publish gate.

### tutor-turn / tutor-policy / client init / timeout honesty

```text
$ Read apps/worker/src/jobs/tutor-turn.ts (privacy, providerOutputSchema, markUnknown on PROVIDER_TIMEOUT)
$ rg -n "assertNoMasteryPercentage|preferCitationsForPage" packages/domain/src/opening/tutor-policy.ts
$ rg -n "getClientInit|verificationStatus" packages/database/src/repositories/opening-teaching-content.ts
$ rg -n "PROVIDER_TIMEOUT|markUnknown" packages/ai/src/opening/provider.ts apps/worker/src/runtime/budgeted-call.ts
```

**Result:** exit 0 — timeout→unknown precedent exists; getClientInit already exposes `verificationStatus`; no authority presentation policy yet.

### Additional Reads (completed; no product mutation)

| Path | Purpose |
|---|---|
| `plan.md` §V2-09; `tasks.json` V2-09 | Authority + PM wording |
| `review-test-gates.md` | Evidence rules |
| `v2-08-*` understand/plan/plan-implement | Shape mirror |
| `v2-06-teaching-evidence-understand.md` | Evidence pack context |
| `teaching-content.ts` / `teaching-activity.ts` | Status enums |
| `0053` / `0054` / `0055` migrations | No new DDL |
| `teaching-compiler.ts` / `compile-teaching-unit.ts` | Post-compile attach |
| `teaching-evidence.ts` / `teaching-coverage.ts` | Fact-layer inputs |
| `tutor-turn.ts` / `tutor-policy.ts` | Reuse entry / unknown honesty |
| `opening-teaching-content.ts` getClientInit | Authority surface attach |
| `provider.ts` / `budgeted-call.ts` | Timeout → unknown precedent |

## Planned product tests (from Plan §8.2) — status

| ID | Status | Reason |
|---|---|---|
| C1–C11 (structure≠fact, chunk≠support, conflict, spoof, injection, formula/timeout unknown, no peer-model proof, stream fence, privacy recheck, wire, presentation) | **`not_run`** | Plan stage only; modules not landed |
| `vitest` teaching-validation / teaching-verifiers | **`not_run`** | No Implement |
| `vitest` teaching-evidence / coverage / compiler / tutor-policy / compile-teaching-unit regressions | **`not_run`** | Docs-only; not re-executed this slice |
| `tsc` / typecheck | **`not_run`** | Docs-only |
| Real model / tool smoke | **`not_run`** | No Implement / no provider run |
| Browser / E2E | **`not_run`** | N/A this slice (Experience V2-10) |
| Migration apply | **`not_run`** | Plan prefers no DDL |
| push / hermes | **`not_run`** | Forbidden this slice |

## Plan summary (for Accept)

1. Domain `teaching-validation.ts` (structure≠fact, `mayPublishVerified`, draft/authority presentation, stream deny, privacy recheck, spoof assert) + AI `teaching-verifiers.ts` (L1–L5 runners via V2-06 pack/claim support + injection/tool probes).  
2. Consume V2-08 compile at `needs_check`; promote to `structure_ok` / `verified` only when layers allow — **缺依据/冲突未解不发已核验**.  
3. Tool timeout → layer `unknown` (not pass/fail); peer-model upvote **rejected** as independent proof.  
4. Do not fake authority; non-verified → discussion_draft / no formal scoring.  
5. **No DDL** (reuse `0054` / `0053` statuses); no new job kind by default.  
6. Thin post-compile / continue wire behind `teachingValidation.enabled`.  
7. AI owns validation/verifiers; Experience owns V2-10 UI in parallel; Pipeline owns job shell.  
8. Rollback = disable flag / risky types; keep history readable.  
9. **No Implement in this slice.**

## Ask Integrator

**Please Plan ACCEPT** (or REJECT with gaps) before any product Implement.  
This evidence **does not** self-ACCEPT / self-verify / move `tasks.json`.

## Verdict this slice

- Understand + Plan **written**.  
- Tip still `f5dae08…` at evidence time.  
- Confirm: **no Implement / no migration / no push / no hermes / no commit** performed by this agent.  
- Await Integrator **Plan ACCEPT**.
