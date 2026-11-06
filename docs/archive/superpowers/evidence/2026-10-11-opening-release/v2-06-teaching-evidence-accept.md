# V2-06 accept — Teaching evidence Implement (pack + coverage + claim kinds)

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Integrator Accepting AI (executor / Grok Bot) — Implement ACCEPT  
**Branch:** `feat/opening-release`  
**Tip HEAD (dirty tree, no commit):** `cccc39272fd3a7d565a946b3979d0231220cbee2` (`cccc392`)  
**Implement evidence:** `docs/superpowers/evidence/2026-10-11-opening-release/v2-06-teaching-evidence-implement.md`  
**Plan ACCEPT:** `docs/superpowers/evidence/2026-10-11-opening-release/v2-06-teaching-evidence-plan-accept.md`  
**Gates:** `docs/superpowers/plans/opening-release/review-test-gates.md`  
**Verdict:** **ACCEPT**

## Scope of this accept

Independent Implement ACCEPT of V2-06 teaching evidence (domain coverage + AI pack assembly + E1–E10 unit) against Plan ACCEPT + PM locks (M1 **no DDL**, in-memory pack, no forged sources) + Package C/D preserved. Implementer ≠ accepter. **No** migrate apply / tutor-turn product wiring / commit / push / stash / reset / hermes.

## Authority compared

| Artifact | Role |
|---|---|
| `v2-06-teaching-evidence-plan.md` | Design (APIs, assemble order, E1–E10, rejected alts, no DDL prefer) |
| `v2-06-teaching-evidence-understand.md` | Restatement / inventory |
| `v2-06-teaching-evidence-plan-accept.md` | Plan ACCEPT + soft gaps for Implement |
| `v2-06-teaching-evidence-implement.md` | Claimed inventory + commands |
| Working tree vs tip `cccc392` | Uncommitted product files + exports only |

## Diff scope confirmed

### Present (dirty, untracked product + modified exports)

| Path | Role |
|---|---|
| `packages/domain/src/opening/teaching-coverage.ts` (+ `.test.ts`) | `SourceAnchor`, coverage table, `anchorKey`, `mergeCoverageStatus`, local `lexicalOverlapScore` |
| `packages/ai/src/opening/teaching-evidence.ts` (+ `.test.ts`) | `assembleTeachingEvidencePack`, `classifyClaimSupport`, `assertNoHeldOutLeak`, `formatProviderContext` |
| `packages/domain/src/index.ts` | Export teaching-coverage types + helpers (+14 lines) |
| `packages/ai/src/index.ts` | Export teaching-evidence API (+10 lines) |

### Explicitly not touched (git status clean)

- `packages/database/src/migrations/` — tip still ends at **`0054_opening_teaching_content.sql`**; **no `0055_*`**
- `apps/worker/src/jobs/tutor-turn.ts` — no wiring
- `packages/ai/src/opening/context.ts` / `citations.ts` / `pick-sources.ts` / `tutor-chunks.ts`

## Stronger review (diff vs plan + PM locks)

### PM / Plan freeze matrix

| # | Lock | Result | Evidence |
|---|---|---|---|
| 1 | M1 **no DDL** / in-memory `TeachingEvidencePack` | **PASS** | No migration file; pack is a plain TS object; migr tip **0054** |
| 2 | No forged sources when no materials | **PASS** | Empty/all-privacy-excluded → `boundaries.noMaterials`; E9 zero fake cites |
| 3 | Reuse `selectContext` / `renderContext`; no second chunk loader | **PASS** | `assembleTeachingEvidencePack` calls `selectContext`; `formatProviderContext` ≡ `renderContext` |
| 4 | Anchors = `sourceId@sourceVersion#chunkId`; never page-alone | **PASS** | `anchorKey`; E1 domain + ai |
| 5 | Coverage `covered\|partial\|uncovered\|conflict`; merge worst-wins | **PASS** | `buildCoverageTable` + `mergeCoverageStatus` (`conflict > uncovered > partial > covered`) |
| 6 | Claim kinds; citation-id ≠ `material_reorg` (AN-RN-06) | **PASS** | `classifyClaimSupport`; cite-only → not `material_reorg` |
| 7 | Held-out + privacy + externalSearch boundaries | **PASS** | `assertNoHeldOutLeak` (E7 reads V2-02 denylist/allowlist JSON); E6/E9 |
| 8 | Package C miss-fallback + Package D soft citations preserved | **PASS** | E4 non-empty pack + uncovered/partial; E10 `resolveCitations` soft default; context/citations regressions green |
| 9 | No mastery / confidence % | **PASS** | AN-RN-08 domain + ai; no % fields on pack/coverage API |
| 10 | No tutor-turn product change / no Package C/D undo | **PASS** | Worker + context/citations/pick-sources/tutor-chunks clean |

### Soft gaps from Plan ACCEPT — Implement disposition

| Soft gap (Plan ACCEPT) | Disposition |
|---|---|
| `covered` support check TBD (must not be citation-id-only) | **Resolved** — `lexicalOverlapScore > 0` (domain-local keyword/CJK); citation id alone yields 0 → never `covered` / `material_reorg` |
| Fixture `version: "v1"` vs numeric `sourceVersion` | **OK** — tests use numeric `sourceVersion`; UUID synthetic sourceIds for chunks; E7 maps real V2-02 JSON for deny/allow |
| Tutor-turn wiring optional in M1 | **Honored** — not wired; honest `not_run` |
| No DDL this slice | **Honored** |

### Anti-hide / E1–E10 honesty

| ID | Intent | Integrator read |
|---|---|---|
| E1 | Cross-source same page → distinct anchors; reject page-alone | Real `anchorKey` asserts in domain + assemble |
| E2 | Overlong slideLabel — identity preserved | Real fields on `SourceAnchor` |
| E3 | Chinese paraphrase — Package C may fill; coverage honesty separate | Soft on ranking path; **does not** allow `covered` without anchors — not loosened |
| E4 | Zero-relevance → non-empty pack **and** uncovered/partial | Asserts both Package C fill and coverage honesty |
| E5 | Image-only in pack; no forged text `material_reorg` | Empty text + `imageObjectKey`; classify rejects material claim |
| E6 | Privacy omit; all-excluded → `noMaterials` | Both branches asserted |
| E7 | Held-out leak throws | Fixture denylist + direct assert + assemble path |
| E8 | UNTRUSTED delimiters | `formatProviderContext` contains open/close markers |
| E9 | External search unavailable → boundary; zero fake cites | Empty pack + classify rejects invented id |
| E10 | Soft `resolveCitations` default | Module-level soft default (tutor boundary deferred) |

No evidence of tests weakened to match broken code.

## Commands re-run by Integrator (cwd: repo root)

### Tip

```text
$ git rev-parse HEAD
cccc39272fd3a7d565a946b3979d0231220cbee2
```

**Result:** exit 0 — matches required tip. Dirty only with V2-06 product + exports + pre-existing untracked docs.

### Vitest (exact command from implement evidence)

```text
$ node node_modules/vitest/vitest.mjs run --project unit \
  packages/domain/src/opening/teaching-coverage.test.ts \
  packages/ai/src/opening/teaching-evidence.test.ts \
  packages/ai/src/opening/context.test.ts \
  packages/ai/src/opening/citations.test.ts
```

**Result:** exit 0 — **4 files / 51 tests passed** (re-run ~11:24 CST)  
- `teaching-coverage.test.ts`: **7** passed  
- `teaching-evidence.test.ts`: **13** passed (E1–E10 + allowlist / classify / AN-RN-08)  
- `context.test.ts` + `citations.test.ts`: Package C/D regressions green  

### Typecheck

```text
$ ./node_modules/.bin/tsc -p packages/domain/tsconfig.json --noEmit
$ ./node_modules/.bin/tsc -p packages/ai/tsconfig.json --noEmit
```

**Result:** exit 0 both — no errors.

## `not_run` list

| Check | Reason |
|---|---|
| Live provider payload inspection | Unit-only; `formatProviderContext` asserted via `renderContext` string |
| Browser / E2E | Not in M1 scope |
| `tutor-turn` integration / adapter wiring | Explicitly deferred (Plan + Implement); no product change |
| Durable coverage DDL / migrate apply | **No DDL** this slice (PM + Plan ACCEPT) |
| `pick-sources.test.ts` / `tutor-turn*.test.ts` full worker suite | Not required for M1 honesty modules; context+citations regressions re-run |
| Push / commit / hermes / stash / reset | Forbidden this slice |

Browser / migrate were **not** acceptance criteria for this M1 module slice → do not block ACCEPT.

## Soft gaps (do not overturn ACCEPT)

1. **E3 ranking assertion soft** — does not pin Chinese paraphrase → specific chunk ranking; still forbids `covered` without anchors.
2. **E10 at module boundary** — soft `resolveCitations` checked in `teaching-evidence.test.ts` + `citations.test.ts`, not via `tutor-turn.ts` (wiring deferred).
3. **`classifyClaimSupport` never auto-emits `conflict` kind** — coverage conflict is caller-driven (`conflicts` / `markConflict`); claim-kind `conflict` remains available on the type for later consumers (V2-09).
4. **Fixture harness** uses synthetic UUID chunks for most cases; E7 alone loads V2-02 allowlist/denylist JSON. Richer sources-index → chunkHints mapping can grow later without changing API.
5. **`heldOutExcluded`** is true when any denylist list is non-empty (used), not only when a row was dropped — acceptable M1 boundary flag.

## Tree / discipline confirmation

| Check | Result |
|---|---|
| Tip | `cccc392` |
| Migrations | End at **0054**; **no 0055**; **no migr #** this slice |
| tutor-turn / Package C/D product files | Untouched |
| This accept writes | Accept evidence only |
| ALTER / migrate / psql / commit / push / hermes / stash / reset | **Not run** |

## Verdict

**ACCEPT** Implement for V2-06 teaching evidence (AI).

- Required runnable checks re-run green (vitest 51/51; domain+ai tsc 0).
- Every skipped check listed `not_run` without pretending pass.
- PM locks held: no DDL, in-memory pack, no forged sources, Package C/D kept, tutor-turn unchanged.
- Soft gaps above are non-blocking.
- **Do not** treat Implement evidence as self-ACCEPT. Integrator may move `tasks.json` → `verified` when the parent process updates status.
