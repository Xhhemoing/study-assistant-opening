# V2-15 Matrix transform — Plan ACCEPT

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Reviewer:** AIstudy Integrator (executor / Grok Bot) — **≠** plan author (AIstudy Experience)  
**Stage:** Plan ACCEPT only — **no product Implement · no ALTER · no migration SQL create · no commit / push / hermes / stash / reset**  
**Branch:** `feat/opening-release`  
**Tip HEAD at Accept:** `267f9d2e983524e3f2487bb0d9237dc827e7e43a` (`267f9d2`)  
**Plan tip claim:** `267f9d2` — **exact match** (no tip drift)  
**Verdict:** **ACCEPT**  
**Gates:** `docs/superpowers/plans/opening-release/review-test-gates.md` + delivery-loop stronger Plan review  
**PM frozen locks (room + Data/AI AGREES) encoded:** (1) canonical `matrix_transform` + matrix-viz* remap to it not text; (2) M1 reals ≤4×4, complex/symbolic OOS; (3) autoplay default off + reduced-motion forces off; (4) stepIndex/paused soft-write `interactionParams[blockId]`, empty default OK; (5) contracts **new file only** `teaching-math-model.ts`; (6) Data-first then Experience UI; exclusive trees; (7) domain unit fixtures required this slice; compiler first-unit emit is follow-up, not blocking Accept. **DDL: NO**

## Authority / inputs read (full)

| Doc | Role |
|---|---|
| `docs/superpowers/plans/ai-led-learning-v2/v2-15-matrix-transform-plan.md` | Plan under review (**re-read after Experience PM-lock sync**) |
| `docs/superpowers/plans/ai-led-learning-v2/v2-15-matrix-transform-understand.md` | Understand |
| `docs/superpowers/plans/ai-led-learning-v2/plan.md` §V2-15 (L625–643) | Authority |
| `docs/superpowers/plans/opening-release/review-test-gates.md` | Gates |
| Style: `v2-14-learning-resume-plan-accept.md` | Accept sample |
| PM room locks 1–7 + Data/AI co-review AGREES | Frozen gate |

No prior `v2-15*` evidence under `docs/superpowers/evidence/2026-10-11-opening-release/` at Accept start (this file is first).

## Tip / tree verification

```text
$ git rev-parse HEAD
267f9d2e983524e3f2487bb0d9237dc827e7e43a

$ git rev-parse --short HEAD
267f9d2

$ git branch --show-current
feat/opening-release

$ git log -1 --oneline
267f9d2 feat(opening): V2-14 learning resume UI (Experience half)

$ ls packages/database/src/migrations/*.sql | sort | tail -3
0055_opening_compile_teaching_unit_job.sql
0056_opening_intervention_settings.sql
0057_opening_help_exposure_kind.sql

$ ls packages/database/src/migrations/0058* 2>/dev/null || echo 'no 0058 migr'
no 0058 migr

$ test ! -f packages/domain/src/opening/teaching-math-model.ts && echo MATH_MODEL_ABSENT
MATH_MODEL_ABSENT

$ test ! -f packages/contracts/src/opening/teaching-math-model.ts && echo CONTRACT_ABSENT
CONTRACT_ABSENT

$ test ! -d apps/web/src/features/opening/teaching/blocks && echo BLOCKS_DIR_ABSENT
BLOCKS_DIR_ABSENT

$ date '+%Y-%m-%d %H:%M %Z'
2026-10-11 13:44 CST
```

### Untracked V2-15 docs (expected; no invent commits)

```text
?? docs/superpowers/plans/ai-led-learning-v2/v2-15-matrix-transform-understand.md
?? docs/superpowers/plans/ai-led-learning-v2/v2-15-matrix-transform-plan.md
(+ this accept file after write)
```

Other untracked evidence (`rp5-gha-…`, `p0-assistant-list-…`) **not** part of V2-15; left untouched.

**Result:** Accept tip `267f9d2` equals Plan baseline. No V2-15 product code / no DDL file / Experience did **not** self-ACCEPT Implement. Migrations tip ends **0057**; **no** `0058` on disk.

## DDL decision

| Item | Value |
|---|---|
| DDL needed? | **NO** |
| Why | Authoritative MathModel lives in block `content` (compiled JSON); optional UI runtime (`paused` / `stepIndex`) nests in existing V2-14 `checkpoint_json.interactionParams[blockId]` — no new table/column |
| Rejected | New matrix-steps table; invent migr `0058` |
| Placeholder if later | `00xx_…` only if Integrator later demands — **not** assigned this Accept |
| Latest numbered migr on tip | `0057_opening_help_exposure_kind.sql` |
| This Accept | Does **not** create SQL; does **not** assign a migration number |

## PM frozen locks checklist (gate — REJECT if contradicted)

| # | Frozen lock | Plan location (post-sync) | Match? |
|---|---|---|---|
| 1 | Canonical id `matrix_transform`; remap `matrix-viz`/`matrix_viz`/`matrixviz` → it (**not** text) | §1.2; §2 allowlist; §8 lock 1; T11 | **YES** |
| 2 | M1 reals only, ≤4×4; complex/symbolic OOS | §1.4 `MAX_DIM=4` + `number[][]`; §8 lock 2 | **YES** |
| 3 | autoplay default **off**; `prefers-reduced-motion` forces off | §1.4 `autoplay.default(false)`; §3; §8 lock 3; T15 | **YES** |
| 4 | stepIndex/paused may soft-write `interactionParams[blockId]`; empty default OK | §1.1; §1.3 r8; runtime sketch; §2; §8 lock 4; T18 | **YES** |
| 5 | Contracts **new file only** `teaching-math-model.ts` (not fold into teaching-content) | §1.4 comment updated; §2; §6 NEW; §8 lock 5 | **YES** (prior “or fold” wording removed) |
| 6 | Data-first (contracts/domain/allowlist) then Experience UI; exclusive trees | §2 sequencing; §8 lock 6; §9 | **YES** |
| 7 | Domain unit fixtures required this slice; compiler first-unit emit follow-up, not blocking Accept | §5 T1–T9; §8 lock 7; generation emit noted as Data later / OOS for block ACCEPT | **YES** |

Data: AGREES. AI: AGREES. Plan text after Experience sync encodes all seven — **no contradiction → no REJECT**.

## Stronger review — claim-by-claim vs tip code

### 1. Inventory gaps accurately marked NEW

| Claim | Tip check |
|---|---|
| `CATALOG_IDS` = text/math/step/example/question/draft/evidence | **EXISTS** — `component-catalog.ts` L8–16; **no** `matrix_transform` |
| Catalog `BLOCK_TYPE_ALIASES` | **EXISTS** — formula→math, steps→step, etc.; **no** matrix_* alias |
| Domain `ALLOWED_TEACHING_BLOCK_TYPES` | **EXISTS** — text/formula/prompt/example/steps/answer_key/meta; **no** `matrix_transform` |
| Domain aliases matrix-viz* → **`text`** | **EXISTS** — `teaching-plan.ts` L23–27 — Plan correctly proposes **breaking remap** → `matrix_transform` |
| `block-renderer.tsx` CatalogBody switch | **EXISTS** — cases text/math/step/example/question/draft/evidence only; **no** matrix case |
| `BLOCK_RENDERER_FORBIDS_RAW_HTML` | **EXISTS** — true |
| `packages/domain/.../teaching-math-model.ts` | **ABSENT** — correctly NEW (Data) |
| `packages/contracts/.../teaching-math-model.ts` | **ABSENT** — correctly NEW (Data; new file only) |
| `apps/web/.../teaching/blocks/` + `matrix-transform.tsx` | **ABSENT** — correctly NEW (Experience) |
| V2-14 `interactionParams` bag | **EXISTS** — contracts + domain teaching-resume; Plan reuses nest, does not invent second semantic matrix |
| OpenMAIC / free HTML animator | Correctly **OOS** / rejected |

**No invented “already exists” APIs.** Gaps for math model, contracts file, blocks dir, catalog id, allowlist entry accurately marked NEW.

### 2. Same-semantics / no arbitrary animator / fallback

- One `MatrixTransformParams` drives A, x, y, labels, prose, expression — matches plan.md §V2-15 + G5 + PM lock (same param model).
- Interaction = discrete `stepPlan` stepper + pause/reset/keyboard — **not** generative CSS/JS DSL (PM lock 4; rejected alts).
- Fallback: interactive off / error → static table + 文字 from same params; retain params — matches plan.md rollback + PM lock 3.
- Unknown + unparseable still uses today’s `unknown_component` — correct boundary.
- G6 honesty: pretty ≠ correct; no mastery from step events — matches authority verify note.

### 3. Ownership / sequencing / acyclic deps

| Surface | Plan | Tip check |
|---|---|---|
| Data: contracts + domain teaching-math-model + teaching-plan allowlist/alias | Owner Data-first | Paths NEW or extend Data trees |
| Experience: catalog + block-renderer + blocks/matrix-transform.tsx | Owner after Data | Exclusive UI trees |
| Checkpoint interactionParams | Reuse V2-14 | Bag exists |
| V2-16 e2e / OpenMAIC / mastery / tasks.json verified | OOS | Clear |
| Migration | None | DDL NO |

Dependencies acyclic (contracts → domain → Experience catalog/UI). Data-first sequencing matches frozen lock 6.

### 4. Tests cannot pass without required behavior

| Requirement | Tests that force it |
|---|---|
| Parse / non-rectangular reject | T1 |
| Zero / identity / rank-1 | T2 / T3 / T4 |
| Negatives/decimals + caps | T5 / T7 |
| Dim mismatch | T6 |
| Expression↔numeric consistency | T8 |
| stepPlan + reset | T9 |
| Zod strict round-trip | T10 |
| Allowlist + matrix-viz → matrix_transform | T11 |
| Catalog id + illegal html/script fail-soft | T12 / T13 |
| Pause/reset/step/keyboard | T14 |
| Reduced-motion / no autoplay | T15 |
| Static fallback | T16 |
| Renderer mount + unknown fail-soft | T17 |
| interactionParams preserves prefs + commandLog | T18 |
| Typecheck | T19 |
| Browser visual | T20 `pending_user` |

Plan-stage: **T1–T20 all `not_run`** (honest). Domain fixtures T1–T9 required for Data Implement (lock 7); browser remains pending_user.

### 5. Rejected alternatives

Plan rejects dual LLM prose-vs-viz params, free-form animator/HTML, forever matrix-viz→text, skip-only unknown with no static table when params valid, new DB table, mastery from steps, OpenMAIC host, Experience-local MathModel duplicate, requiring arbitrary animator — **all match plan.md §V2-15 / PM locks**.

### 6. History note sound

§1.3 r11: old activities with matrix-viz collapsed to text stay text until recompiled; no invented MathModel backfill — correct for breaking alias remap.

## Soft gaps (non-blocking)

1. **Exact keyboard map** — Plan sketches Space/Home/Arrows/Brackets; Implement must document final `aria-keyshortcuts` (Plan already defers).
2. **Feature-flag surface** — optional workspace/catalog interactive flag named but path left soft; Experience Implement chooses without inventing DDL.
3. **Compiler/generator emit of first-unit matrix content** — frozen as **follow-up**; must not block Data or Experience slice Accept (lock 7). Domain fixtures still required in Data Implement.
4. **Browser/device visual** — T20 remains `pending_user`; pretty ≠ correct (G6).
5. **History recompile** — remapped alias only affects new normalize; old stored outline blockTypes already collapsed to text stay until recompile — document in Implement evidence.

None contradict PM frozen locks or force inventing APIs / DDL. Prior soft gap on contracts “or fold” **closed** by Plan §1.4 / §8 lock 5 sync.

## Gate compliance

| Gate | This Accept |
|---|---|
| Stronger review vs plan/understand/PM/code | Done (Plan re-read after Experience PM-lock sync) |
| Tip / SHA named | `267f9d2` (exact Plan baseline) |
| Product Implement / ALTER / SQL create | **None** |
| Migr number assign | **None** (DDL NO) |
| Re-run Implement tests | **N/A** — Plan stage; T1–T20 remain `not_run` |
| Self-ACCEPT of Implement | N/A (Plan ACCEPT only); Experience did not self-ACCEPT Implement |
| tasks.json verified flip | **Not done** |
| Push / hermes / commit | **Not done** |

## Verdict

**ACCEPT** Plan `v2-15-matrix-transform-plan.md` (+ Understand).

- **DDL:** **NO** — nest optional UI state in existing `checkpoint_json.interactionParams`; MathModel in block content; tip remains **0057**.
- **recommended_migr:** **none** (do not invent `0058`).
- Ready for sequenced Implement after this Accept + PM authorization:
  1. **Data-first:** contracts `teaching-math-model.ts` (new file) → domain pure API + fixtures T1–T9 → allowlist + alias remap T10–T11 → Data Implement evidence.
  2. **Experience half:** catalog id + aliases → `blocks/matrix-transform.tsx` + renderer + a11y/fallback T12–T18 → typecheck T19; browser T20 pending_user.
- This Accept does **not** authorize ALTER, product code, migration create, commit, push, or hermes.

## Blockers / open decisions for PM

**None blocking ACCEPT.** All seven PM frozen locks are encoded in Plan §8 and body; Data/AI AGREES. Escalate only if Paula rejects a lock (not expected).

## not_run (honest)

All Plan Implement tests **T1–T20**: `not_run` (Plan stage — correct). No unit/typecheck/integration re-run applicable until Implement.
