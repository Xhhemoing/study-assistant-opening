# V2-15 Matrix transform — Experience UI Implement ACCEPT

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Reviewer:** AIstudy Integrator (executor / Grok Bot) — **≠** implementer (AIstudy Experience)  
**Stage:** Independent Implement ACCEPT (Experience UI half only)  
**Branch:** `feat/opening-release`  
**Tip HEAD (baseline; Data half committed):** `95b4bdf3df71cb6f4ac30aba42eadd9bc39f17b4` (`95b4bdf`) — `feat(opening): V2-15 matrix_transform math model (Data half)`  
**Tree:** **dirty Experience UI** (uncommitted; excluded from any clean-tip push)  
**Verdict:** **ACCEPT**

## Authority / inputs

| Doc | Role |
|---|---|
| `docs/superpowers/plans/ai-led-learning-v2/v2-15-matrix-transform-plan.md` | Plan（§2 Experience · §3 controls · §4 fallback · §7.2 Implement ACCEPT · §8 PM locks） |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-15-matrix-transform-plan-accept.md` | Plan ACCEPT |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-15-matrix-transform-data-accept.md` | Data Implement ACCEPT |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-15-matrix-transform-experience-implement.md` | Experience Implement claim |
| `docs/superpowers/plans/opening-release/review-test-gates.md` | Gates |
| Style: `v2-14-learning-resume-experience-accept.md` / `v2-12-teaching-commands-experience-accept.md` / `v2-11-intervention-prefs-experience-accept.md` | Accept sample + browser soft-defer pattern |
| PM UI locks (room) | blocks/matrix-transform + catalog/renderer; pause/reset/step/keyboard; reduced-motion forces autoplay off; autoplay default off; text alternative; static fallback; reuse Data pure functions (teaching-math-model); same-semantics; no arbitrary animation generator |

## Tip / dirty tree (read-only; no stash / reset / push)

```text
$ git rev-parse HEAD
95b4bdf3df71cb6f4ac30aba42eadd9bc39f17b4

$ git log -1 --oneline
95b4bdf feat(opening): V2-15 matrix_transform math model (Data half)

$ git branch --show-current
feat/opening-release

$ git status --short  (product Experience only)
 M apps/web/src/features/opening/teaching/block-renderer.test.ts
 M apps/web/src/features/opening/teaching/block-renderer.tsx
 M apps/web/src/features/opening/teaching/component-catalog.test.ts
 M apps/web/src/features/opening/teaching/component-catalog.ts
?? apps/web/src/features/opening/teaching/blocks/
#   matrix-transform.tsx
#   matrix-transform.test.ts
# (+ claim implement.md + this accept; unrelated untracked docs left alone)

$ git diff --name-only HEAD -- packages/database packages/domain packages/contracts
# (empty — Data half untouched this slice)

$ ls packages/database/src/migrations/0058* 2>/dev/null || echo 'no 0058'
no 0058

$ date '+%Y-%m-%d %H:%M %Z'
2026-10-11 13:54 CST
```

**Also dirty (outside Experience product):** untracked `docs/superpowers/evidence/2026-10-09-opening-release/rp5-gha-91b1c73-typecheck-fail.md`、`docs/superpowers/evidence/2026-10-11-opening-release/p0-assistant-list-preview-failsoft-implement.md` — unrelated; not part of this ACCEPT.

**Confirmed:** tip remains `95b4bdf`. Dirty product tree is Experience UI only (`blocks/matrix-transform*` + catalog + block-renderer + tests). **No stash, reset, checkout, commit, push, or hermes** performed this Accept. `tasks.json` left alone.

## Stronger review

### 1. Diff scope — Experience only

| Path | Role | OK? |
|---|---|---|
| `blocks/matrix-transform.tsx` (+test) | MatrixTransformBlock + View + StaticView; pause/reset/step/keyboard state machine; `resolveEffectiveAutoplay`; text-alt; interactive flag; honesty copy | YES |
| `component-catalog.ts` (+test) | `CATALOG_IDS` += `matrix_transform`; aliases `matrix_transform` / `matrix-viz` / `matrix_viz` / `matrixviz` | YES |
| `block-renderer.tsx` (+test) | `case "matrix_transform"` → mount `MatrixTransformBlock`; chrome keys stripped; interactive via env flag | YES |
| Data contracts / domain / teaching-plan | **Untouched** in dirty tree (`git diff` empty) | YES |
| Migration `0058` | **Absent** | YES |

### 2. PM locks vs UI behavior

| Lock | Finding |
|---|---|
| Catalog id `matrix_transform` + matrix-viz* aliases | `CATALOG_IDS` includes it; aliases remap to `matrix_transform` (not text/unknown); T12 tests | **Hold** |
| pause / reset / step / keyboard | Toolbar: 暂停/继续、重置、上一步/下一步、文字替代；`handleMatrixTransformKey` Space/Home/←→/`[` `]`; `aria-keyshortcuts` documented | **Hold** |
| autoplay default off; `prefers-reduced-motion` **forces** off | `resolveEffectiveAutoplay(content, reduced)` returns false when reduced; timer only if `effectiveAutoplay && !paused`; content `autoplay` from domain default false; T15 | **Hold** |
| 文字替代 | Toggle panel uses domain `buildTextAlternative(params)` — same labels/numbers | **Hold** |
| Static fallback when interactive off / unavailable | `interactive={false}` or env `OPENING_MATRIX_TRANSFORM_INTERACTIVE=0|false|no|off` → `MatrixTransformStaticView` via `staticFallbackModel` + text-alt; parse fail → honesty errors + `data-math-params-error` (**no invented numbers**) | **Hold** |
| Reuse Data pure functions (same-semantics; no local MathModel) | Imports from `@aistudy/domain`: `parseMatrixTransformParams`, `parseMatrixTransformInteractionParams`, `stepPlan`, `stepApply`, `staticFallbackModel`, `buildTextAlternative`, `formatVectorCells` — **no** local multiply/dot/applyMap; only UI clamp/`Math.max` for stepIndex bounds | **Hold** |
| No arbitrary animation generator | Discrete stepper only (`stepPlan` / `stepApply`); highlight cells by step; interval autoplay gated off by reduced-motion / default-off — **not** CSS/JS animation DSL | **Hold** |
| G6 honesty | `MATRIX_TRANSFORM_HONESTY_COPY`「漂亮不等于已核验正确」in interactive + static + parse-fail | **Hold** |
| Soft interactionParams | `onInteractionChange` + `toInteractionParams` / `parseMatrixTransformInteractionParams`; empty default OK; workspace POST not wired this slice (soft gap) | **Hold** (soft) |

### 3. Tests not loosened

- matrix-transform.test: T14 state/keyboard; T15 reduced-motion/autoplay + flag; T16 static SSR; interactive chrome SSR (7).
- component-catalog.test: T12 alias + decideBlockRender ok; T13 illegal html/script fail-soft (among 14 total).
- block-renderer.test: T17 interactive + matrix-viz alias + unknown fail-soft; T17b env off → static (among 6 total).
- No `it.skip` / `.only` in claimed files.
- Suite strength matches claim (pure state machine + SSR markup; full DOM keydown/click honestly soft / not_run).

## Independent re-runs (Integrator)

### Vitest

```text
$ PATH="./node_modules/.bin:$PATH" bash scripts/run-heavy.sh vitest run \
    apps/web/src/features/opening/teaching/blocks/matrix-transform.test.ts \
    apps/web/src/features/opening/teaching/component-catalog.test.ts \
    apps/web/src/features/opening/teaching/block-renderer.test.ts

 Test Files  3 passed (3)
      Tests  27 passed (27)
   Duration  ~3.09s
exit 0
```

（matrix-transform.test 7 + component-catalog.test 14 + block-renderer.test 6 = 27）

### Typecheck

```text
$ cd apps/web && npx tsc -p tsconfig.json --noEmit
exit 0
```

### Browser

```text
not_run / pending_user — no interactive browser pass this Accept (honest).
```

Plan §5 T20 / §7.2 name user_browser as **pending_user** (pretty ≠ correct); Plan does **not** hard-require browser E2E as a blocking criterion for this Experience UI half. Gates: browser required-by-plan normally blocks ACCEPT. Prior V2-11/12/14 Experience UI halves soft-deferred browser as `not_run` with ACCEPT when unit/tsc green. This slice follows that pattern; **do not invent browser pass**. Soft gap recorded below — does not overturn ACCEPT for this UI half.

## Soft gaps (honest; non-blocking)

1. **Browser E2E** — `not_run` / pending_user（soft gap；prior V2-11/12/14 Experience UI pattern；Plan T20 pending_user）.  
2. **Checkpoint soft-write** — `onInteractionChange` ready; TeachingWorkspace **未**接线 POST `interactionParams[blockId]`；空默认 OK（PM lock 4 / Plan soft）.  
3. **jsdom 用户事件** — vitest env `node`；键盘/按钮以纯函数状态机 + SSR markup 覆盖；完整 DOM keydown/click `not_run`.  
4. **Autoplay timer** — reduced-motion / default-off 已测；真实 interval 推进浏览器目视 `not_run`.  
5. **Compiler emit** 首单元真实 matrix 内容 — Data lock 7 follow-up；不阻塞 Experience.  
6. Data soft gaps（optional Y vs A·x cross-check 等）— Experience 不宣称.  
7. Unrelated untracked docs（`rp5-gha-…`、`p0-assistant-list-…`）— outside this slice.

## Forbidden actions (this Accept)

- **No** stash / reset / checkout / clean of dirty Experience UI  
- **No** commit / push / hermes  
- **No** Data contract/domain/teaching-plan rewrite  
- **No** new migration / DDL  
- **No** product fix (would REJECT instead)  
- **No** self-mark `tasks.json` verified（left alone）

## Verdict

**ACCEPT** Experience UI Implement of V2-15 Matrix transform at dirty tip `95b4bdf`.

- Diff scope Experience-only；Data half reused via `@aistudy/domain` teaching-math-model；no `0058`.  
- Catalog `matrix_transform` + matrix-viz* aliases；pause/reset/step/keyboard；reduced-motion forces autoplay off；文字替代 + static fallback；same-semantics domain math；no arbitrary animator；honesty copy.  
- Re-runs: vitest **3 files / 27 tests** exit 0；`apps/web` tsc **exit 0**.  
- Browser **`not_run`**（honest soft gap；prior V2-11/12/14 Experience pattern；plan did not mandate browser E2E for this half）.  
- Soft gaps recorded. **Confirmed: no stash / reset / push / hermes / tasks.json touch.**

## One-line

ACCEPT — tip `95b4bdf` dirty Experience UI；vitest 27 + web tsc green；matrix_transform catalog+UI；domain math reuse；pause/reset/step/keyboard；reduced-motion forces autoplay off；static+文字 fallback；browser `not_run`；no push/hermes/commit.
