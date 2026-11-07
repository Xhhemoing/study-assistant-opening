# V2-09 Teaching validation / publish control — Plan ACCEPT

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Reviewer:** AIstudy Integrator (executor / Grok Bot) — **≠** plan author (AIstudy AI)  
**Stage:** Plan ACCEPT only (no product Implement, no migration, no push / hermes / stash / reset / commit)  
**Branch:** `feat/opening-release`  
**Tip SHA verified:** `f5dae08c4b6d28c0a1a74118d916a9a36fb544e6` (`f5dae08`)  
**Baseline:** V2-08 merged ACCEPT at tip (`feat(opening): V2-08 teaching plan outline + compiler`)  
**Gates:** `docs/superpowers/plans/opening-release/review-test-gates.md` + delivery-loop Plan gate (stronger review of design claims vs code)  
**Docs reviewed:**
- `docs/superpowers/plans/ai-led-learning-v2/v2-09-teaching-validation-understand.md`
- `docs/superpowers/plans/ai-led-learning-v2/v2-09-teaching-validation-plan.md`
- `docs/superpowers/evidence/2026-10-11-opening-release/v2-09-teaching-validation-plan-implement.md` (Plan-stage evidence filename)

## Verdict

**ACCEPT**

Plan matches PM constraints (`plan.md` §V2-09 / `tasks.json` V2-09), Understand restatement, and tip `f5dae08` surfaces. Structure≠fact, no-fake-authority, tool-timeout→unknown, and no-DDL claims hold under spot-check. Soft gaps listed for Implement (do not overturn ACCEPT).

## Tip / tree verification

```text
$ git rev-parse HEAD
f5dae08c4b6d28c0a1a74118d916a9a36fb544e6

$ git branch --show-current
feat/opening-release

$ git log -1 --oneline
f5dae08 feat(opening): V2-08 teaching plan outline + compiler

$ git status --short
?? docs/superpowers/evidence/2026-10-09-opening-release/rp5-gha-91b1c73-typecheck-fail.md
?? docs/superpowers/evidence/2026-10-11-opening-release/p0-assistant-list-preview-failsoft-implement.md
?? docs/superpowers/evidence/2026-10-11-opening-release/v2-09-teaching-validation-plan-implement.md
?? docs/superpowers/evidence/2026-10-11-opening-release/v2-10-teaching-workspace-plan-implement.md
?? docs/superpowers/plans/ai-led-learning-v2/v2-09-teaching-validation-*.md
?? docs/superpowers/plans/ai-led-learning-v2/v2-10-teaching-workspace-*.md
(+ this accept evidence file after write)

$ test ! -f packages/domain/src/opening/teaching-validation.ts \
  && test ! -f packages/ai/src/opening/teaching-verifiers.ts && echo absent
absent

$ ls packages/database/src/migrations/*.sql | tail -3
…/0053_opening_teaching_activities.sql
…/0054_opening_teaching_content.sql
…/0055_opening_compile_teaching_unit_job.sql
# no 0056*
```

**Result:** tip OK. Product modules for V2-09 **not** landed (Plan-only scope honored). Migrations tip ends at **0055**. Parallel Experience V2-10 docs present; product-code tree not contested by this Plan.

## PM / claimed design (verify against Plan + tip)

| Claimed design | Plan coverage | Spot-check on tip |
|---|---|---|
| `structure_ok` ≠ `verified` | Plan §2 decidePublish; §4.1 `structurePassed` / `factPassed` / `mayPublishVerified`; C1 | `teachingVerificationStatusSchema` has both (`teaching-content.ts` L12–19); DDL CHECK identical in `0054` |
| Missing evidence / unresolved conflict → not publish as verified | Plan decidePublish; C2/C3; Understand gap table | `classifyClaimSupport`: citation id alone without overlap → `okForMaterialClaim: false` (`teaching-evidence.ts` ~L265–271); `CoverageStatus` includes `conflict`/`uncovered` |
| Do not fake authority | `assertNotAuthoritySpoof` / `detectAuthoritySpoof`; C4/C7/C11; presentation draft vs authoritative | No presentation policy on tip today; `getClientInit` already exposes `verificationStatus` (attach point) |
| Tool timeout keeps `unknown` | LayerOutcome `unknown`; C6; mirror tutor-turn | `PROVIDER_TIMEOUT`/`PROVIDER_NETWORK` → `markUnknown` (`tutor-turn.ts` L237–239); generate_status enum includes `unknown` (`0053` / contracts) |
| **No DDL** | Plan §7; Understand OOS | Statuses already in `0054`; generate statuses in `0053`; job kind in `0055`; **no new migration needed** |
| Consumes V2-08 compiler + V2-06 evidence | Plan §2 flow; T-B/T-C deps | Compiler sets `verificationStatus: "needs_check"` (L366); worker post-model `generate_status=needs_check` (L273); evidence pack + coverage APIs present |
| Proposed `teaching-validation` + `teaching-verifiers` | Plan §2–§3; `tasks.json` proposed_paths | Paths match; modules **absent** until Implement |
| No new job kind by default | Plan §3 rejected alt; T-C thin wire | Prefer post-compile hook on `compile-teaching-unit`; justified |

## Stronger-review table (claims vs files)

| Claim | File / API on tip | Result |
|---|---|---|
| Entry tutor-turn / tutor-policy; proposed domain validation + ai verifiers | `plan.md` L505–523; `tasks.json` V2-09 `existing_paths` / `proposed_paths` | **Pass** |
| Verification enum separates structure vs fact | `teachingVerificationStatusSchema` L12–19; `0054` CHECK | **Pass** |
| Activity `generate_status` includes needs_check / ready / unknown | `teachingActivityGenerateStatusSchema` L20–28; `0053` CHECK | **Pass** |
| V2-08 compile lands at needs_check | `teaching-compiler.ts` L366; `compile-teaching-unit.ts` L273 (model path) | **Pass** |
| V2-06 claim support ≠ citation-id-only | `classifyClaimSupport` lexical overlap; AN-RN-06 comment L265 | **Pass** |
| Coverage conflict / uncovered for fact gate | `teaching-coverage.ts` `CoverageStatus` / `buildCoverageTable` / `mergeCoverageTable` worst-wins | **Pass** (note: M1 conflict is **caller-listed**, not auto-detect — soft gap #3) |
| Timeout → unknown honesty precedent | tutor-turn L237–239; budget `markUnknown` | **Pass** |
| Client surface already carries status | `getClientInit` returns spec incl. `verificationStatus` (L422–443); `activitySpecClientInitSchema` extends activitySpec | **Pass** |
| No invented job kind / silent DDL | migrations end `0055`; Plan rejects new kind / `fact_ok` column | **Pass** |
| Tests cannot hide structure≠fact | Plan C1–C11: structure-only → structure_ok + mayPublishVerified=false; chunk≠support; conflict; spoof; timeout unknown; no peer-model proof; stream fence; privacy recheck; wire; presentation | **Pass** (Plan-stage design; Implement must land) |
| Experience UI ownership (V2-10 parallel) | V2-10 Understand/Plan: display `verificationStatus` honestly; **does not** implement verifiers; OOS `apps/web` in V2-09 | **Pass** (boundary clean) |
| Placement: domain policy / ai runners | Same layer as tutor-policy + teaching-coverage vs teaching-evidence + compiler | **Pass** |
| Scope = docs only this handoff | Proposed modules absent; plan-implement claims not_run for vitest/tsc/model | **Pass** |
| Status promotion after compile | Plan: CAS-update `verificationStatus` + optional `generate_status` | **Soft** — no dedicated `setVerificationStatus` today; only via `publishActivitySpec` (status in soft-idempotent graph). Soft gap #1 |
| Repair `skipProvider` → `ready` | `compile-teaching-unit.ts` L191, L273 | **Soft** — bypasses needs_check today; must reconcile with Plan “ready only when verified”. Soft gap #2 |

### Invented / soft-named helpers (not REJECT)

| Sketch name | Reality on tip | Integrator note |
|---|---|---|
| `mayPublishVerified` / `presentationFor` / `denyIncompleteStreamActions` / `recheckPrivacyFreshness` | **New** domain APIs (absent) | Expected; pure policy — place in `teaching-validation.ts` as planned |
| `verifyTeachingContent` / `scanInjectionRisks` / `detectAuthoritySpoof` | **New** ai APIs (absent) | Expected; must call V2-06 `classifyClaimSupport` / pack, not fork loaders |
| `teachingValidation.enabled` flag | **Not** on tip | Soft gap #5 — Implement may use worker/env flag; off = leave needs_check (rollback) |
| CAS status promote without body rewrite | `publishActivitySpec` + `sameActivitySpecGraph` includes `verificationStatus` | Soft gap #1 — Implement: republish metadata with same body + new status **or** thin fenced updater; **no** DDL; do not rewrite learned history bodies |
| `keyClaims` on `VerifyTeachingInput` | Optional; no extractor on tip | Soft gap #4 — empty claims must not vacuously pass fact layer; C2/C3 require non-empty core claims |

None of the above drops a PM constraint or invents silent DDL / job kinds.

## DDL decision

| Item | Decision |
|---|---|
| New DDL for V2-09 M1? | **No** |
| New job kind? | **No** (thin post-compile / continue wire on existing `compile-teaching-unit` + tutor-turn) |
| Invent migration number? | **Do not.** Prefer no DDL as claimed. Statuses already in `0054` / `0053`. If a later slice truly needs durable verify-job rows, Integrator assigns next free `00xx` **only after** confirming tip — **not** required by this Plan ACCEPT. |

## Soft gaps / honesty (do not overturn ACCEPT)

1. **Status promote path:** No `setVerificationStatus` today. Implement must CAS-promote via metadata republish (`publishActivitySpec` with same graph + new `verificationStatus`) or a thin fenced updater on existing columns — **no DDL**, no body/history rewrite.  
2. **Repair `skipProviderForRepair` → `ready`:** Current worker sets `generate_status=ready` without layered verify. Implement must align with Plan: authoritative `ready` only when `verificationStatus=verified` (or keep repair as non-authoritative / already-verified-only).  
3. **Coverage conflict is caller-listed (M1):** `buildCoverageTable` does not auto-detect conflicts. Verifiers must actively mark conflict/uncovered on core conclusions; tests must not soft-pass when conflict notes empty (C3).  
4. **`keyClaims` extraction:** Optional input risks vacuous `factPassed` if empty. Implement must extract from teach/example (or require claims); C2/C3 must use non-empty core claims.  
5. **Flag + wire timing:** `teachingValidation.enabled` off leaves `needs_check`; post-compile verify must not bypass cancel/budget/epoch fences (V2-07/08).  
6. **action_permission vs structure_ok:** Plan correctly separates interactable fence from structure_ok alone — Implement tests must not collapse L5 fail into “structure failed” in a way that hides fact-layer independence.  
7. **V2-10 usable-content gate:** Experience Plan recommends `generateStatus===ready` **or** V2-09 presentation policy when available. Coordinate so client never invents “已核验” badge without domain `presentationFor` / status.  
8. **Plan-stage product checks:** C1–C11, vitest teaching-validation/verifiers, regressions, tsc, real tool smoke, browser/E2E, migrate, hermes/push — all honestly **`not_run`**.

## Open decisions for PM

**None that block Plan ACCEPT.** Understand §Decisions defaults (reuse enum; mayPublishVerified = structure∧fact; timeout→unknown; model self-claim ignored; post-compile separate step; ready only when verified) match Plan and tip. Optional later (not blockers): dedicated verification-status CAS helper vs republish-only; whether repair skip-provider may set ready without re-verify when content already verified.

## Plan-stage checks re-confirmed by Integrator

| Check | Status | Notes |
|---|---|---|
| Tip = `f5dae08…` | **run** | Matches required baseline |
| Proposed modules absent | **run** | `teaching-validation.ts` / `teaching-verifiers.ts` absent |
| Migrations tip = 0055; statuses in 0054/0053 | **run** | No DDL needed |
| V2-08 / V2-06 / tutor / getClientInit attach points | **run** | Spot-checked (see stronger-review table) |
| Product vitest / tsc / model / browser / migrate / push | **`not_run`** | Plan stage; no Implement claimed |

Per gates: Plan Accept does not require re-running product tests that were never claimed as pass.

## Scope confirmation

- Integrator did **not** implement product code.  
- Integrator did **not** commit / push / stash / reset / hermes / apply migrate.  
- Integrator did **not** change `tasks.json` status.  
- Integrator wrote **only** this accept evidence file.  
- Implementer (AIstudy AI) ≠ Accepter (this Integrator).

## Handoff

1. **Plan ACCEPT granted** for V2-09 teaching validation / publish control.  
2. PM may open **Implement** gate later (domain `teaching-validation.ts` + ai `teaching-verifiers.ts` + thin wire + C1–C11).  
3. Implement evidence must list commands + results; every skipped check **`not_run`**; no self-ACCEPT.  
4. Independent **Implement ACCEPT** required before `tasks.json` → `verified`.  
5. Experience V2-10 may continue UI Plan/Implement in parallel; must not own verifiers or invent client-only verified authority.

## Verdict (summary)

**ACCEPT** — tip `f5dae08`; **no DDL**; soft gaps #1–#8 for Implement; no open PM blockers; no push / hermes.
