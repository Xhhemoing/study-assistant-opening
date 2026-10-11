# V2-06 accept — Teaching evidence Plan (source pack + coverage + claim kinds)

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Integrator (executor / Grok Bot) — Plan ACCEPT only  
**Branch:** `feat/opening-release`  
**Tip HEAD:** `cccc39272fd3a7d565a946b3979d0231220cbee2` (`cccc392`) — matches required tip  
**Stage:** Plan ACCEPT (not Implement). **No product code. No ALTER. No migr #. No push / hermes / stash / reset / commit.**  
**Gates:** `docs/superpowers/plans/opening-release/review-test-gates.md`  
**PM defaults (steering):** M1 **no DDL**; in-memory `TeachingEvidencePack`; no materials → no forged sources.  
**Verdict:** **ACCEPT**

## Scope of this accept

Accept of:

- `docs/superpowers/plans/ai-led-learning-v2/v2-06-teaching-evidence-understand.md`
- `docs/superpowers/plans/ai-led-learning-v2/v2-06-teaching-evidence-plan.md`
- Plan-stage evidence `docs/superpowers/evidence/2026-10-11-opening-release/v2-06-teaching-evidence-plan-implement.md`

against pack `plan.md` §V2-06, `tasks.json` V2-06, V2-05 ActivitySpec / `teachingSourceRefSchema` (migr **0054** content already landed), Package C miss-fallback + Package D soft citations, and V2-02 unit-rank-nullspace fixtures.

**This ACCEPT authorizes opening the Implement gate** for `teaching-evidence.ts` / `teaching-coverage.ts` + E1–E10 tests (docs → code). It does **not** land product code, invent DDL, assign a migration number, or move `tasks.json` → `verified`.

## Inputs reviewed

| Artifact | Role |
|---|---|
| `v2-06-teaching-evidence-understand.md` | Restatement + inventory |
| `v2-06-teaching-evidence-plan.md` | Design under review |
| `v2-06-teaching-evidence-plan-implement.md` | Plan-stage evidence claim |
| `plan.md` §V2-06 | Pack scope / reuse / proposed paths / acceptance / rollback |
| `tasks.json` V2-06 | Scope / verification / proposed_paths / depends_on |
| `review-test-gates.md` | Independent accept rules |
| V2-05 Plan ACCEPT + Implement ACCEPT + `0054_opening_teaching_content.sql` | Content seam (`sourceRefs`, no second body) |
| Tip spot-checks | `context.ts`, `citations.ts`, `pick-sources.ts`, `tutor-chunks.ts`, `tutor-turn.ts`, `tutor-policy.ts`, `teaching-content.ts` sourceRefs, `sources.ts` chunk/citation, V2-02 allowlist/denylist/ISOLATION/goals/sources-index/anomaly-cases |

## Stronger Plan review

### 1. Restatement ↔ pack + PM intent (no invented scope)

| Check | Result |
|---|---|
| Outcome = honest evidence pack + coverage table + claim kinds; not mastery %; not forged sources | Pass — Understand restatement; Plan §1; pack acceptance |
| Reuse `chunksAtSnapshots` + `selectContext` / `renderContext`; no second chunk loader | Pass — Plan §1 flow + §3 rejected alts; matches pack `existing_paths` |
| Anchors = `sourceId + sourceVersion + chunkId` (+ optional page / slideLabel / startMs); never page-alone across sources | Pass — `SourceAnchor` + `anchorKey`; AN-RN-01 in E1 / fixture harness |
| Coverage statuses `covered\|partial\|uncovered\|conflict`; uncovered conditions visible | Pass — Plan §2.1; condition-level grain default |
| Claim kinds: material_reorg / generated_example / supplemental / inference / conflict / uncovered | Pass — Plan §2 + Understand taxonomy |
| Held-out isolation + privacy exclude + no-material → empty pack / uncovered, never invent cites | Pass — `assertNoHeldOutLeak`, `boundaries.noMaterials`, E7/E9 |
| Package C miss-fallback preserved; Package D soft `resolveCitations` preserved; coverage orthogonal | Pass — Plan §1 Orthogonal honesty + §5 non-goals + E4/E10 |
| OOS: V2-07 compile job, V2-09 publish gate, Experience coverage UI, DDL, self-ACCEPT | Pass — Understand OOS + Plan §5/§9/§10 |
| **PM M1 no DDL** / in-memory pack / no forged sources | Pass — Plan §7 prefers in-memory pack + optional JSON on ActivitySpec/`generationConfig.extras`; §5 no forged sources. **This accept freezes M1 = no DDL** (see Migration below) |

### 2. Claims name real files/APIs; migration need clear

| Claim | Tip spot-check | Result |
|---|---|---|
| Package C miss-fallback when ranked empty | `context.ts` L107–111: usable chunks → `fillBudget` | Pass |
| `renderContext` UNTRUSTED delimiters | `context.ts` L81–85 | Pass — `formatProviderContext` must reuse |
| Package D soft default drops unknown ids; never fabricates | `citations.ts` L52–68 `soft !== false` | Pass |
| tutor-turn soft cites + soft page prefer | `tutor-turn.ts` L190–197; `tutor-policy.ts` soft assert | Pass |
| Version-pinned `chunksAtSnapshots` | `tutor-chunks.ts` L13–27; missing version/chunks throw | Pass |
| `shouldAutoPickSources` only when client ids empty | `pick-sources.ts` L57–63 | Pass — Plan forbids re-narrow |
| V2-05 `teachingSourceRefSchema` | `teaching-content.ts` L39–46: `sourceId`, optional `version`/`chunkId`/`page` | Pass — Plan maps full `SourceAnchor` → subset on publish; evidence pack keeps full identity |
| SourceChunk / Citation locators | `sources.ts` page / slideLabel / startMs; never equate page↔slide across MIME | Pass |
| V2-02 fixtures exist as first sample | allowlist SRC-RN-01…05; denylist HO-RN-01…15 + `mustNotAppearInTeaching`; ISOLATION.md; goals `successCriteria`; sources-index `chunkHints`; anomaly `same_page_cross_source` / `citation_id_not_truth` / `fake_mastery_percent` / `missing_page` / `audio_only_video` | Pass |
| Proposed paths match pack | `teaching-evidence.ts` + `teaching-coverage.ts` | Pass |
| Product Implement artifacts absent | No `teaching-evidence.ts` / `teaching-coverage.ts` on tip | Pass |
| Migrations tip | Ends at **`0054_opening_teaching_content.sql`** (V2-05); **no `0055_*`** | Pass |
| DDL needed for M1? | **No** — PM default + Plan prefer in-memory pack | Pass → **no migr # assigned** |

**Migration:** **none for V2-06 M1.** Plan §7 “Likely none” is tightened by PM steering to **hard no DDL** this slice. Optional later durable coverage tables are **out of V2-06 M1**; if ever needed in a later task, Integrator assigns `00xx` then — **do not invent** a number now. Tip migr end remains **0054**.

### 3. Tests E1–E10 cannot hide behavior; claims match real files

| ID | Intent (anti-hide) | Plan status |
|---|---|---|
| E1 | Cross-source same page → distinct anchors; reject page-alone | `not_run` (Plan stage) |
| E2 | Overlong label — identity fields preserved | `not_run` |
| E3 | Chinese paraphrase — Package C may fill; coverage honesty separate | `not_run` |
| E4 | Zero-relevance — non-empty selectContext **and** uncovered/partial rows | `not_run` |
| E5 | Image-only — pack allows image chunk; no forged text `material_reorg` | `not_run` |
| E6 | Privacy excluded omitted; all-excluded fails closed | `not_run` |
| E7 | Held-out denylist leak → `assertNoHeldOutLeak` throws | `not_run` |
| E8 | Provider payload UNTRUSTED delimiters only for allowlisted chunks | `not_run` |
| E9 | External search unavailable → boundary; zero fake cites | `not_run` |
| E10 | Soft `resolveCitations` still default at tutor boundary (regression) | `not_run` |

Rejected alts present and correct: second `listChunksAtVersion` bypass of `chunksAtSnapshots`; embedding-only retrieval that drops Package C fallback; hard-throwing claim check inside every tutor turn in M1; mastery %; citation-id-as-truth; second body store.

### 4. Embed-in-app / V2-05 activity content seam

| Edge | Check |
|---|---|
| Library / ActivitySpec remain V2-05 body authority | Pass — Plan §5 / §10 “Not touching ActivitySpec DDL”; no second body |
| `SourceAnchor` → `teachingSourceRefSchema` on publish map | Pass — Plan §2.2 Align ActivitySpec; optional slideLabel/startMs stay on evidence pack / citations for M1 |
| Optional JSON snapshot via `generationConfig.extras` (already on V2-05 schema) | Pass — no new DDL; extras already `z.record` on `teachingGenerationConfigSchema` |
| Thin adapter for tutor-turn **or** future V2-07 compile; primary consumer compile | Pass — Plan §3; does not fork loader or change soft citations |
| Pack `depends_on: [V2-02, V2-03]`; Plan also aligns V2-05 sourceRefs | Soft gap (non-blocking) — V2-05 already landed on tip `cccc392` |
| Downstream V2-08/V2-09 consume claim kinds / coverage | Pass — Plan §9 handoff; V2-06 builds honesty primitives only |

### 5. Design validators / test re-run (Plan Accept)

| Check | Status | Reason |
|---|---|---|
| Product E1–E10 | **`not_run`** | Plan stage; modules not landed — claim confirmed honest |
| `vitest` teaching-evidence / teaching-coverage | **`not_run`** | No Implement |
| `vitest` context / citations / pick-sources / tutor-turn regressions | **`not_run`** | Docs-only; plan-implement did not claim a re-run |
| `tsc` / typecheck | **`not_run`** | Docs-only |
| Provider live payload / Browser E2E | **`not_run`** | N/A this slice |
| Migration apply / ALTER | **`not_run`** | **No DDL** |

Per gates: Plan Accept does not require re-running product tests that were never claimed as pass. Confirmed: vitest / tsc / E1–E10 = **`not_run`**.

## Soft gaps (do not overturn ACCEPT; track for Implement)

1. **`covered` support check TBD:** Plan §2.1 leaves “lexical / structured check TBD at Implement; must not be citation-id-only.” Implement must pick a deterministic, testable rule (and keep AN-RN-06: citation id ≠ `material_reorg`).
2. **Fixture `version: "v1"` string vs numeric `sourceVersion`:** sources-index uses string labels; contracts `SourceChunk.sourceVersion` is `number`. Understand already notes fixture→chunk adapters in tests only — Implement harness must map explicitly (never treat page-alone as identity).
3. **`tasks.json` depends_on = V2-02, V2-03** while Plan correctly binds V2-05 `sourceRefs` / ActivitySpec extras. Non-blocking (0054 landed on tip); optional hygiene: add V2-05 to depends_on in a later pack edit.
4. **Plan §7 “Likely none” / later `00xx`:** PM freezes **M1 = no DDL**. Implement must not introduce migration SQL in this slice; durable coverage tables belong to a future task with a fresh Integrator assign.
5. **Tutor-turn wiring optional in M1:** Prefer shared helpers + fixture-first tests; thin tutor-turn adapter must not change soft citations or Package C semantics (E10 / E4 regressions required).
6. **ActivitySpec `sourceRefs` optional fields:** Full material-backed claims still need required `sourceVersion`+`chunkId` on evidence-pack anchors even when ActivitySpec stores a lighter subset.

## Tree / discipline confirmation

| Check | Result |
|---|---|
| Tip | `cccc392` (`cccc39272fd3a7d565a946b3979d0231220cbee2`) |
| Migrations on tip | End at **0054**; **no 0055**; **no migr # assigned this accept** |
| Product teaching-evidence / teaching-coverage files | Absent |
| Plan-implement claim “no Implement / no migration / no push” | Consistent with tree (only untracked Understand/Plan/plan-implement docs for V2-06) |
| This accept writes | Accept evidence only |
| ALTER / migrate / psql / commit / push / hermes / stash / reset | **Not run** |

## Verdict

**ACCEPT** Plan for V2-06 teaching evidence (AI).

- **Migration:** **none** — M1 in-memory `TeachingEvidencePack` (+ optional JSON on existing ActivitySpec / `generationConfig.extras`). **No migr # assigned.**
- Next: separate Implement may land `packages/domain/.../teaching-coverage.ts` + `packages/ai/.../teaching-evidence.ts` (+ exports/tests E1–E10, Package C/D regressions), write implement evidence — then independent Implement ACCEPT.
- Soft gaps above for Implement / optional pack hygiene; none block Plan ACCEPT.
- **No product code landed. No ALTER executed.**

