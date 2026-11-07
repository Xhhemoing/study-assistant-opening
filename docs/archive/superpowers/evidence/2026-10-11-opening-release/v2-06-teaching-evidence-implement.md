# V2-06 Teaching evidence — Implement Evidence

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy AI implementer (executor / Grok Bot)  
**Branch:** `feat/opening-release`  
**Tip HEAD (baseline; dirty tree, no commit):** `cccc39272fd3a7d565a946b3979d0231220cbee2` (`cccc392`)  
**Status:** **implemented, awaiting Integrator Accept** — do **not** self-ACCEPT; `tasks.json` not marked verified  
**Hard rules held:** No push / hermes / stash / reset / commit · No DDL · No tutor-turn wiring · No Package C/D undo

## Authority followed

- Plan ACCEPT: `docs/superpowers/evidence/2026-10-11-opening-release/v2-06-teaching-evidence-plan-accept.md`
- Plan: `docs/superpowers/plans/ai-led-learning-v2/v2-06-teaching-evidence-plan.md`
- Understand: `docs/superpowers/plans/ai-led-learning-v2/v2-06-teaching-evidence-understand.md`
- PM: M1 no DDL; in-memory `TeachingEvidencePack`; no forged sources when no materials
- Gates: `docs/superpowers/plans/opening-release/review-test-gates.md`

## Diff scope

### New

| Path | Role |
|---|---|
| `packages/domain/src/opening/teaching-coverage.ts` | `SourceAnchor`, coverage table, `anchorKey`, `mergeCoverageStatus`, local `lexicalOverlapScore` |
| `packages/domain/src/opening/teaching-coverage.test.ts` | Domain coverage unit tests (E1/E2 overlap + merge + no mastery %) |
| `packages/ai/src/opening/teaching-evidence.ts` | `assembleTeachingEvidencePack`, `classifyClaimSupport`, `assertNoHeldOutLeak`, `formatProviderContext` |
| `packages/ai/src/opening/teaching-evidence.test.ts` | E1–E10 + allowlist / classify / AN-RN-08 |

### Updated (exports only)

| Path | Change |
|---|---|
| `packages/domain/src/index.ts` | Export teaching-coverage types + helpers |
| `packages/ai/src/index.ts` | Export teaching-evidence API |

### Explicitly not touched

- No migrations / ALTER / `0055_*` (tip migr still **0054**)
- No `apps/worker/.../tutor-turn.ts` wiring
- No edits to `context.ts` / `citations.ts` / `pick-sources.ts` / `tutor-chunks.ts`
- No Package C miss-fallback or Package D soft `resolveCitations` changes
- No mastery / confidence % fields
- No `tasks.json` → verified; no push / commit / hermes / stash / reset

## Design notes landed

- **Domain-only overlap:** `lexicalOverlapScore` is a local keyword/CJK helper in domain (domain cannot depend on `@aistudy/ai`).
- **`anchorKey`:** `${sourceId}@${sourceVersion}#${chunkId}` — never page-alone.
- **Coverage statuses:** `covered` (score>0), `partial` (anchors on linked sources, score==0), `uncovered` (no anchors), `conflict` via `conflicts?: string[]` option or `markConflict`.
- **`mergeCoverageStatus`:** worst-wins `conflict > uncovered > partial > covered`.
- **Assemble order:** privacy drop → allowlist → denylist.sourceIds drop → `assertNoHeldOutLeak` → `selectContext` (Package C intact) → anchors → coverage → boundaries.
- **`formatProviderContext`:** reuses `renderContext` UNTRUSTED delimiters.
- **`classifyClaimSupport`:** citation id without text overlap ≠ `material_reorg` (AN-RN-06); honors `generated_example` / `supplemental` / `inference` when no material support.
- **Boundaries:** `heldOutExcluded`, `privacyExcludedSourceIds`, `noMaterials`, `externalSearch` (`unavailable` \| `not_used`).

## Commands run + results

### Tip

```text
$ git rev-parse HEAD
cccc39272fd3a7d565a946b3979d0231220cbee2
```

**Result:** exit 0 — matches required tip. Working tree dirty only with V2-06 product files + pre-existing untracked docs (no commit).

### Unit + Package C/D regressions

```text
$ node node_modules/vitest/vitest.mjs run --project unit \
  packages/domain/src/opening/teaching-coverage.test.ts \
  packages/ai/src/opening/teaching-evidence.test.ts \
  packages/ai/src/opening/context.test.ts \
  packages/ai/src/opening/citations.test.ts
```

**Result:** exit 0 — **4 files / 51 tests passed**  
- `teaching-coverage.test.ts`: **7** passed  
- `teaching-evidence.test.ts`: **13** passed (E1–E10 + extras)  
- `context.test.ts` + `citations.test.ts`: regressions green (Package C/D untouched)

### Typecheck

```text
$ ./node_modules/.bin/tsc -p packages/domain/tsconfig.json --noEmit
$ ./node_modules/.bin/tsc -p packages/ai/tsconfig.json --noEmit
```

**Result:** exit 0 both — no errors.

## E1–E10 checklist

| ID | Case | Status |
|---|---|---|
| E1 | Cross-source same page → distinct `anchorKey`s; reject page-alone | **pass** (domain + ai) |
| E2 | Overlong slideLabel — identity fields preserved | **pass** |
| E3 | Chinese paraphrase — Package C may fill; coverage honesty separate | **pass** |
| E4 | Zero-relevance — non-empty pack **and** uncovered/partial rows | **pass** |
| E5 | Image-only — pack allows image chunk; no forged text `material_reorg` | **pass** |
| E6 | Privacy excluded omitted; all-excluded → `noMaterials` | **pass** |
| E7 | Held-out denylist leak → `assertNoHeldOutLeak` throws (reads V2-02 JSON) | **pass** |
| E8 | `formatProviderContext` contains UNTRUSTED delimiters | **pass** |
| E9 | External search unavailable → boundary; zero fake cites | **pass** |
| E10 | Soft `resolveCitations` still default (unknown id → `[]`) | **pass** |

## `not_run` list

| Check | Reason |
|---|---|
| Live provider payload inspection | Unit-only slice; `formatProviderContext` asserted via `renderContext` string |
| Browser / E2E | Not in M1 scope |
| `tutor-turn` integration / adapter | Explicitly deferred; optional later |
| Durable coverage DDL / migrate apply | **No DDL** this slice (PM + Plan ACCEPT) |
| `pick-sources` / `tutor-turn*.test.ts` full worker suite | Not required for M1 honesty modules; context+citations regressions run |
| Push / commit | Forbidden this slice |

## Ask

**Please Integrator Accept** V2-06 Implement (independent Accept; re-run named vitest commands above).  
Do **not** treat this evidence as self-ACCEPT. Do **not** mark `tasks.json` verified until Accept.
