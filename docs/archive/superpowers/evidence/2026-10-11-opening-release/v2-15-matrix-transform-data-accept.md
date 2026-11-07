# V2-15 Matrix transform — Implement ACCEPT (Data half)

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Reviewer:** AIstudy Integrator (executor / Grok Bot) — **≠** implementer (AIstudy Data)  
**Stage:** Independent Implement ACCEPT (Data half; no Experience UI)  
**Branch:** `feat/opening-release`  
**Baseline tip claimed (Plan ACCEPT / Implement):** `267f9d2e983524e3f2487bb0d9237dc827e7e43a` (`267f9d2`)  
**Tip HEAD at Accept (dirty; no commit):** `267f9d2e983524e3f2487bb0d9237dc827e7e43a` (`267f9d2`) — **exact match**  
**Verdict:** **ACCEPT**

## Authority / inputs

| Doc | Role |
|---|---|
| `docs/superpowers/plans/opening-release/review-test-gates.md` | Gates |
| `docs/superpowers/plans/ai-led-learning-v2/v2-15-matrix-transform-plan.md` | Plan |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-15-matrix-transform-plan-accept.md` | Plan ACCEPT |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-15-matrix-transform-data-implement.md` | Data Implement claim |
| Style: `v2-14-learning-resume-accept.md` / `v2-13-teaching-answer-evidence-accept.md` | Accept samples |

## Tip / dirty tree

```text
$ git rev-parse HEAD
267f9d2e983524e3f2487bb0d9237dc827e7e43a

$ git branch --show-current
feat/opening-release

$ git log -1 --oneline
267f9d2 feat(opening): V2-14 learning resume UI (Experience half)

$ date '+%Y-%m-%d %H:%M %Z'
2026-10-11 13:48 CST
```

### Commits vs uncommitted (V2-15 Data)

| Layer | What | V2-15 Data? |
|---|---|---|
| Tip commit `267f9d2` | V2-14 learning resume UI (Experience half) — baseline | Baseline only |
| Uncommitted dirty product (M + ??) | contracts/domain `teaching-math-model.ts`(+tests); contracts/domain index exports; teaching-plan allowlist + matrix-viz* remap + tests | **Yes** — V2-15 Data Implement |
| Untracked docs/evidence | plan / understand / plan-accept / data-implement / this accept | Docs only |
| Other untracked (`rp5-gha-…`, `p0-assistant-list-…`) | Left untouched | **Not** V2-15 |

**No** stash / reset / commit / push / hermes on this Accept. Worked dirty tree as-is. Product behavior **not** edited.

### Dirty product paths (confirmed)

```text
 M packages/contracts/src/opening/index.ts
 M packages/domain/src/index.ts
 M packages/domain/src/opening/teaching-plan.test.ts
 M packages/domain/src/opening/teaching-plan.ts
?? packages/contracts/src/opening/teaching-math-model.test.ts
?? packages/contracts/src/opening/teaching-math-model.ts
?? packages/domain/src/opening/teaching-math-model.test.ts
?? packages/domain/src/opening/teaching-math-model.ts
```

**No** Experience UI (`matrix-transform.tsx` / `teaching/blocks/` absent). **No** DDL / `0058*`.

## Migration / DDL

| Check | Result |
|---|---|
| New migration `0058*` | **Absent** (`ls …/0058*` → no 0058 migr) |
| Tip migrations end | `0057_opening_help_exposure_kind.sql` |
| New table / column for matrix steps | **None** in diff |
| Nest only | MathModel in block content; soft UI state types for `interactionParams[blockId]` |

**DDL: NO** — holds.

## Stronger review (PM frozen locks / Plan)

| # | Lock | Diff finding |
|---|---|---|
| 1 | Canonical id `matrix_transform`; remap `matrix-viz` / `matrix_viz` / `matrixviz` → it (**not** text) | `ALLOWED_TEACHING_BLOCK_TYPES` includes `matrix_transform`; `BLOCK_TYPE_ALIASES` remaps all three → `matrix_transform` (breaking vs prior →`text`); teaching-plan tests assert remap + allowlist — **aligned** |
| 2 | M1 reals only ≤4×4; complex/symbolic OOS | `matrixSchema` / `finiteRealSchema` (`z.number().finite()` + abs cap); `MAX_DIM=4`; no complex/symbolic types; NaN/Infinity/string rejected in contracts tests — **aligned** |
| 3 | autoplay default **off**; reduced-motion forces off | Schema `autoplay.default(false)`; contracts + domain tests assert default false. **Reduced-motion force-off** is Experience UI (T15) — Data supports content default; motion policy **OOS Data** — **aligned for Data half** |
| 4 | soft `interactionParams[blockId]` (paused/stepIndex); empty OK | `matrixTransformInteractionParamsSchema` + domain `parseMatrixTransformInteractionParams` (empty/partial OK; bad → `{}`); primarily Experience write path — Data exposes types only — **aligned** |
| 5 | Contracts **new file only** `teaching-math-model.ts` (not fold into teaching-content) | New file + `export * from "./teaching-math-model"`; `teaching-content.ts` has **no** MatrixTransform symbols — **aligned** |
| 6 | Data-first scope only this Accept | Dirty = contracts/domain math-model + plan allowlist only; Experience catalog/UI/renderer **absent** — **aligned** |
| 7 | Domain unit fixtures required (zero/identity/rank1/neg·decimal/dim mismatch/caps) | Domain tests T1–T9 cover all; T8 expression↔numeric in text-alt + staticFallback; T10 contracts; T11 allowlist — **aligned** |
| — | History / no invented MathModel backfill | teaching-plan comment: old outlines already collapsed to text stay text until recompile — **aligned** |
| — | Tests not loosened | No `it.skip` / `.only` in claimed 3 test files |
| — | Compiler first-unit emit | **OOS** follow-up (lock 7 / Plan); not blocking |

### Soft gaps (non-blocking)

1. **`prefers-reduced-motion` force-off** — Experience half (T15); Data only guarantees `autoplay` default false in schema/params.
2. **Soft interactionParams persistence / merge with prefs+commandLog** — Experience / resume bag (T18); Data exposes soft schema + parse only.
3. **Optional `vectorY` not cross-checked against computed A·x** — schema checks dim only; `resolveOutputVector` prefers explicit Y. Honesty / compiler follow-up can tighten; fixtures always use computed path or consistent Y — non-blocking.
4. **Compiler / generation emit** of first-unit real `matrix_transform` content — frozen follow-up (lock 7); not this Data Accept.
5. **History recompile** — remapped alias only affects new normalize; stored outlines already collapsed to `text` stay until recompile (documented).

**Blockers:** **None**.

## Independent re-runs (Integrator)

### Vitest (exact Data claim set)

```text
$ PATH="./node_modules/.bin:$PATH" bash scripts/run-heavy.sh vitest run --project unit \
  packages/contracts/src/opening/teaching-math-model.test.ts \
  packages/domain/src/opening/teaching-math-model.test.ts \
  packages/domain/src/opening/teaching-plan.test.ts

 Test Files  3 passed (3)
      Tests  26 passed (26)
   Duration  ~1.93s
exit 0
```

### Typecheck (T19 partial — contracts + domain)

```text
$ PATH="./node_modules/.bin:$PATH" bash scripts/run-heavy.sh tsc -p packages/contracts/tsconfig.json --noEmit
exit 0

$ PATH="./node_modules/.bin:$PATH" bash scripts/run-heavy.sh tsc -p packages/domain/tsconfig.json --noEmit
exit 0
```

## not_run (honest)

| Item | Reason |
|---|---|
| T12–T18 Experience catalog / UI / renderer / interactionParams UI merge | **OOS** Data half (Experience exclusive tree) |
| T19 apps/web typecheck | Experience tree unchanged; Data-only tsc contracts+domain re-run |
| T20 user_browser visual / keyboard | **pending_user** — Experience / Paula |
| Live compiler emit of `matrix_transform` block content | Follow-up OOS (lock 7) |
| Integration / HTTP / DB | N/A — no DDL, no routes this slice |

## Forbidden actions (this Accept)

- **No** push / hermes / commit / stash / reset  
- **No** product behavior edits to force green  
- **No** `tasks.json` → verified (left alone)  
- **No** Experience UI required or added  
- **No** invent migr `0058` / live ALTER

## Verdict

**ACCEPT** Data Implement of V2-15 Matrix transform at dirty tip `267f9d2` (product uncommitted only; HEAD exact match to Plan ACCEPT baseline).

- Required runnable checks re-run green: vitest **3 files / 26 tests** exit 0; tsc contracts + domain exit 0.  
- **No DDL / no 0058**; PM locks 1–7 hold under stronger review for Data half.  
- Soft gaps + Experience T12–T18 / T20 / browser honestly **`not_run`**.  
- Experience half (catalog + `matrix-transform.tsx` + T12–T18 / T20) remains a separate slice after this Accept + PM gate.
