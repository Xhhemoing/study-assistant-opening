# V2-06 Plan — Teaching evidence pack + coverage table

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy AI (executor)  
**Branch tip:** `cccc39272fd3a7d565a946b3979d0231220cbee2` (`cccc392`, `feat/opening-release`)  
**Stage:** Plan only — **Plan ACCEPT required before Implement**  
**Hard rules:** No product Implement · no migrations/ALTER · no push / hermes / stash / reset / commit · no `tasks.json` status changes  
**Align:** `plan.md` §V2-06; Understand `v2-06-teaching-evidence-understand.md`; V2-02 fixtures; V2-05 `teachingSourceRefSchema`; Package C miss-fallback; Package D soft `resolveCitations`

## 1. Smallest design

Three cooperating pieces — **no second chunk loader**, no mastery %, no forged sources:

| Piece | Responsibility | Does not own |
|---|---|---|
| **Teaching evidence pack** | Authorized, version-pinned chunks + SourceAnchors + allowlist/denylist/privacy filters ready for provider formatting | Body store; ActivitySpec CAS; budget ledger |
| **Coverage table** | Map goal/condition → anchors + `covered\|partial\|uncovered\|conflict` | Lexical ranking; tutor soft citations |
| **Claim support check** | Classify a claim span / teaching statement into evidence kinds; require anchors for `material_reorg` | Hard-fail of live tutor turns (M1 = classify+report) |

```
authorized sourceIds + sourceVersions
        │
        ▼
chunksAtSnapshots  ─────────────────────────┐
        │                                   │
        ▼                                   │
selectContext / budget (unchanged Package C)│
        │                                   │
        ▼                                   │
assembleTeachingEvidencePack                │
  • filter allowlist ∩ ¬denylist ¬privacy   │
  • build SourceAnchor[]                    │
  • assertNoHeldOutLeak                     │
        │                                   │
        ├─► formatProviderContext ── reuse renderContext delimiters
        │
        └─► buildCoverageTable(goals/conditions, anchors, chunk texts)
                 │
                 └─► classifyClaimSupport(claim, pack) → kind + status
```

**Orthogonal honesty:** Package C may still budget-fill zero-score chunks; coverage then marks conditions `uncovered` / `partial`. Package D soft resolve still drops unknown cited ids; claim check still may label `uncovered` / `conflict` without fabricating cites.

## 2. Proposed module APIs (sketches — not implemented this slice)

### 2.1 `packages/domain/src/opening/teaching-coverage.ts`

```ts
// sketches — not implemented this slice

export type SourceAnchor = {
  sourceId: string;
  sourceVersion: number;
  chunkId: string;
  page?: number | null;
  slideLabel?: string | null;
  startMs?: number | null;
};

export type CoverageStatus = "covered" | "partial" | "uncovered" | "conflict";

export type CoverageRow = {
  goalId?: string;
  conditionId: string;          // stable within unit (e.g. G-RN-01#sc-0 or claim-condition id)
  statement: string;            // human-readable condition / successCriterion
  sourceAnchors: SourceAnchor[];
  status: CoverageStatus;
  notes?: string;               // e.g. "zero lexical overlap; pack filled via Package C fallback"
};

export type ClaimEvidenceKind =
  | "material_reorg"
  | "generated_example"
  | "supplemental"
  | "inference"
  | "conflict"
  | "uncovered";

export function anchorKey(a: SourceAnchor): string;
// `${sourceId}@${sourceVersion}#${chunkId}` — never page-alone

export function buildCoverageTable(input: {
  conditions: Array<{ goalId?: string; conditionId: string; statement: string; linkedSourceIds?: string[] }>;
  anchors: SourceAnchor[];
  chunkTexts: Map<string, string>;  // key = anchorKey
}): CoverageRow[];

export function mergeCoverageStatus(rows: CoverageRow[]): CoverageStatus;
```

**Status rules (M1 defaults):**

| Status | When |
|---|---|
| `covered` | ≥1 allowlisted anchor whose chunk text supports the condition (lexical / structured check TBD at Implement; must not be citation-id-only) |
| `partial` | Anchors present on linked sources but weak/zero overlap, or only subset of multi-part criteria |
| `uncovered` | No usable anchor in pack for the condition (including empty materials) |
| `conflict` | Competing anchors / claim vs chunk disagreement (surface both sides) |

### 2.2 `packages/ai/src/opening/teaching-evidence.ts`

```ts
// sketches — not implemented this slice
import type { SourceChunk } from "@aistudy/contracts";
import type { CoverageRow, ClaimEvidenceKind, SourceAnchor } from "@aistudy/domain";
// (exact export path at Implement via domain index)

export type TeachingEvidencePack = {
  chunks: SourceChunk[];           // authorized + filtered
  anchors: SourceAnchor[];
  coverage: CoverageRow[];
  boundaries: {
    heldOutExcluded: boolean;
    privacyExcludedSourceIds: string[];
    noMaterials: boolean;
    externalSearch: "unavailable" | "not_used";
  };
};

export function assembleTeachingEvidencePack(input: {
  chunks: SourceChunk[];           // already from chunksAtSnapshots (or test fixture chunks)
  query: string;
  maxCharacters: number;
  preferChunkId?: string;
  preferPage?: number;
  allowlistSourceIds?: readonly string[];
  denylist?: { problemIds?: readonly string[]; paths?: readonly string[]; sourceIds?: readonly string[] };
  privacyExcludedSourceIds?: readonly string[];
  conditions?: Array<{ goalId?: string; conditionId: string; statement: string; linkedSourceIds?: string[] }>;
}): TeachingEvidencePack;
// Internally: filter → assertNoHeldOutLeak → selectContext (DO NOT replace miss-fallback) → anchors → coverage

export function classifyClaimSupport(input: {
  claimText: string;
  citedChunkIds: string[];
  pack: TeachingEvidencePack;
  expectedKind?: ClaimEvidenceKind;
}): {
  kind: ClaimEvidenceKind;
  anchors: SourceAnchor[];
  okForMaterialClaim: boolean;     // true only for material_reorg with supporting anchors
  reason: string;
};

export function assertNoHeldOutLeak(input: {
  packSourceIds: readonly string[];
  packChunkIds?: readonly string[];
  denylist: { problemIds?: readonly string[]; paths?: readonly string[]; sourceIds?: readonly string[] };
  contextBlob?: string;            // optional provider payload string to scan for denied paths/ids
}): void; // throws on leak

export function formatProviderContext(chunks: SourceChunk[]): string;
// MUST call / reuse renderContext from context.ts — same UNTRUSTED delimiters
```

**Align ActivitySpec:** when publish path later stamps `sourceRefs`, map `SourceAnchor` → `teachingSourceRefSchema` (`sourceId`, `version`, `chunkId`, `page`). Optional `slideLabel`/`startMs` live on evidence pack / citations; extend ActivitySpec schema only if product needs them on the binding row (separate small contract change — not required for M1 evidence module).

## 3. Integration points

| Call site | How | Rule |
|---|---|---|
| **Future `compile-teaching-unit` (V2-07)** | Primary consumer: assemble pack → coverage → feed compiler / verification | Prefer this for teaching generation |
| **`tutor-turn.ts`** | Thin optional adapter **after** `chunksAtSnapshots` + existing `selectContext` **or** replace only the formatting step with `formatProviderContext` ≡ `renderContext` | Do **not** fork chunk load; do **not** re-narrow explicit `sourceIds`; do **not** change soft citations default |
| **Tests / fixtures** | Load V2-02 allowlist/denylist/goals/sources-index → synthetic `SourceChunk[]` → `assembleTeachingEvidencePack` | First engineering sample before product wiring |

**Rejected:** second `listChunksAtVersion` wrapper inside teaching-evidence that bypasses `chunksAtSnapshots`; embedding-only retrieval that drops Package C fallback; hard-throwing claim check inside every tutor turn in M1.

## 4. V2-02 fixtures as first engineering sample

Implement-later test harness (docs-only now):

1. Read `lecture/retrieval-allowlist.json` → `allowlistSourceIds`.
2. Read `eval-heldout/retrieval-denylist.json` + `ISOLATION.md` rules → `denylist`.
3. Map `materials/sources-index.json` `chunkHints` → synthetic chunks (text from markdown pages).
4. Map `goals/teaching-goals.json` `successCriteria[]` → `conditions[]` (`conditionId = ${goalId}#sc-${i}`).
5. Build pack; assert:
   - no `HO-RN-*` / `eval-heldout/` in anchors or `formatProviderContext` output;
   - AN-RN-01: same page different `sourceId` → distinct anchors; page-alone merge rejected;
   - AN-RN-03: `page=9` on SRC-RN-02 → missing / uncovered, not a valid cite;
   - AN-RN-06: citation id without text support → not `material_reorg`;
   - zero-relevance query still non-empty pack (Package C) **and** uncovered/partial rows visible;
   - image-only / empty text: usable in pack when `imageObjectKey` set; no forged text claim;
   - AN-RN-08: no mastery % fields anywhere in pack/coverage API.

## 5. Explicit non-goals

- No mastery / confidence **%** derived from retrieval scores or citation counts.
- No treating citation id alone as verified truth.
- No external search inventing sources when search unavailable.
- No Implement / product code / migrations in **this** slice.
- No undo of Package C miss-fallback or Package D soft `resolveCitations` default.
- No re-narrow of explicit large client/worker `sourceIds` via pick-sources.
- No second body store; library / ActivitySpec remain V2-05 authority for teaching body.
- No self-ACCEPT; Plan ACCEPT is Integrator’s.

## 6. Verification plan

### 6.1 Plan-stage checks (this slice)

| Check | Status |
|---|---|
| Tip `git rev-parse HEAD` = `cccc392…` | **run** (see evidence) |
| Docs-only writes (3 paths) | **run** |
| Inventory Reads of context / citations / pick-sources / tutor-chunks / tutor-turn / fixtures / teaching-content sourceRefs | **run** (cited in Understand) |
| `vitest` suites for teaching-evidence / coverage | **`not_run`** — no Implement |
| `tsc` / typecheck | **`not_run`** — docs only |
| Provider live payload inspection | **`not_run`** |
| Browser / E2E | **`not_run`** |

### 6.2 Implement-later verification (commands + cases)

Suggested (exact scripts chosen at Implement):

```text
# unit — new modules
pnpm exec vitest run packages/domain/src/opening/teaching-coverage.test.ts
pnpm exec vitest run packages/ai/src/opening/teaching-evidence.test.ts

# regressions — must stay green (Package C / D)
pnpm exec vitest run packages/ai/src/opening/context.test.ts
pnpm exec vitest run packages/ai/src/opening/citations.test.ts
pnpm exec vitest run packages/ai/src/opening/pick-sources.test.ts
# worker tutor-turn unit if present
pnpm exec vitest run apps/worker/src/jobs/tutor-turn*.test.ts
```

| ID | Case |
|---|---|
| E1 | Cross-source same page → distinct anchors; reject page-alone identity |
| E2 | Overlong anchor / label — identity fields preserved |
| E3 | Chinese paraphrase query — Package C may fill; coverage honesty separate |
| E4 | Zero-relevance materials — non-empty selectContext + uncovered/partial rows |
| E5 | Image-only no text — pack allows image chunk; no forged text material_reorg |
| E6 | Privacy excluded source omitted; all-excluded fails closed |
| E7 | Held-out denylist leak → `assertNoHeldOutLeak` throws |
| E8 | Inspect `formatProviderContext` / provider payload contains UNTRUSTED delimiters only for allowlisted chunks |
| E9 | External search unavailable → `boundaries.externalSearch` set; zero fake cites |
| E10 | Soft `resolveCitations` still default at tutor boundary (regression) |

## 7. Migration

| Item | Plan decision |
|---|---|
| DDL needed? | **Likely none** for M1 |
| Prefer | In-memory `TeachingEvidencePack` + optional JSON snapshot on ActivitySpec / TeachingUnit `generationConfig.extras` or adjacent metadata — **not** a second body |
| If later query patterns need durable coverage rows | Use Integrator-assigned `00xx_…sql` placeholder only; tip migrations currently end at **`0054_opening_teaching_content.sql`** (V2-05) — **do not invent** the next number |
| Backup | N/A unless new tables appear |

## 8. Rollback / flags

- **Flag (conceptual):** `teachingEvidencePack.enabled` (or worker/env gate) — when off, tutor-turn / compile keep today’s `selectContext` + soft citations only; no coverage enforcement.
- **Rollback:** disable new assembly; **retain** user-selected authorized reads and existing citation rows; do not delete materials or ActivitySpec `sourceRefs`.
- No DROP of user data; no forced re-parse.

## 9. Handoff

1. **Integrator Plan ACCEPT** required before any Implement of `teaching-evidence.ts` / `teaching-coverage.ts`.
2. Pipeline **V2-07 Plan** may proceed in parallel; **V2-06 Implement** may land before `compile-teaching-unit` consumes the pack — compile should call the shared helper when ready, not duplicate logic.
3. V2-09 verification/publish will consume claim kinds + coverage statuses; V2-06 only builds the honesty primitives.
4. **This document does not authorize product code, migrations, or self-ACCEPT.**

## 10. Files to add/change at Implement (preview)

| Path | Action |
|---|---|
| `packages/domain/src/opening/teaching-coverage.ts` (+ test) | New |
| `packages/domain/src/index.ts` | Export |
| `packages/ai/src/opening/teaching-evidence.ts` (+ test) | New |
| `packages/ai/src/index.ts` | Export |
| Optional thin call from `apps/worker/src/jobs/tutor-turn.ts` or future `compile-teaching-unit.ts` | Adapter only |
| Fixture-driven tests under `packages/ai` or `packages/domain` reading V2-02 JSON | New |

**Not touching in V2-06 Implement:** ActivitySpec DDL; learning ledger; Experience coverage UI; pick-sources re-narrow behavior; soft citation default; Package C miss-fallback semantics.
