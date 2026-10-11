# V2-09 Plan — Layered teaching validation & publish control

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy AI (executor / Grok Bot)  
**Branch tip:** `f5dae08c4b6d28c0a1a74118d916a9a36fb544e6` (`f5dae08`, `feat/opening-release`)  
**Stage:** Plan only — **Plan ACCEPT required before Implement**  
**Hard rules:** No product Implement · no migrations/ALTER · no push / hermes / stash / reset / commit · no `tasks.json` status changes · no `apps/web` edits (Experience V2-10 parallel)  
**Align:** `plan.md` §V2-09; `tasks.json` V2-09; Understand `v2-09-teaching-validation-understand.md`; V2-05/06/07/08 landed code; `review-test-gates.md`  
**Source refs:** R01, E03, C04

## 1. Sequencing

```
Understand (docs, this slice)
    → Integrator Plan ACCEPT (independent; no self-ACCEPT)
        → PM may open Implement gate later
            → Implement (domain teaching-validation + ai teaching-verifiers + thin wire)
                → Independent Implement ACCEPT
```

- This slice delivers **Understand + Plan + plan-stage evidence only**.
- V2-08 already lands compile → `needs_check`; V2-09 promotes/refuses `verified` and authority presentation.
- Experience V2-10 may render draft vs verified labels later; validation APIs must be callable from worker/domain without UI.

## 2. Smallest design

Two new modules + thin post-compile / continue hooks — **no new job kind, no new DDL** (statuses already in `0054` / contracts).

| Piece | Path | Responsibility |
|---|---|---|
| **Teaching validation (domain)** | `packages/domain/src/opening/teaching-validation.ts` | Layer result types; structure≠fact; `mayPublishVerified`; draft/authority labels; tool-timeout→`unknown`; stream-incomplete action deny; privacy re-check helpers |
| **Teaching verifiers (ai)** | `packages/ai/src/opening/teaching-verifiers.ts` | Execute layers: schema, source identity, claim support (V2-06), injection scans, optional tool probes; emit domain `ValidationReport` |
| **Thin wire (later Implement)** | `compile-teaching-unit` post-publish hook and/or tutor-turn continue path | Call verifiers; update `verificationStatus` / `generate_status` per gate — **keep** budget/epoch/cancel fences |

```
V2-08 compileCurrentActivity
        │  verificationStatus=needs_check, blockOrder>0, sourceRefs/goals
        ▼
assembleTeachingEvidencePack (V2-06)  ◄── same pack boundaries / held-out / privacy
        │
        ▼
runTeachingVerifiers (ai)
  L1 schema (HTTP/model/ActivitySpec shape)
  L2 source identity (chunk∈pack, version pin)
  L3 key claim support (classifyClaimSupport + coverage conflict/uncovered)
  L4 tool results (formula/etc; timeout→unknown)
  L5 action permission (complete block only; incomplete stream → deny)
        │
        ▼
decidePublish (domain teaching-validation)
  structure pass → structure_ok (≠ verified)
  fact pass + no unresolved conflict/missing evidence → verified
  else → needs_check | rejected | keep draft label
  tool unknown → do NOT promote to verified; do NOT fake fail/pass
        │
        ▼
persist status + presentationPolicy
  generate_status → ready only when verified (authoritative path)
  non-verified → explicit discussion-draft / non-authority (Experience renders)
```

## 3. Placement justification

| Proposed file | Package | Why |
|---|---|---|
| `teaching-validation.ts` | **domain** (as `plan.md` / `tasks.json` proposed_paths) | Pure policy: publish gate, status mapping, authority labeling — same layer as `tutor-policy.ts` / `teaching-coverage.ts` / `teaching-plan.ts` |
| `teaching-verifiers.ts` | **ai** (as proposed_paths) | Needs evidence pack + optional provider/tool I/O — same layer as `teaching-evidence.ts` / `teaching-compiler.ts` |
| Not inventing new contracts enum | — | Reuse `teachingVerificationStatusSchema` + `teachingActivityGenerateStatusSchema` |
| Not a new worker job kind | — | Prefer post-compile hook on existing `compile-teaching-unit` and/or continue-path checks in tutor-turn; new kind only if PM later requires durable async verify queue |

**Rejected placement:** putting publish gate only inside worker (hard to unit-test / share with Experience); putting claim/tool runners inside domain (would drag provider + pack into domain); adding `fact_ok` DDL (redundant with `verified` vs `structure_ok`).

## 4. Proposed APIs (sketches — not implemented this slice)

### 4.1 `packages/domain/src/opening/teaching-validation.ts`

```ts
// sketches — not implemented this slice

/** Per-layer outcome. Tool timeout MUST use unknown — never coerced to pass/fail. */
export type LayerOutcome = "pass" | "fail" | "unknown" | "skipped";

export type ValidationLayerId =
  | "schema"
  | "source_identity"
  | "claim_support"
  | "tool_result"
  | "action_permission";

export type LayerResult = {
  layer: ValidationLayerId;
  outcome: LayerOutcome;
  /** Human-readable; never used as fake authority proof by itself. */
  reason: string;
  details?: Record<string, unknown>;
};

export type PresentationPolicy =
  | { kind: "authoritative"; allowsFormalScoring: true }
  | { kind: "discussion_draft"; allowsFormalScoring: false; label: string }
  | { kind: "blocked"; allowsFormalScoring: false; reason: string };

export type ValidationReport = {
  activityId: string;
  structurePassed: boolean;   // schema + source_identity (+ action fence for interactable)
  factPassed: boolean;        // claim_support + tool_result passes; unknown blocks factPassed
  layers: LayerResult[];
  /** Mapped onto existing teachingVerificationStatusSchema — no new enum. */
  nextVerificationStatus:
    | "structure_ok"
    | "needs_check"
    | "verified"
    | "rejected"
    | "stale"
    | "unchecked";
  presentation: PresentationPolicy;
};

export function structurePassed(layers: LayerResult[]): boolean;
// true iff schema + source_identity are pass (action_permission fail blocks interactable, not structure_ok alone)

export function factPassed(layers: LayerResult[]): boolean;
// true iff claim_support pass AND tool_result is pass or skipped;
// tool_result unknown OR claim fail/conflict/uncovered → false

export function mayPublishVerified(report: ValidationReport): boolean;
// structurePassed && factPassed && no layer with unresolved conflict;
// NEVER true when any required layer is unknown

export function presentationFor(status: string, report: ValidationReport): PresentationPolicy;
// verified → authoritative; structure_ok/needs_check → discussion_draft;
// rejected/blocked → blocked; never pretends non-verified is 权威讲解

export function assertNotAuthoritySpoof(modelTextOrExtras: unknown): void;
// rejects model self-claim verified / fake scoring credentials in payload

export function denyIncompleteStreamActions(input: {
  jsonComplete: boolean;
  blockValidationComplete: boolean;
}): { allowActions: boolean; reason: string };
// 流式未完成JSON不执行动作；完整已检查块才可交互

export function recheckPrivacyFreshness(input: {
  previouslyVerified: boolean;
  excludedSourceIds: string[];
  referencedSourceIds: string[];
  epochMatched: boolean;
}): { stillValid: boolean; nextStatus?: "stale" | "needs_check" };
// 每次读取/继续重新检查删除或隐私排除
```

### 4.2 `packages/ai/src/opening/teaching-verifiers.ts`

```ts
// sketches — not implemented this slice
import type { ActivitySpecPublishInput, ProviderOutput } from "@aistudy/contracts";
import type { ValidationReport, LayerResult } from "@aistudy/domain";
import {
  assembleTeachingEvidencePack,
  classifyClaimSupport,
  type TeachingEvidencePack,
} from "./teaching-evidence";
import { buildCoverageTable } from "@aistudy/domain"; // or via pack coverage already built

export type VerifyTeachingInput = {
  activityId: string;
  publishInput: ActivitySpecPublishInput;
  /** Library block contents for claim/injection scans (answer_key still server-side). */
  blocks: Array<{ id: string; type: string; role: string; content: Record<string, unknown> }>;
  pack: TeachingEvidencePack;
  /** Optional key claims extracted from teach/example blocks. */
  keyClaims: Array<{ claimId: string; text: string; citedChunkIds: string[]; isCoreConclusion: boolean }>;
  /** Optional tool runner; timeout must surface as unknown. */
  tools?: {
    checkFormula?: (latex: string) => Promise<{ ok: boolean } | { unknown: true; reason: string }>;
  };
  modelExtras?: unknown; // scan for self-claimed verified
};

export type VerifyTutorOutputInput = {
  output: ProviderOutput;
  pack: TeachingEvidencePack;
  jsonComplete: boolean;
};

export function verifyTeachingContent(input: VerifyTeachingInput): Promise<ValidationReport>;
// Runs L1–L5; uses classifyClaimSupport; conflict/uncovered on core → fact fail;
// checkFormula timeout → layer tool_result unknown (not pass/fail);
// another model "upvote" is NOT an accepted tool — rejected alternative

export function verifyTutorTurnOutput(input: VerifyTutorOutputInput): LayerResult[];
// schema already via providerOutputSchema; add injection + incomplete-stream action deny

export function scanInjectionRisks(text: string): LayerResult;
// material instruction injection; latex/URL injection patterns → fail findings

export function detectAuthoritySpoof(textOrExtras: unknown): LayerResult;
// 模型自称verified → fail (does not grant verified)
```

### 4.3 Wire (Implement-later; thin)

| Hook | Change at Implement | Rule |
|---|---|---|
| Post V2-08 compile | After successful publish with `needs_check`, call `verifyTeachingContent`; CAS-update `verificationStatus` (+ optional `generate_status`) | Do **not** bypass cancel/budget/epoch fences; do not rewrite learned history bodies |
| Flag | `teachingValidation.enabled` (worker/env) | Off → leave `needs_check`; readable history retained (`plan.md` rollback) |
| `getClientInit` / Experience | Domain `presentationFor(spec.verificationStatus, …)` | Experience V2-10 renders labels; **this slice does not edit `apps/web`** |
| tutor-turn continue / teaching commands | `denyIncompleteStreamActions` + `recheckPrivacyFreshness` | Incomplete JSON → no actions; privacy hit → `stale`/`needs_check` |
| Tool timeout | Map to `LayerOutcome: "unknown"` | Mirror tutor-turn `PROVIDER_TIMEOUT` → unknown honesty; never “another model likes it” as proof |

## 5. Tasks (Implement-later breakdown)

| ID | Owner | Deps | Files (existing vs new) | Approach | Rejected alternative |
|---|---|---|---|---|---|
| T-A | AI | — | **New** `teaching-validation.ts` + test; export from `packages/domain/src/index.ts` | Types + structure≠fact + mayPublishVerified + presentation + stream deny + privacy recheck + authority spoof assert | New DDL status `fact_ok`; encode authority only in UI strings |
| T-B | AI | T-A, V2-06 | **New** `teaching-verifiers.ts` + test; export from `packages/ai/src/index.ts` | L1–L5 runners; `classifyClaimSupport` + coverage; injection scans; tool timeout→unknown | Second model upvote as “verification”; fork chunk loader |
| T-C | AI (+ Pipeline assist ok) | T-B, V2-08 | **Edit** `compile-teaching-unit.ts` / optional tutor-turn only as thin wire | Post-compile verify + status promote; flag off = no-op | New job kind; blocking whole-course verify before first token |
| T-D | AI | T-A/B | Adversarial unit cases from plan.md verification list | Legal chunkId≠support; injection; self-claimed verified; latex/URL; formula error; tool timeout unknown | Soft-pass by asserting only schema green |
| T-E | Experience (V2-10 / OOS here) | T-A presentation API | Draft vs verified UI | Call domain presentation helpers | Client invents “已核验” badge without status |

## 6. Explicit non-goals

- Structure pass **≠** fact pass; do not collapse into one boolean.
- Missing evidence / unresolved conflict → **not** `verified`.
- Do **not** fake authority (model self-claim, structure-only, peer-model upvote).
- Tool timeout stays **`unknown`**.
- No new DDL / job kind (confirm: tip migrations end at **`0055`**; statuses in **`0054`**).
- No Implement of product code in **this** slice; no `apps/web` (Experience V2-10 parallel).
- No push / hermes / stash / reset / commit; no self-ACCEPT; no `tasks.json` status edits.

## 7. Migration

| Item | Plan decision |
|---|---|
| DDL needed? | **No** for V2-09 M1 |
| Why | `verification_status` CHECK already includes `structure_ok` / `verified` / `needs_check` / … (`0054`); `generate_status` already includes `unknown` / `ready` / `needs_check` (`0053`) |
| If later need durable verify-job rows | Integrator assigns next `00xx` — **do not invent** number in Implement docs |

## 8. Verification plan

### 8.1 Plan-stage checks (this slice)

| Check | Status |
|---|---|
| Tip `git rev-parse HEAD` = `f5dae08…` | **run** (see evidence) |
| Docs-only writes (understand + plan + evidence) | **run** |
| Inventory Reads of plan §V2-09, tasks, review-test-gates, tutor-turn, tutor-policy, teaching-content/activity schemas, teaching-evidence/coverage, teaching-compiler, compile-teaching-unit, migrations 0053–0055, getClientInit | **run** |
| Confirm `teaching-validation.ts` / `teaching-verifiers.ts` absent | **run** |
| `vitest` teaching-validation / teaching-verifiers | **`not_run`** — no Implement |
| `tsc` / typecheck | **`not_run`** |
| Real model / tool smoke | **`not_run`** |
| Browser / E2E | **`not_run`** |
| migrate | **`not_run`** — none planned |
| hermes / push | **`not_run`** — forbidden |

### 8.2 Implement-later verification (commands + cases)

Suggested (exact scripts chosen at Implement):

```text
pnpm exec vitest run packages/domain/src/opening/teaching-validation.test.ts
pnpm exec vitest run packages/ai/src/opening/teaching-verifiers.test.ts
# regressions
pnpm exec vitest run packages/ai/src/opening/teaching-evidence.test.ts
pnpm exec vitest run packages/domain/src/opening/teaching-coverage.test.ts
pnpm exec vitest run packages/ai/src/opening/teaching-compiler.test.ts
pnpm exec vitest run packages/domain/src/opening/tutor-policy.test.ts
pnpm exec vitest run apps/worker/src/jobs/compile-teaching-unit.test.ts
```

| ID | Case | Must not hide by |
|---|---|---|
| C1 | Structure pass alone → `structure_ok`, `mayPublishVerified=false` | Asserting only schema parse success as “verified” |
| C2 | Core claim with legal chunkId but no support → fact fail; not `verified` | Checking citation id presence only |
| C3 | Coverage `conflict` / `uncovered` on core conclusion → refuse verified; draft label ok | Soft-pass when conflict notes empty |
| C4 | Model self-claim “verified” / extras → authority spoof fail; status not promoted | Ignoring spoof because schema green |
| C5 | Prompt / latex / URL injection findings → fail or block authoritative publish | Snapshotting raw string without scan |
| C6 | Key formula tool error → fact fail; **timeout → `unknown`**, not pass/fail | Treating timeout as pass or as rejected |
| C7 | Another model upvote / second LLM “looks good” **rejected** as independent proof | Green test that mocks peer model as tool_result pass |
| C8 | Incomplete stream JSON → `allowActions=false`; complete checked block → allow | Skipping stream fence |
| C9 | Privacy exclusion / epoch mismatch on continue → prior verified becomes `stale`/`needs_check` | Caching verified forever |
| C10 | Post-compile wire: starts `needs_check`; after fact pass → `verified` + optional `generate_status=ready`; flag off leaves needs_check | Stub that sets verified without layers |
| C11 | Non-verified client presentation: `discussion_draft` / `allowsFormalScoring=false` | UI-only badge without domain policy |

## 9. Rollback / flags

- **Flag:** `teachingValidation.enabled` — when off, keep V2-08 `needs_check` / readable activities; do not delete history (`plan.md` rollback).
- **Rollback:** disable risky content types / verification promotion; fall back to verified text-only explain or explicit limitation notice — **no** DROP of user data.
- Do not auto-switch providers; do not rewrite learned history bodies.

## 10. Ownership boundaries

| Role | Owns | Boundary |
|---|---|---|
| **AI** | `teaching-validation.ts`, `teaching-verifiers.ts`, publish-gate semantics, thin worker/tutor wire contract | Does not own Experience UI; does not re-own job budget SM beyond calling it |
| **QA/安全** | Adversarial case list (plan verification) encoded as tests | Does not invent product APIs outside Plan |
| **Pipeline** | Job/budget/fences (V2-07/08 landed) | Does not invent validation schema |
| **Experience** | V2-10 workspace / draft vs verified chrome (parallel) | Must call domain presentation helpers; no client-only “已核验” |
| **Data / Integrator** | Migration assignment if ever needed; Plan/Implement ACCEPT | Assigns numbers; AI does not invent DDL |

## 11. Handoff

1. **Integrator Plan ACCEPT** required before any Implement of `teaching-validation.ts` / `teaching-verifiers.ts` / worker wire.
2. Do **not** mark `tasks.json` verified; do **not** self-ACCEPT.
3. Implement gate (later) must list commands + results per `review-test-gates.md`; every skipped check **`not_run`**.
4. **This document does not authorize product code, migrations, or self-ACCEPT.**
5. Experience V2-10 Plan may proceed in parallel on UI docs — product-code tree left alone this slice.

## Ready for Plan ACCEPT?

**Yes.** Hand to Integrator for Plan ACCEPT against Understand + this Plan + plan-stage evidence. AIstudy AI does **not** self-ACCEPT.
