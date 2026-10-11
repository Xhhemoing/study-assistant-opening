# V2-15 Plan — Same-semantics operable matrix_transform illustration

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Experience (executor / Grok Bot)  
**Branch tip:** `267f9d2e983524e3f2487bb0d9237dc827e7e43a` (`267f9d2`, `feat/opening-release`) — matches V2-14 Experience-half tip baseline `267f9d2`  
**Stage:** Plan only — **Integrator Plan ACCEPT required before Implement**  
**Hard rules:** No product Implement · no ALTER · no push / hermes / stash / reset / commit · no self-ACCEPT · no `tasks.json` verified · migration placeholder **`00xx`** only if Integrator demands (tip migrations end **0057**; **prefer no DDL**)  
**Align:** `plan.md` §V2-15; Understand `v2-15-matrix-transform-understand.md`; PM locks 1–7; charter G1/G5/G6; sources R06/E03/E04; gates `review-test-gates.md`  
**Owner split:** Experience（前端/交互/a11y）+ Data（domain math model / contracts / allowlist）— see §2

## 1. Smallest design

### 1.1 Concepts

| Concept | Responsibility | Does not own |
|---|---|---|
| **MathModel / MatrixTransformParams** | Single semantic source: matrices + labels + optional expression strings; pure apply/step | Free-form animator; separate LLM prose channel |
| **Catalog id `matrix_transform`** | Allowlisted render target in Experience catalog + domain plan allowlist | OpenMAIC / html / script / arbitrary React |
| **matrix-transform UI** | Pause / reset / step / keyboard; reduced-motion; text alternative; static fallback | Server authorize reveal; mastery inference |
| **interactionParams[blockId]** | Optional runtime UI state (paused, stepIndex) nested in V2-14 bag | Authoritative matrix numbers (those live in block content) |
| **Static fallback** | Same params → HTML table + 文字 when interactive path unavailable | Inventing new params when catalog rejects |

### 1.2 Link graph

```
Compile / library block (blockType=matrix_transform)
        │  content = MatrixTransformParams (same object)
        ▼
Data: teaching-plan allowlist + normalize aliases (matrix-viz → matrix_transform)
Data: teaching-math-model.ts  (parse / caps / apply / step / formatLabels)
        │
clientInit.blocks[].content  ──►  Experience catalog normalizeToCatalogId
        │                              │
        │                    ok: matrix_transform
        │                              ▼
        │                    blocks/matrix-transform.tsx
        │                      ├─ interactive (step/pause/…)
        │                      ├─ prefers-reduced-motion → discrete / text-alt
        │                      └─ text alternative panel (same labels)
        │
        └── fail / flag off / parse soft-fail
                              ▼
                     StaticTable + 文字 from same params
                     (retain params; do not drop silently)

Optional resume: checkpoint.interactionParams[blockId] = { paused, stepIndex }
```

### 1.3 Core rules

1. **One semantic source (G5 / PM lock 1):** Input matrix, output matrix, and prose labels are **derived or stored fields of one** `MatrixTransformParams`. Forbidden: model emits `prose` independently of `matrixA` / `matrixB` / `vector` without a shared schema; forbidden: UI invents numbers not in params.
2. **Pure functions in domain:** `parseMatrixTransformParams`, `assertDimCompatible`, `applyLinearMap` / `stepApply`, `formatMatrixCells`, `buildTextAlternative` — no DOM, no provider I/O.
3. **Expression ↔ numeric consistency:** If both `expression` (e.g. `"Ax"`) and numeric matrices exist, display labels must reference the same A/x; unit tests bind fixture A=(1,1;0,0) rank-1 kernel cases (align design `validate_design.py` test_18 spirit).
4. **Controlled catalog only (E03/E04):** Extend `CATALOG_IDS` + domain `ALLOWED_TEACHING_BLOCK_TYPES`; reject `execute_javascript`, raw HTML, iframe sandboxes for model code.
5. **No arbitrary animator (PM lock 4):** M1 interaction = discrete **step** through application (e.g. highlight column / accumulate output cell) or pause/resume of that stepper — **not** a generative CSS/JS animation DSL.
6. **a11y (R06 learner control):** pause / reset / step buttons; keyboard (Space=pause/resume, Home=reset, ←/→ or [/] = step back/forward — exact keys in Implement); `prefers-reduced-motion: reduce` disables autoplay/continuous tween; always offer **文字替代** panel with the same numeric tables + labels.
7. **Fallback (PM lock 3 / plan.md rollback):** If interactive component unavailable (flag, load error, or Experience chooses static-only), render static `<table>` + prose from the same parsed params; **keep params** in DOM `data-*` or accessible text for debug — never strip content to empty unknown card when parse succeeded.
8. **Checkpoint nest:** Runtime UI state may write `interactionParams[blockId]` via existing V2-14 checkpoint CAS; merge must preserve V2-11 prefs + V2-12 command keys (existing helpers).
9. **Honesty (G6):** Pretty viz ≠ verified math correctness; verification status remains V2-09 concern; do not auto-grade from stepping.
10. **No DDL (default):** No new tables; tip stays at **0057** unless Integrator assigns `00xx`.
11. **History:** Old activities with matrix-viz collapsed to text stay text until recompiled; no invented backfill of MathModel.
12. **No push/hermes; no Implement until Plan ACCEPT.**

### 1.4 Param sketch (not implemented this slice)

```ts
// packages/domain/src/opening/teaching-math-model.ts  — NEW (Data)
// packages/contracts/src/opening/teaching-math-model.ts — NEW (Data; PM lock: new file only, do not fold into teaching-content)

type Matrix = number[][]; // row-major; rectangular; M1 max 4×4

matrixTransformParamsSchema = {
  version: literal(1).default(1),
  // Same semantic payload:
  matrixA: Matrix,                    // required linear map
  vectorX: number[],                  // required input vector (len = cols of A)
  // Optional explicit output (if omitted, domain computes A·x)
  vectorY: number[].optional(),
  // Labels / prose — MUST be consistent with matrices (same object)
  labelA: string.max(80).optional(),  // e.g. "A"
  labelX: string.max(80).optional(),  // e.g. "x"
  labelY: string.max(80).optional(),  // e.g. "Ax"
  title: string.max(120).optional(),
  prose: string.max(2000).optional(), // explanation; may template from labels
  expression: string.max(200).optional(), // e.g. "y = Ax"
  // Interaction hints (content-level defaults; runtime may override in interactionParams)
  stepMode: enum["by_entry", "by_column", "all_at_once"].default("by_column"),
  autoplay: boolean.default(false),   // default off; reduced-motion forces off
}.strict()

// Caps
MAX_DIM = 4
MAX_ABS = 1e6
DISPLAY_DECIMALS = 6

// Pure API
parseMatrixTransformParams(raw: unknown): { ok:true, value } | { ok:false, errors }
dimsCompatible(A, x): boolean
applyMap(A, x): number[]              // throws/returns err on mismatch
stepPlan(params): Step[]              // discrete steps for UI
buildTextAlternative(params): string  // tables + labels as plain text
staticFallbackModel(params): { rowsA, rowsY, prose }
```

**Runtime interactionParams[blockId] sketch (optional):**

```ts
{ paused?: boolean, stepIndex?: number, showTextAlt?: boolean }
```

## 2. Ownership split — Experience vs Data

| Path / concern | Owner | Notes |
|---|---|---|
| `packages/domain/src/opening/teaching-math-model.ts` (+ `*.test.ts`) | **Data** | Pure parse/caps/apply/step/text-alt; export from `packages/domain/src/index.ts` |
| `packages/contracts/src/opening/teaching-math-model.ts` (+ test) **NEW** | **Data** | Zod schemas; export from contracts index |
| `packages/domain/src/opening/teaching-plan.ts` allowlist + aliases | **Data** | Add `matrix_transform` to `ALLOWED_TEACHING_BLOCK_TYPES`; remap `matrix-viz`/`matrix_viz`/`matrixviz` → **`matrix_transform`** (breaking change vs today’s →`text` — intentional once V2-15 ships; document in evidence) |
| Generation / compile emit of `blockType` | **Data** (if generator lists intended types) | Only emit when MathModel validates; else fall back to `formula`/`text` |
| `apps/web/.../component-catalog.ts` | **Experience** | Add `matrix_transform` to `CATALOG_IDS` + `BLOCK_TYPE_ALIASES` |
| `apps/web/.../block-renderer.tsx` | **Experience** | Switch case → mount MatrixTransform (or static fallback helper) |
| `apps/web/.../teaching/blocks/matrix-transform.tsx` **NEW** | **Experience** | Interactive UI + a11y + reduced-motion + text-alt + static mode |
| `apps/web/.../teaching/blocks/` directory **NEW** | **Experience** | First block package folder |
| Checkpoint `interactionParams` persistence | **Reuse V2-14** (Data routes already); Experience may POST step state | Prefer soft-persist; empty default OK |
| Feature flag / rollback | **Experience** | Workspace or catalog-level flag: interactive off → static only; never disguise missing viz as “AI wrong” |
| DDL / migration | **Integrator** | Plan default **none** |
| V2-16 loop / e2e teaching spec | **OOS** | Later slice |
| `tasks.json` verified | **Accept only** | Not this Plan slice |

**Sequencing (PM lock):** **Data-first** — Data lands contracts + domain + allowlist (+ fixtures); after Data ACCEPT + PM gate, Experience wires catalog + UI against exported pure functions. Exclusive trees.

## 3. Controls & a11y

| Control | Behavior |
|---|---|
| **Pause** | Stops autoplay / freezes current stepIndex |
| **Reset** | stepIndex → 0; clear transient highlights; restore input view |
| **Step** | Advance (and optional back) one discrete step from `stepPlan` |
| **Keyboard** | Focusable toolbar; Space pause/resume; Home reset; Arrow/Bracket step — Implement documents exact map + `aria-keyshortcuts` |
| **`prefers-reduced-motion`** | No autoplay; skip tween; may jump to final `vectorY` with step list collapsed; text-alt still available |
| **文字替代** | Toggle panel: monospace / table dump of A, x, y + `prose`/`expression`/`labels` from same params |
| **Screen reader** | `role="group"` / `aria-label` from title; live region optional on step change (polite) |

## 4. Fallback path

| Condition | Render |
|---|---|
| Catalog maps to `matrix_transform` + component available + params ok | Interactive (or reduced-motion discrete) |
| Catalog maps + params ok + interactive flagged off / error boundary | **Static table + 文字** via `staticFallbackModel` / `buildTextAlternative` |
| Params fail parse but partial numeric rows present | Honesty status + best-effort static numbers + error list; retain raw params in `data-math-params-error` |
| blockType unknown and unparseable | Existing `unknown_component` fail-soft card |
| answer_key role | Unchanged V2-10 hidden path — matrix_transform must **not** be used as answer_key carrier |

**Rollback (plan.md):** Disable interactive catalog case → static path only; parameters remain in content / checkpoint.

## 5. Test plan (Implement; all `not_run` at Plan stage)

| ID | Layer | Check |
|---|---|---|
| T1 | domain | parse accepts well-formed 2×2 + vector; rejects non-rectangular |
| T2 | domain | **zero matrix** → y = 0 vector |
| T3 | domain | **identity** → y = x |
| T4 | domain | **rank-1** A=(1,1;0,0) + kernel vectors → y=0; non-kernel → expected |
| T5 | domain | **negatives / decimals** within caps; display rounding stable |
| T6 | domain | **dim mismatch** (cols(A) ≠ len(x)) → ok:false / explicit err |
| T7 | domain | **param caps** 5×5 or abs>MAX_ABS → reject |
| T8 | domain | expression/labels present → `buildTextAlternative` contains labelA/labelX and numeric cells (**expression↔numeric consistency**) |
| T9 | domain | `stepPlan` length ≥ 1; reset semantics idempotent |
| T10 | contracts | zod round-trip; strip unknown keys `.strict()` |
| T11 | teaching-plan | `normalizeBlockTypes` keeps `matrix_transform`; maps matrix-viz → `matrix_transform` |
| T12 | catalog | `normalizeToCatalogId("matrix_transform")` → catalog id; decideBlockRender ok |
| T13 | catalog | illegal html/script in content still fail-soft illegal_link/action |
| T14 | component | vitest: pause/reset/step state machine (jsdom); keyboard handlers |
| T15 | component | reduced-motion media query → no autoplay class / discrete mode |
| T16 | component | static fallback renders tables when `interactive={false}` |
| T17 | renderer | BlockRenderer mounts matrix path; unknown still fail-soft |
| T18 | resume bag | writing interactionParams[blockId] preserves interventionPrefs + commandLog (reuse V2-14 merge tests spirit) |
| T19 | typecheck | packages domain/contracts + apps/web affected projects |
| T20 | browser | **pending_user** — visual/keyboard on real device; do not treat “looks pretty” as math correct |

**Plan-stage:** all **`not_run`**. Browser remains `pending_user` per tasks.json.

## 6. Files / tasks preview (Implement after ACCEPT)

| Path | Action | Owner | Deps |
|---|---|---|---|
| `packages/contracts/src/opening/teaching-math-model.ts` (+ test) | **NEW** | Data | — |
| `packages/contracts/src/opening/index.ts` | Export | Data | contracts file |
| `packages/domain/src/opening/teaching-math-model.ts` (+ test) | **NEW** | Data | contracts (or colocated types) |
| `packages/domain/src/index.ts` | Export | Data | domain file |
| `packages/domain/src/opening/teaching-plan.ts` (+ test update) | Allowlist + alias remap | Data | — |
| `apps/web/src/features/opening/teaching/component-catalog.ts` (+ test) | Add catalog id + aliases | Experience | Data allowlist agreed |
| `apps/web/src/features/opening/teaching/block-renderer.tsx` (+ test) | Case + fallback | Experience | catalog + component |
| `apps/web/src/features/opening/teaching/blocks/matrix-transform.tsx` (+ test) | **NEW** | Experience | domain pure API |
| Optional: `teaching-workspace-flag` / catalog interactive flag | Edit | Experience | — |
| Migrations | **None** (default) | Integrator if later | — |

**Not touching:** V2-16 e2e loop; tutor conversation resume; inventing mastery; OpenMAIC; push/hermes; `tasks.json` verified.

### Rejected alternatives

| Alt | Why rejected |
|---|---|
| Separate LLM prose params vs viz params | PM lock 1 / G5 same-semantics |
| Free-form CSS/JS animation generator / model HTML | PM lock 4; V2-10 HTML ban; E03/E04 |
| Keep matrix-viz→text forever and only pretty-print text | Misses plan.md acceptance (on-demand interactive) |
| Skip-only `unknown_component` with no static table when params valid | Violates rollback / PM lock 3 |
| New DB table for matrix steps | Prefer checkpoint nest; no DDL |
| Infer mastery / graded attempt from step events | G6 honesty; facts ledger |
| Implement OpenMAIC-style free widget host | Explicit OOS |
| Experience invents local MathModel duplicate without domain package | Breaks Data alignment (PM lock 5) |
| Require arbitrary animator for ACCEPT | plan.md acceptance says opposite |

## 7. Acceptance checks

### 7.1 Plan ACCEPT (docs-only — this stage)

Integrator / designated Reviewer may **ACCEPT** this Plan when:

1. Understand + Plan restatement matches `plan.md` §V2-15 + PM locks (same-semantics, controls, fallback, no arbitrary animator).
2. Ownership table is explicit and actionable (Data vs Experience).
3. Every claim cites inventory paths or marks **NEW**.
4. OOS excludes V2-16 / OpenMAIC / mastery invention / Implement this turn.
5. Test IDs T1–T20 listed with `not_run`; browser `pending_user`.
6. DDL default = **none**; tip **0057**.
7. No product code landed in this slice; no self-ACCEPT of Implement.

### 7.2 Later Implement ACCEPT (after authorized Implement)

1. Independent Accept re-runs named vitest/typecheck; lists `not_run` honestly (`review-test-gates.md`).
2. Domain T2–T8 green (zero/identity/rank-1/negatives/decimals/mismatch/caps/consistency).
3. Catalog includes `matrix_transform`; legacy matrix-viz no longer collapses to text after Data remap.
4. UI exposes pause/reset/step/keyboard; reduced-motion path verified in unit or manual note.
5. Fallback static table+文字 demonstrated when interactive off.
6. user_browser remains **pending_user** until Paula/user runs device check — pretty ≠ correct.
7. No DDL unless Integrator-assigned `00xx` evidence attached.
8. Only Accept may move `tasks.json` → `verified`.

## 8. Soft gaps / PM design locks (2026-10-11 recorded)

**Locked by PM (encode in Implement; do not reopen):**
1. Canonical id **`matrix_transform`**; aliases `matrix-viz` / `matrix_viz` / `matrixviz` → remap to it (no longer collapse to `text`).
2. M1 **real numbers only**, ≤**4×4**; complex/symbolic **OOS**.
3. **autoplay default off**; `prefers-reduced-motion` **forces** motion off.
4. `stepIndex` / `paused` may soft-write `interactionParams[blockId]` (cross-device resume); empty default OK.
5. Contracts **new file only** `teaching-math-model.ts` — **do not** fold into `teaching-content.ts`.
6. **Data-first** (contracts/domain/allowlist) → Experience UI half; exclusive trees.
7. This slice: domain unit fixtures required; compiler emit of first-unit real matrix content may follow-up and must not block this slice ACCEPT.

Remaining soft gaps (non-blocking): browser/device visual check pending_user; pretty ≠ correct.

## 9. Implement gate (after Plan ACCEPT)

1. Integrator **ACCEPT** this Plan (and Understand).  
2. PM / Paula opens Implement authorization (Experience and/or Data as sequenced).  
3. Implement follows ownership table + tests T1–T19; browser T20 pending_user.  
4. Evidence under `docs/superpowers/evidence/<date>-opening-release/…` per gates.  
5. **This document does not authorize product code, ALTER, commit, push, or hermes.**

## 10. Dirty tree note

Unrelated untracked evidence files may exist on the worktree (`rp5-gha-…`, `p0-assistant-list-preview-failsoft-implement.md`); **not** touched. No stash/reset. This slice writes **only** the two V2-15 docs under `docs/superpowers/plans/ai-led-learning-v2/`.
