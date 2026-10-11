# V2-15 Understand — 首单元同语义可操作图示（matrix_transform）

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Experience (executor / Grok Bot)  
**Branch tip:** `267f9d2e983524e3f2487bb0d9237dc827e7e43a` (`267f9d2`, `feat/opening-release`) — equals PM tip baseline `267f9d2` (`feat(opening): V2-14 learning resume UI (Experience half)`)  
**Delivery-loop stage:** Understand → Plan only (**no Implement, no product code, no commit / push / hermes / stash / reset / self-ACCEPT / tasks.json verified**)  
**Authority:** Charter `docs/plans/2026-10-11-ai-led-learning-v2.md` G1/G5/G6; `plan.md` §V2-15 (~L625–643); `tasks.json` V2-15; gates `docs/superpowers/plans/opening-release/review-test-gates.md`; sources R06 / E03 / E04; style refs `v2-14-learning-resume-*.md` / Experience halves of `v2-10-teaching-workspace-*.md` / `v2-12-teaching-commands-*.md`  
**Do not conflate:** V2-10 catalog fail-soft (`unknown_component`) ≠ interactive viz; V2-14 `interactionParams` checkpoint bag ≠ MathModel semantics; OpenMAIC / free HTML/JS ≠ allowlisted `matrix_transform`; V2-16 full loop ≠ this widget slice.

## Restated outcome

Ship a **first-unit, same-semantics operable illustration** for linear-algebra-style teaching: one **parameter model** drives **input matrix, output matrix, and prose labels** together — the model does **not** invent figure and formula separately.

Concretely (PM design locks → restatement):

1. **Same-semantics driver:** a single MathModel / `MatrixTransformParams` yields input matrix display, output matrix display, and text labels/explanations (expression ↔ numeric consistency).
2. **Operable controls:** pause / reset / step / keyboard; honor `prefers-reduced-motion`; provide a **text alternative** panel.
3. **Controlled catalog only:** add allowlisted `matrix_transform` (not arbitrary animation generator; not OpenMAIC free HTML/JS).
4. **Fallback:** if catalog rejects or component unavailable → **static table + 文字** from the **same** params (retain parameters; do not drop the block into bare `unknown_component` without a static path when params are valid).
5. **Domain alignment:** `packages/domain/.../teaching-math-model.ts` shared with Data — Plan must name Experience vs Data ownership (contracts, allowlist, UI).
6. **Only suitable content:** use the interactive form when params validate; otherwise static / skip honesty — do not force every block into animation.
7. **No Implement this turn** → Integrator Plan Accept next; no product code / no DDL invented.

## Why this exists (gap after V2-10 catalog / renderer)

| Layer | Landed (tip `267f9d2`) | Missing / wrong for V2-15 |
|---|---|---|
| Catalog allowlist | V2-10 `CATALOG_IDS` = `text` / `math` / `step` / `example` / `question` / `draft` / `evidence` in `component-catalog.ts` | **No** `matrix_transform` id; unknown blockType → `unknown_component` |
| Domain plan allowlist | V2-08 `ALLOWED_TEACHING_BLOCK_TYPES` = `text` / `formula` / `prompt` / `example` / `steps` / `answer_key` / `meta` in `teaching-plan.ts` | **No** `matrix_transform`; fixture `matrix-viz` / `matrix_viz` / `matrixviz` **collapse to `text`** via `BLOCK_TYPE_ALIASES` |
| Block renderer | `block-renderer.tsx` switches on CatalogId; Tailwind-only bodies; `BLOCK_RENDERER_FORBIDS_RAW_HTML` | No matrix UI; no pause/step/keyboard; no reduced-motion / text-alt |
| Teaching workspace | `teaching-workspace.tsx` mounts `BlockRenderer` + commands + resume card | No interactive viz mount point beyond catalog switch |
| Math model domain | — | `packages/domain/src/opening/teaching-math-model.ts` **ABSENT** (**NEW**) |
| Blocks directory | — | `apps/web/src/features/opening/teaching/blocks/` **ABSENT** (**NEW**); proposed `matrix-transform.tsx` **ABSENT** |
| Checkpoint interaction bag | V2-14 `interactionParams: Record<blockId, Record<string, unknown>>` on resume + checkpoint save (contracts + domain + content repo) | Bag exists; **no** matrix step/pause state schema or consumer |
| clientInit redaction | `redactBlocksForClientInit` / `sanitizeCheckpointForRestore` — answer_key → `content: null` + hidden reveal | Non-answer matrix params may pass as block `content`; must still avoid HTML/script keys (catalog `extractPlainParams` already strips `html`/`script`) |
| Design check foreshadow | `validate_design.py` `test_16` allowlist includes design-level `matrix_transform`; `test_18` same-semantics matrix kernel toy | Design intent only — **not** product wiring |
| Arbitrary animator | Explicitly forbidden by plan.md / PM | Must stay OOS |

## PM locks map (must encode in Plan)

| # | PM lock | Inventory anchor | Plan must |
|---|---|---|---|
| 1 | Same param model drives **input matrix, output matrix, 文字** | No MathModel file yet; catalog params are opaque `Record` | Define single `MatrixTransformParams` / MathModel; UI + prose read **one** object; reject dual LLM prose-vs-viz params |
| 2 | Pause / reset / step / keyboard / low-motion / text alternative | No controls in `block-renderer` today | Experience component owns controls + `prefers-reduced-motion` + text-alt panel |
| 3 | No reliable component → **static table/文字** fallback; **retain params** | Unknown → `unknown_component` skip card today | Prefer static render from same params when catalog/component unavailable; do not invent a second param bag |
| 4 | **Not** arbitrary animation generator | plan.md acceptance; E03/E04 whitelist spirit | Reject free-form CSS/JS animator / OpenMAIC HTML |
| 5 | domain `teaching-math-model` **align with Data** | Proposed path in plan.md / tasks.json | Ownership table: Data = contracts + domain pure math + allowlist/normalize if generation emits `blockType`; Experience = `matrix-transform.tsx` + catalog wiring + a11y + fallback UI |
| 6 | Prefer **no DDL** | Migrations tip ends **0057**; checkpoint jsonb already holds `interactionParams` | Nest step/pause UI state in checkpoint `interactionParams[blockId]` if persisted; Integrator assigns migration only if demanded |
| 7 | Only Understand+Plan this turn | gates | Docs only; Integrator Plan Accept; no Implement / no self-ACCEPT / no `tasks.json` verified |

## Inventory (paths cited)

### 1. Authority / task

- `docs/superpowers/plans/ai-led-learning-v2/plan.md` §V2-15 (~L625–643): M1; owner 前端/数学校核; depends V2-02 / V2-09 / V2-10; goals G1/G5/G6; scope = controlled `matrix_transform`; same param model; pause/reset/step/keyboard/low-motion/text-alt; no separate model invent for figure vs formula; static fallback; proposed paths `matrix-transform.tsx` + `teaching-math-model.ts`; verify zero / identity / rank-1 / negatives·decimals / dim mismatch / param caps; expression↔numeric consistency; browser/visual = user accept; accept: first-unit on-demand interactive teaching without requiring arbitrary animator; rollback: static table/文字 from same data, keep params; sources R06, E03, E04.
- `tasks.json` V2-15 — status `proposed`; evidence_status `engineering/real_model=not_run`, `user_browser=pending_user`, `learning_effect=unknown`; relative_size M.
- Charter: **G1** AI 主讲; **G5** 合适表达（同语义驱动文字/公式/图示/交互；反例：整页任意代码；图文参数不一致）; **G6** 证据诚实.
- Sources: **R06** Mayer & Fiorella essential processing / learner control & segmentation (limits: more animation ≠ better); **E03** A2UI declarative controlled catalog; **E04** json-render whitelist components/actions + schema separation.
- Gates: Implementer ≠ Accepter; no self-verified; no push/hermes by default; plan-stage tests remain `not_run`.

### 2. Catalog ids (V2-10 Experience) — current

Path: `apps/web/src/features/opening/teaching/component-catalog.ts`

| Catalog id | Present? |
|---|---|
| `text` | yes |
| `math` | yes |
| `step` | yes |
| `example` | yes |
| `question` | yes |
| `draft` | yes |
| `evidence` | yes |
| **`matrix_transform`** | **NO** |

- `normalizeToCatalogId` / `BLOCK_TYPE_ALIASES`: maps formula→math, steps→step, prompt→question, cite→evidence, meta→text; **no** matrix_* alias.
- `decideBlockRender`: unknown → `{ ok:false, reason:"unknown_component" }`; strips `html`/`script`/`dangerouslySetInnerHTML` and illegal links/actions.
- Fail-soft label: 「未知组件类型，已跳过该块」— today **drops** the block; V2-15 needs a path that still shows static table/文字 when params parse.

### 3. Domain blockType allowlist (V2-08) — current

Path: `packages/domain/src/opening/teaching-plan.ts`

- `ALLOWED_TEACHING_BLOCK_TYPES`: `text`, `formula`, `prompt`, `example`, `steps`, `answer_key`, `meta`.
- Aliases: `"matrix-viz"` / `matrix_viz` / `matrixviz` → **`text`** (tests assert allowlist does **not** contain `matrix-viz`).
- `normalizeBlockTypes` drops unknown; empty → `["text"]`.
- **Implication for V2-15:** generation that emits `matrix_transform` (or legacy matrix-viz) will **not** survive outline normalize until Data adds allowlist entry + alias remap; Experience catalog alone is insufficient.

### 4. clientInit redaction + interactionParams (V2-05 / V2-14 checkpoint)

| Surface | Path | V2-15 note |
|---|---|---|
| Redact | `packages/database/src/repositories/opening-teaching-content.ts` `redactBlocksForClientInit` | answer_key → null content; other block `content` (incl. future matrix params) passes through as JSON object |
| Sanitize checkpoint | same file `sanitizeCheckpointForRestore` | strips answerKeys/solutions/unrevealedAnswers; **keeps** other checkpoint keys (incl. `interactionParams`) |
| Resume DTO | `packages/contracts/src/opening/teaching-resume.ts` | `interactionParams: Record<uuid, Record<string, unknown>>` default `{}` |
| Resume domain | `packages/domain/src/opening/teaching-resume.ts` | `TEACHING_RESUME_CHECKPOINT_KEYS` includes `interactionParams`; merge/read helpers |
| Checkpoint save | content repo + resume service | CAS merge can patch `interactionParams` without clobbering prefs/command keys |
| clientInit blocks | `packages/contracts/src/opening/teaching-content.ts` | `blockType: string` (max 120) — schema does **not** enum-restrict; product allowlists do |

**Plan default:** authoritative MathModel lives in **block content** (compiled teaching body). Optional UI runtime (paused / stepIndex) may nest under `interactionParams[blockId]` for cross-device resume — **must not** fork a second semantic matrix.

### 5. Renderer / workspace mount

- `apps/web/src/features/opening/teaching/block-renderer.tsx` — `CatalogBody` switch; no `blocks/` import; default returns `null` for unknown CatalogId (unreachable if decideBlockRender gates first).
- `apps/web/src/features/opening/teaching/teaching-workspace.tsx` — renders ordered blocks via `BlockRenderer`; feature flag / generateStatus ready gate unchanged.
- Proposed **NEW:** `apps/web/src/features/opening/teaching/blocks/` directory + `matrix-transform.tsx`.
- Proposed **NEW:** `packages/domain/src/opening/teaching-math-model.ts` (+ tests); export via `packages/domain/src/index.ts` (pattern like `teaching-plan` / `teaching-resume`).

### 6. Related slices (boundaries)

| Slice | Relation |
|---|---|
| V2-02 / V2-09 | Depends_on (tasks); validation honesty — do not invent “math proven correct” from pretty viz (G6) |
| V2-10 | Catalog/renderer/workspace — **extend** allowlist + switch case; do not replace workspace |
| V2-12 | Commands stay orthogonal; matrix controls are **in-block** interaction, not `why`/`rephrase` |
| V2-14 | `interactionParams` bag reserved — V2-15 fills matrix runtime semantics |
| V2-16 | Full AI-led loop — **OOS**; this slice is the widget + model only |
| Design `validate_design.py` | Foreshadows allowlist + same-semantics toy — Implement may align unit fixtures, not treat Python as runtime |

## Out of scope (OOS) for V2-15 Understand+Plan

- **No product Implement** of `matrix-transform.tsx` / `teaching-math-model.ts` / catalog edits / allowlist edits.
- **No** arbitrary animation generator / free-form CSS keyframe factory / model-authored HTML/JS / OpenMAIC classroom widgets.
- **No** V2-16 loop integration / browser E2E as product delivery this turn.
- **No** inventing mastery / “learner understood matrix” from interaction events (G6 honesty; facts ledger unchanged).
- **No** DDL / inventing migration numbers (prefer nest checkpoint; tip ends **0057**).
- **No** commit / push / hermes / stash / reset / self-ACCEPT / flipping `tasks.json` → verified / in_progress.
- **No** requiring every teaching block to become interactive — only suitable matrix_transform content.

## Open decisions for PM / Paula (propose Plan defaults)

1. **Canonical blockType string:** Plan default = library/catalog id **`matrix_transform`** (underscore, matches plan.md / validate_design). Legacy `matrix-viz` aliases → map **to** `matrix_transform` (Data allowlist) rather than collapsing to `text` once V2-15 lands.
2. **Ownership of `teaching-math-model.ts`:** Plan default = **Data owns** domain pure functions + zod/contracts sketches; **Experience owns** React UI consuming those functions. Cross-role: Integrator confirms if a single Implement PR or sequenced Data-then-Experience.
3. **Persist step/pause state?** Plan default = optional `interactionParams[blockId] = { paused, stepIndex, reducedMotionOverride? }` via existing checkpoint POST; semantic matrices stay in block content.
4. **Static fallback trigger:** Plan default = (a) catalog id known but React component feature-flagged off / load fail → static; (b) params fail MathModel parse → fail-soft honesty + raw numeric table if partial rows exist; (c) unknown without parseable params → keep today’s `unknown_component`.
5. **Animation:** Plan default = **discrete step** of vector/matrix application (or highlight cells) — **not** continuous free animator; reduced-motion → jump to step result / show text-alt only.
6. **Param caps:** Plan default = max dimension **4×4** (M1), numeric abs ≤ 1e6, decimal places display ≤ 6; reject larger with static error + keep params visible.
7. **Contracts file:** Plan default = schemas live beside domain in `packages/contracts/src/opening/teaching-math-model.ts` (**NEW**) **or** additive export from `teaching-content.ts` — prefer **new file** for clarity (Integrator may fold).

Escalate only if a Plan default is rejected.

## Stronger-review notes (no invented goals)

- Restatement matches plan.md §V2-15 + PM brief + tasks.json scope. Goals cited are **only** G1/G5/G6 (not G2/G7/G8 from V2-14; not full G1–G8 from V2-16).
- Risk if Implement adds a pretty CSS animator with **separate** LLM prose: fails G5 same-semantics lock and PM lock 1.
- Risk if Experience ships UI without Data allowlist update: generation still normalizes matrix-viz→text / drops `matrix_transform` — widget never receives blocks.
- Risk if unknown path stays “skip card only” with no static table: violates plan.md rollback / PM lock 3.
- Risk if interaction events write graded attempts/mastery: invents learning claims (G6) — forbidden.
- Risk if OpenMAIC / `dangerouslySetInnerHTML` sneaks in via “rich viz”: violates V2-10 catalog boundary and E03/E04 spirit.
