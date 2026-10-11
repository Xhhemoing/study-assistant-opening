# V2-06 Understand — 建立来源包、覆盖关系与证据定位

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy AI (executor)  
**Branch tip:** `cccc39272fd3a7d565a946b3979d0231220cbee2` (`cccc392`, `feat/opening-release`) — matches required tip  
**Delivery-loop stage:** Understand → Plan only (**no Implement, no product code, no migrations, no push / hermes / stash / reset / commit**)  
**Authority:** `plan.md` §V2-06; `tasks.json` V2-06; reuse C04 / C10 / P01; align V2-02 fixtures + V2-05 `ActivitySpec.sourceRefs`

## Restated outcome

Teaching generation and tutor assembly must carry an **honest evidence pack**: authorized, version-pinned chunks; a **coverage table** that maps goals / claim conditions → source anchors; and **claim-kind labels** so material-backed statements are distinguishable from generated examples, supplements, inferences, conflicts, and uncovered gaps.

Concretely:

1. Reuse today’s authorized chunk loader (`chunksAtSnapshots`) + budgeted `selectContext` / `renderContext` — do **not** fork a second chunk loader or undo Package C miss-fallback (zero lexical score still budget-fills usable chunks).
2. Anchors are **identity tuples**: `sourceId + sourceVersion + chunkId` plus optional locator (`page` / `slideLabel` / `startMs`). Page alone across sources is never a valid anchor (AN-RN-01).
3. Coverage rows make **uncovered** conditions visible; retrieval quality is never faked as a mastery / confidence %.
4. Held-out eval material (`eval-heldout/`) and privacy-excluded sources never enter teaching retrieval packs; no materials → no forged citations.
5. Soft Package D citation resolve stays the default for tutor turns (unknown ids dropped, never fabricated). Coverage / claim-support is an **orthogonal honesty layer**, not a replacement for soft resolve.

## Out of scope (OOS) for V2-06 Understand→Plan

- **No Implement** of `teaching-evidence.ts` / `teaching-coverage.ts` or any `apps/` / `packages/` product code.
- No migrations / ALTER; no inventing DDL numbers.
- Pipeline worker `compile-teaching-unit` (V2-07) — Plan may name a thin adapter; this slice does not land the job.
- Full layered verification / publish gate (V2-09); Experience render of coverage UI.
- External web search inventing sources; mastery % / fake confidence from citation id alone (AN-RN-06 / AN-RN-08).
- Push / hermes / stash / reset / commit; `tasks.json` status changes.

## Gap table — already present vs missing for teaching coverage / claim kinds

| Layer | Already does (tip `cccc392`) | Missing for V2-06 |
|---|---|---|
| Version-pinned chunks | `chunksAtSnapshots` loads `listChunksAtVersion` per `sourceId`+version; missing snapshot/chunks throw | No teaching-pack wrapper; no allowlist/denylist assert over fixture or product packs |
| Context assembly | `selectContext` ranks + budget-fills; Package C miss-fallback when all scores 0; `renderContext` UNTRUSTED delimiters | No coverage table; miss-fallback ≠ “covered” — honesty layer not yet attached |
| Citations | `resolveCitations` soft-default drops unknown ids; never fabricates rows; soft page prefer via `preferCitationsForPage` | Citation id ≠ claim support (AN-RN-06); no claim-kind taxonomy; no conflict/uncovered status |
| Source pick | `shouldAutoPickSources` only when client `sourceIds` empty & pool > K; tutor-turn **never re-narrows** explicit large selections | Teaching allowlist (V2-02) not wired into assembly; held-out denylist not machine-enforced in product path |
| Privacy | tutor-turn filters `listExcludedSourceIds`; all-excluded → hard error | Coverage / evidence pack must re-assert exclusion; plan must not weaken filter |
| Image-only | `isImageOnlySourceChunks` + vision gate; empty-text image chunks usable in selectContext | Must not invent text cites for image-only; locator may be page/image without text claim support |
| ActivitySpec (V2-05) | `teachingSourceRefSchema`: `sourceId`, optional `version` / `chunkId` / `page` on ActivitySpec | Sketch is light; V2-06 needs full **SourceAnchor** (+ slideLabel/startMs) and coverage rows — not inventing a second body store |
| V2-02 fixtures | allowlist / denylist / ISOLATION / anomaly cases / goals with `linkedSourceIds` + `successCriteria` | No engineering module that builds CoverageRow[] from those fixtures as the first sample |

## Inventory (paths Read; line-level behaviors)

### 1. `packages/ai/src/opening/context.ts`

- **`keywordOverlapScore`** (L25–37): keyword + CJK bigram overlap; no embeddings; shared with pick-sources.
- **`renderContext`** (L81–85): each chunk delimited as  
  `[source {sourceId} v{sourceVersion} {slide|page} chunk {id} — UNTRUSTED DATA]…[/source … — END UNTRUSTED DATA]`.  
  Provider path (`provider.ts`) concatenates question + this string — V2-06 `formatProviderContext` **must reuse** these delimiters, not invent a second escaping scheme.
- **`selectContext`** (L96–117): blank query → budget-only; else prefer `preferChunkId` / `preferPage` then score > 0; **Package C miss-fallback** (L107–111): if ranked empty and query non-blank, fall back to usable chunks (`text` non-empty **or** `imageObjectKey`) then `fillBudget`. Deterministic tie-break: preferred → score → sourceId → page → chunk id.
- **Invariant for V2-06:** coverage honesty must **not** change miss-fallback to empty; “budget-filled with zero lexical score” is still assembly success and should surface as **partial / uncovered claim conditions**, not as silent drop.

### 2. `packages/ai/src/opening/citations.ts`

- **`resolveCitations`** (L52–68): `soft` defaults **true** (`options?.soft !== false`); unknown cited ids filtered; never fabricates citation rows; strict mode throws `RangeError`.
- Citation rows carry `chunkId`, `sourceId`, `sourceVersion`, `label`, optional `page` / `startMs` / `slideLabel` (from chunk) — aligns with contracts `citationSchema`.

### 3. `packages/ai/src/opening/pick-sources.ts`

- **`shouldAutoPickSources`** (L57–63): true only when `clientSourceIds.length === 0` **and** `effectiveSourceIds.length > clamp(K)`. Explicit non-empty client selections are never auto-narrowed.
- tutor-turn comment (L126–128) confirms worker turns already carry persisted sourceIds — **do not re-narrow**.

### 4. `apps/worker/src/jobs/tutor-chunks.ts`

- **`chunksAtSnapshots`** (L13–27): requires `versions[sourceId]`; calls `listChunksAtVersion`; filters usable (text or imageObjectKey); empty group → throw `source material is unavailable`. Version pin is mandatory.

### 5. `apps/worker/src/jobs/tutor-turn.ts`

- **Privacy filter** (L110–116): `allowedSourceIds = turn.sourceIds.filter(!excluded)`; all excluded → throw.
- **Chunk load** (L117–122): `chunksAtSnapshots(…, allowedSourceIds, turn.sourceVersions)` only.
- **`selectContext`** (L129–135) then `.slice(0, MAX_PROVIDER_CHUNKS=64)`; preferPage defaults to 1 for image-only when `currentPage` null.
- **Soft citations** (L189–190): `resolveCitations(…, { soft: true })`.
- **Soft page guard** (L191–197): `assertCitationsForPage` is a no-op soft guard; `preferCitationsForPage` keeps on-page cites when any match, else keeps off-page rather than failing the turn (`tutor-policy.ts` L105–127).
- **No second chunk loader** — history/memories merge via `mergeContextSourceRefs`; teaching evidence must thin-adapt this path (or future compile job), not fork.

### 6. Contracts / V2-05 ActivitySpec `sourceRefs`

- Landed: `packages/contracts/src/opening/teaching-content.ts` **`teachingSourceRefSchema`** (L39–46): `{ sourceId, version?, chunkId?, page? }`.
- `activitySpecSchema.sourceRefs` (L105): array max 64.
- V2-06 SourceAnchor **extends** this sketch with required `sourceVersion` + `chunkId` for material-backed claims, plus optional `slideLabel` / `startMs`. Do not treat ActivitySpec `sourceRefs` alone as claim support.

### 7. `SourceChunk` / `Citation` (`packages/contracts/src/opening/sources.ts` L108–138)

- Chunk identity: `id`, `sourceId`, `sourceVersion`, `page`, optional `slideLabel`, `startMs`/`endMs`, `text`, `imageObjectKey` (storage-only — not vision input).
- Comment: never equate page vs slideLabel across MIME; do not dedupe by text hash.

### 8. V2-02 fixtures (first engineering sample)

| Path | Role |
|---|---|
| `tests/fixtures/opening/teaching/unit-rank-nullspace/lecture/retrieval-allowlist.json` | Authorized `SRC-RN-01…05` + examples; excludes `eval-heldout/` |
| `…/eval-heldout/ISOLATION.md` | Hard rule: held-out NEVER in teaching retrieval / tutor context / lecture exposure |
| `…/eval-heldout/retrieval-denylist.json` | `HO-RN-01…15` + denied paths; `mustNotAppearInTeaching: true` |
| `…/materials/sources-index.json` | Per-source `pages`, `version`, `chunkHints` (`chunkId`+`page`+topic) |
| `…/goals/teaching-goals.json` | `goalId`, `linkedSourceIds`, `successCriteria` / `notSuccess` → coverage **conditions** |
| `…/anomaly-cases/cases.json` | `same_page_cross_source`, `missing_page`, `citation_id_not_truth`, `fake_mastery_percent`, `audio_only_video`, … |
| `…/lecture/activity-outline.json` | Activities with `goalIds` + `sourceIds` (fixture shape; not product schema) |

## Anchor identity model (proposal)

```text
SourceAnchor = {
  sourceId: string,          // required
  sourceVersion: number,     // required (pin; aligns chunksAtSnapshots)
  chunkId: string,           // required for material-backed claims
  page?: number | null,      // optional physical page locator
  slideLabel?: string | null,// optional PPTX logical label — never equate to page across MIME
  startMs?: number | null,   // optional media timestamp
}
```

**Rules:**

1. Equality / uniqueness key for coverage = `(sourceId, sourceVersion, chunkId)`; locators are secondary.
2. **Forbidden:** “page N” alone as a cross-source cite (AN-RN-01).
3. Overlong anchor strings: truncate display labels; never drop identity fields to “fit.”
4. Align ActivitySpec `sourceRefs` when publishing (may store subset); evidence pack keeps the full anchor for claim checks.
5. Fixture ids like `SRC-RN-01` are sample strings; product path uses UUID `sourceId` per contracts — adapters map fixture → chunk shapes in tests only.

## Claim evidence kinds taxonomy

| Kind | Meaning | Cite requirement |
|---|---|---|
| `material_reorg` | Restates / reorganizes authorized material | ≥1 valid SourceAnchor into allowlisted chunks |
| `generated_example` | Model-invented worked example not copied from material | No fake source; label as generated; optional “inspired by” anchors without claiming verbatim |
| `supplemental` | Extra knowledge beyond materials | Explicit boundary; **no** forged material cite |
| `inference` | Logical step from material + general reasoning | Anchors for premises; inference marked separately |
| `conflict` | Materials disagree or claim vs chunk text conflict | Both sides anchored when possible; status `conflict`; not publishable as verified teaching (V2-09) |
| `uncovered` | Goal / successCriterion / condition has no supporting chunk in pack | Visible in coverage table; **not** filled with fake % |

**Honesty:** `resolveCitations` soft success ≠ `material_reorg`. Citation id presence ≠ truth (AN-RN-06).

## Held-out / privacy / no-material boundaries

| Boundary | Rule |
|---|---|
| Held-out | `assertNoHeldOutLeak`: denylist problemIds / paths / `eval-heldout/` must not appear in teaching retrieval packs or provider context |
| Privacy | Reuse tutor-turn exclusion filter; excluded sources omitted from pack; all-excluded with requested ids → fail closed (existing throw) |
| No materials | Empty authorized set → empty pack + all conditions `uncovered`; **never** invent sources or external search cites |
| External search unavailable | Explicit boundary string / status; not fake cites |
| Image-only / audio-only | No forged text/page when locator missing (AN-RN-05); vision/page-image path stays separate from text claim support |
| Package C miss-fallback | Still fills context; coverage marks conditions uncovered/partial rather than pretending lexical relevance |

## Open decisions for PM / Paula

Only items that change product meaning (defaults proposed; escalate if disagree):

1. **Coverage grain:** Prefer rows keyed by **goal successCriteria / claim conditions** (from goals JSON + future ActivitySpec goals), not only coarse `goalId`. **Default = condition-level** (matches acceptance “未覆盖条件可见”).
2. **Where pack attaches at runtime:** Prefer **thin adapter callable from tutor-turn *and* future `compile-teaching-unit`**, sharing `chunksAtSnapshots` + `selectContext` — not a second loader inside tutor-turn only. **Default = shared AI/domain helpers; worker calls thin.**
3. **Persistence:** Prefer **in-memory / JSON on ActivitySpec or TeachingUnit metadata** for M1 coverage snapshot; no new DDL unless query patterns force it. **Default = no migration this slice.**
4. **Strict vs soft at claim-check:** Tutor turn keeps soft citations; teaching **publish** path (later V2-09) may require strict claim support. **Default for V2-06 module = classify + report, do not hard-fail tutor turns.**

If PM ACCEPTS Plan with these defaults, no further PM gate beyond ordinary Plan ACCEPT before Implement.

## Ready for Plan?

**Yes.** Inventory closed against tip `cccc392`; reuse paths and V2-02/V2-05 attach points clear; stop here until Plan is written and Plan ACCEPT granted before any Implement.
