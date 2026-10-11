# V2-08 Plan — Outline → current teaching activity orchestration

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy AI (executor / Grok Bot)  
**Branch tip:** `ae974983ce791894c2aa6d9459b06198d3152191` (`ae97498`, `feat/opening-release`)  
**Stage:** Plan only — **Plan ACCEPT required before Implement**  
**Hard rules:** No product Implement · no migrations/ALTER · no push / hermes / stash / reset / commit · no `tasks.json` status changes  
**Align:** `plan.md` §V2-08; `tasks.json` V2-08; Understand `v2-08-teaching-plan-understand.md`; V2-05/06/07 landed code; `review-test-gates.md`  
**Source refs:** R02, E01, E02, C02

## 1. Sequencing

```
Understand (docs, this slice)
    → Integrator Plan ACCEPT (independent; no self-ACCEPT)
        → PM may open Implement gate later
            → Implement (domain teaching-plan + ai teaching-compiler + thin worker wire)
                → Independent Implement ACCEPT
```

- This slice delivers **Understand + Plan + plan-stage evidence only**.
- V2-09 verification consumes compiled output; V2-08 stops at presentable `needs_check` ActivitySpec (V2-07 status default).
- Experience outline UI may land later; compiler APIs must be callable from worker without UI.

## 2. Smallest design

Two new modules + thin wire into existing V2-07 handler — **no new job kind, no new DDL**.

| Piece | Path | Responsibility |
|---|---|---|
| **Teaching plan (domain)** | `packages/domain/src/opening/teaching-plan.ts` | Outline / path / prereq types; allowlists; freeze-history helpers; mastery % ban; assert path ≠ `planDay` |
| **Teaching compiler (ai)** | `packages/ai/src/opening/teaching-compiler.ts` | Propose editable outline → compile **current** activity (+ optional prefetch) using V2-06 evidence pack + provider |
| **Worker wire** | `apps/worker/src/jobs/compile-teaching-unit.ts` (+ `index.ts`) | Inject `buildPublishInput` that calls compiler; replace stub provider instruction/payload with compile-oriented input — **keep** budget/epoch/cancel fences unchanged |

```
intent / materials / optional edited outline
        │
        ▼
proposeTeachingOutline (model, constrained)  ──► TeachingOutline (editable)
        │                                         user may edit before compile
        ▼
assembleTeachingEvidencePack (V2-06)  ◄── chunksAtSnapshots / selectContext (unchanged)
        │
        ▼
compileCurrentActivity(outline, focusIndex, pack)
        │
        ├─► library block drafts (roles teach|prompt|example|answer_key|meta)
        ├─► ActivitySpecPublishInput (blockOrder, sourceRefs, goals, …)
        └─► optional prefetchNextSkeleton (budgeted, ≤1 by default)
        │
        ▼
compile-teaching-unit handler
  buildPublishInput → publishActivitySpec + generate_status=needs_check
```

## 3. Placement justification

| Proposed file | Package | Why |
|---|---|---|
| `teaching-plan.ts` | **domain** (as `plan.md` / `tasks.json` proposed_paths) | Pure policy/types: allowlists, prereq skip, history freeze, mastery ban — same layer as `tutor-policy.ts` / `teaching-coverage.ts` / `day-planner.ts` |
| `teaching-compiler.ts` | **ai** (as proposed_paths) | Provider orchestration + evidence formatting — same layer as `teaching-evidence.ts` / `provider.ts` |
| Not in contracts initially | — | Start with domain/ai types; promote zod schemas to `packages/contracts` only if HTTP/API surface requires shared validation in the same Implement (prefer domain→contracts if Experience needs outline DTO in-slice) |
| Not a new worker job | — | V2-07 already owns durable generation (`compile-teaching-unit` + migration `0055`) |

**Rejected placement:** putting outline types only inside worker (hard to unit-test / share with Experience); putting compiler inside domain (would drag provider + evidence into domain).

## 4. Proposed APIs (sketches — not implemented this slice)

### 4.1 `packages/domain/src/opening/teaching-plan.ts`

```ts
// sketches — not implemented this slice
import { assertNoMasteryPercentage } from "./tutor-policy";

/** M1 allowlist — program constrains model; Experience V2-10 may subset further. */
export const ALLOWED_TEACHING_BLOCK_TYPES = [
  "text", "formula", "prompt", "example", "steps", "answer_key", "meta",
  // fixture may also use matrix-viz — treat as optional allow if product supports, else map→text+formula
] as const;

export type TeachingOutlineItem = {
  itemId: string;                 // stable within outline
  title: string;
  goalIds: string[];
  intendedBlockTypes: string[];   // must ⊆ allowlist after normalize
  sourceIds: string[];            // authorized only
  prereqItemIds?: string[];       // soft suggestions
  notes?: string;
};

export type TeachingPrerequisiteSuggestion = {
  itemId: string;
  reason: string;                 // explainable to learner
  skippable: true;                // M1 invariant: always skippable
  skipEffect: "continue_without" | "mark_skipped";
};

export type TeachingOutline = {
  outlineId: string;
  activityId: string;
  teachingUnitId?: string;
  focusItemId: string;            // current activity to compile
  items: TeachingOutlineItem[];
  prereqs: TeachingPrerequisiteSuggestion[];
  pathVersionHint?: number;       // compare to activity.pathVersion
  /** Never calendar slots — teaching path only. */
  kind: "teaching_path";
};

export type HistoryFreezeDecision =
  | { action: "compile_current"; targetItemId: string }
  | { action: "revise_subsequent_only"; frozenActivityIds: string[]; reviseFromItemId: string }
  | { action: "reject_rewrite_history"; reason: string };

export function normalizeBlockTypes(types: string[]): string[];
// drop/map unknown → allowlist; never invent mastery fields

export function assertTeachingPathNotPlanDay(value: unknown): void;
// throws if payload looks like DayPlanResult / PlannedBlock calendar shape

export function suggestPrerequisites(outline: TeachingOutline): TeachingPrerequisiteSuggestion[];
// explainable; every entry skippable: true

export function decideHistoryFreeze(input: {
  outline: TeachingOutline;
  publishedActivityIds: string[];
  learnedActivityIds: string[];   // completed/skipped or with observations
  goalAdjustment: boolean;
}): HistoryFreezeDecision;

export function assertOutlineHonest(outline: TeachingOutline): void;
// calls assertNoMasteryPercentage on outline as Record; prereq skippable; kind==="teaching_path"
```

### 4.2 `packages/ai/src/opening/teaching-compiler.ts`

```ts
// sketches — not implemented this slice
import type { ActivitySpecPublishInput, ProviderOutput, SourceChunk } from "@aistudy/contracts";
import type { TeachingOutline, TeachingOutlineItem } from "@aistudy/domain";
import {
  assembleTeachingEvidencePack,
  type TeachingEvidencePack,
} from "./teaching-evidence";

export type ProposeOutlineInput = {
  activityId: string;
  intentSummary: string;
  intentKind: string;             // from teachingActivityIntentKindSchema
  sourceIds: string[];
  chunks: SourceChunk[];          // already version-pinned by caller
  currentPage?: number | null;    // may be null — still compile with evidence
  existingOutline?: TeachingOutline; // user-edited
  maxItems?: number;              // small-scope default e.g. 5–8
};

export type CompileCurrentInput = {
  outline: TeachingOutline;       // must be post-edit authoritative
  focusItemId: string;
  pack: TeachingEvidencePack;
  teachingUnitId: string;
  expectedContentVersion: number;
  revisionNumber: number;
  prefetchNext?: boolean;         // default false; if true ≤1 skeleton
};

export type CompileCurrentResult = {
  publishInput: ActivitySpecPublishInput;
  /** Library body blocks to write in same product transaction (Implement wires repo). */
  libraryBlocks: Array<{ id: string; type: string; content: Record<string, unknown>; role: string }>;
  outlineUsed: TeachingOutline;
  prefetchSkeleton?: TeachingOutlineItem | null;
  providerMeta?: { usedModel: boolean; stub: false };
};

export function proposeTeachingOutline(input: ProposeOutlineInput): TeachingOutline;
// If existingOutline provided → validate/normalize only (no silent model overwrite of user edits).
// Else model proposes under allowlist; program clamps types/sources.

export function compileCurrentActivity(input: CompileCurrentInput): CompileCurrentResult;
// Builds goals/blockOrder/sourceRefs from focus item + pack anchors;
// answer_key role content never leaked to client init (V2-05 invariant).

export function buildCompileProviderInput(outline: TeachingOutline, pack: TeachingEvidencePack): {
  instruction: string;
  text: string;
  // chunks via formatProviderContext(pack.chunks) — reuse UNTRUSTED delimiters
};
```

### 4.3 Wire into V2-07 stub

| Hook | Change at Implement | Rule |
|---|---|---|
| `CompileTeachingUnitDeps.buildPublishInput` | Provide implementation that: (1) loads outline from extras/checkpoint or proposes; (2) builds evidence pack from authorized chunks; (3) `compileCurrentActivity`; (4) returns `ActivitySpecPublishInput` | Do **not** bypass `publishActivitySpec` CAS / cancel fences |
| Provider in `index.ts` | Replace stub `{ stub: true }` with real `BudgetedProvider` **or** keep provider for model text and parse inside `buildPublishInput` | Still go through `runBudgetedCall` + `operationId = compile-teaching-unit:{job.id}` |
| `defaultStubPublish` | Remain fallback when compiler flag off | Rollback path |
| Payload | Optional additive fields later (`outlineId`, `focusItemId`) — **prefer** reading outline from unit extras first to avoid migration | If payload extended, stay JSON-only on existing `opening_jobs.payload` |

**Interface clarity (no Implement now):**

```ts
// conceptual — worker deps.buildPublishInput
async (scope, payload, providerOutput) => {
  const outline = readOrProposeOutline(...);
  assertOutlineHonest(outline);
  const pack = assembleTeachingEvidencePack(...);
  const { publishInput, libraryBlocks } = compileCurrentActivity({ outline, ... });
  await writeLibraryRevisionIfNeeded(scope, libraryBlocks); // existing teaching-content repo
  return publishInput; // verificationStatus unchecked/needs_check; extras.stub removed
};
```

## 5. Tasks (Implement-later breakdown)

| ID | Owner | Deps | Files (existing vs new) | Approach | Rejected alternative |
|---|---|---|---|---|---|
| T-A | AI | — | **New** `teaching-plan.ts` + test; export from `packages/domain/src/index.ts` | Types + allowlist + prereq + freeze + mastery assert + path≠planDay | Encode path as `planDay` blocks |
| T-B | AI | T-A, V2-06 | **New** `teaching-compiler.ts` + test; export from `packages/ai/src/index.ts` | Outline propose/validate + compile current + optional prefetch; call `assembleTeachingEvidencePack` | Whole-course one-shot generation; second chunk loader |
| T-C | AI (+ Pipeline assist ok) | T-B, V2-07 | **Edit** `compile-teaching-unit.ts` / `index.ts` only as thin wire | `buildPublishInput` + real provider; keep fences | New job kind; tutor-turn path; invent migration |
| T-D | AI | T-A/B | Fixture-driven tests from `activity-outline.json` | Map fixture → outline → compile focus item | Hardcoded blank ActivitySpec as “success” |
| T-E | Experience (later / OOS) | T-B APIs | UI outline edit / skip prereq | Call domain validators | Skip domain and edit raw model JSON in client only |

## 6. Explicit non-goals

- No mastery / confidence **%** chapter locks (`assertNoMasteryPercentage`).
- No equating teaching path with **`planDay`** calendar (`day-planner.ts`).
- No rewrite of already-learned / published history bodies.
- No whole-course generate-before-show.
- No V2-09 verification gate implementation.
- No new DDL / job kind (confirm: tip migrations end at **`0055_opening_compile_teaching_unit_job.sql`**).
- No Implement / push / hermes / stash / reset / commit in **this** slice.
- No self-ACCEPT.

## 7. Migration

| Item | Plan decision |
|---|---|
| DDL needed? | **No** for V2-08 M1 |
| Why | Job kind already in `0055`; outline fits `generationConfig.extras` / `checkpointJson`; publish uses existing V2-05 tables |
| If later query needs durable outline rows | Integrator assigns next `00xx` — **do not invent** number in Implement docs |

## 8. Verification plan

### 8.1 Plan-stage checks (this slice)

| Check | Status |
|---|---|
| Tip `git rev-parse HEAD` = `ae97498…` | **run** (see evidence) |
| Docs-only writes (understand + plan + evidence) | **run** |
| Inventory Reads of tutor-policy, compile-teaching-unit, teaching-evidence/coverage, teaching-content, day-planner, teaching-activity, fixtures, plan.md §V2-08 | **run** |
| `vitest` teaching-plan / teaching-compiler | **`not_run`** — no Implement |
| `tsc` / typecheck | **`not_run`** |
| Real model compile smoke | **`not_run`** (acceptance at Implement/Accept) |
| Browser / E2E | **`not_run`** |
| migrate | **`not_run`** — none planned |
| hermes / push | **`not_run`** — forbidden |

### 8.2 Implement-later verification (commands + cases)

Suggested (exact scripts chosen at Implement):

```text
pnpm exec vitest run packages/domain/src/opening/teaching-plan.test.ts
pnpm exec vitest run packages/ai/src/opening/teaching-compiler.test.ts
# regressions
pnpm exec vitest run packages/ai/src/opening/teaching-evidence.test.ts
pnpm exec vitest run packages/domain/src/opening/teaching-coverage.test.ts
pnpm exec vitest run packages/domain/src/opening/tutor-policy.test.ts
pnpm exec vitest run packages/domain/src/opening/day-planner.test.ts
pnpm exec vitest run apps/worker/src/jobs/compile-teaching-unit.test.ts
```

| ID | Case | Must not hide by |
|---|---|---|
| C1 | Editable outline: propose → mutate item → compile uses **edited** outline, not silent model overwrite | Asserting only stub extras.stub false |
| C2 | Compile **current** focus only; prefetch ≤1 skeleton; no whole-course wait | Green test with empty blockOrder |
| C3 | Path ≠ planDay: `assertTeachingPathNotPlanDay` rejects `DayPlanResult`-shaped payload | Skipping the assert |
| C4 | Prereq suggestions all `skippable: true` + human `reason`; skip does not set mastery % | Checking only array length |
| C5 | Goal adjust on same materials → `revise_subsequent_only`; learned ids frozen | Soft-pass when frozen ids rewritten |
| C6 | No current page: still builds pack + presentable blocks from sources | Requiring currentPage |
| C7 | Intent-only / topic-only / conflict goals / “already know → skimming” / no-foundation paths produce distinct outline notes without mastery lock | Single fixture for all |
| C8 | Allowlist clamps unknown block types; model cannot invent arbitrary HTML/JS types | Snapshotting raw model string |
| C9 | Held-out / privacy: compiler uses pack boundaries; no forged sourceRefs | Mock pack without assertNoHeldOutLeak |
| C10 | Worker wire: after compile, `generate_status=needs_check`, `blockOrder.length > 0`, `extras.stub` absent; cancel/budget fences still green | Stub provider still returning empty publish |
| C11 | Real model smoke (when auth): one presentable unit (acceptance) | Fixture-only accept as “real model” |

## 9. Rollback / flags

- **Flag:** `teachingCompiler.enabled` (worker/env) — when off, keep V2-07 stub publish / readable prior activities.
- **Rollback:** disable new orchestration; **do not** auto-switch providers; retain generated activities (`plan.md` rollback).
- No DROP of user data; no forced rewrite of learned history.

## 10. Ownership boundaries

| Role | Owns | Boundary |
|---|---|---|
| **AI** | `teaching-plan.ts`, `teaching-compiler.ts`, outline/compile semantics, worker `buildPublishInput` contract | Does not own Experience UI; does not re-own job budget state machine beyond calling it |
| **Pipeline** | V2-07 job/budget/fences (already landed) | Does not invent outline schema |
| **Experience** | Outline edit / skip UX / activity surface | Must call domain validators; no client-only mastery locks |
| **Data / Integrator** | Migration assignment if ever needed; Plan/Implement ACCEPT | Assigns numbers; AI does not invent DDL |

## 11. Handoff

1. **Integrator Plan ACCEPT** required before any Implement of `teaching-plan.ts` / `teaching-compiler.ts` / worker wire.
2. Do **not** mark `tasks.json` verified; do **not** self-ACCEPT.
3. Implement gate (later) must list commands + results per `review-test-gates.md`; every skipped check **`not_run`**.
4. **This document does not authorize product code, migrations, or self-ACCEPT.**

## Ready for Plan ACCEPT?

**Yes.** Hand to Integrator for Plan ACCEPT against Understand + this Plan + plan-stage evidence. AIstudy AI does **not** self-ACCEPT.
