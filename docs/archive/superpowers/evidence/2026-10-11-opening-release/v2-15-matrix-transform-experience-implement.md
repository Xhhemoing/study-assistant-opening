# V2-15 Matrix transform — Experience UI Implement Evidence

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Experience (executor / Grok Bot)  
**Branch:** `feat/opening-release`  
**Tip HEAD (baseline; Data half committed):** `95b4bdf` — `feat(opening): V2-15 matrix_transform math model (Data half)`  
**Status:** **implemented, awaiting Integrator Experience ACCEPT** — do **not** self-ACCEPT; `tasks.json` not marked verified  
**Hard rules held:** No commit / push / hermes / stash / reset · No Data rewrite (contracts/domain/teaching-plan untouched; reuse `@aistudy/domain` teaching-math-model exports) · Exclusive Experience UI/catalog/renderer tree

## Authority followed

- Plan: `docs/superpowers/plans/ai-led-learning-v2/v2-15-matrix-transform-plan.md`（§2 Experience · §3 controls · §4 fallback · §8 PM locks）
- Understand: `docs/superpowers/plans/ai-led-learning-v2/v2-15-matrix-transform-understand.md`
- Data Implement + ACCEPT:
  - `docs/superpowers/evidence/2026-10-11-opening-release/v2-15-matrix-transform-data-implement.md`
  - `docs/superpowers/evidence/2026-10-11-opening-release/v2-15-matrix-transform-data-accept.md`
- Domain API (consume only): `packages/domain/src/opening/teaching-math-model.ts`
- Contracts (consume only): `packages/contracts/src/opening/teaching-math-model.ts`
- Style mirror: `v2-14-learning-resume-experience-implement.md` / `v2-12-teaching-commands-experience-implement.md`
- PM locks: canonical `matrix_transform` + matrix-viz* aliases; pause/reset/step/keyboard; autoplay default off + `prefers-reduced-motion` forces off; text-alt via `buildTextAlternative`; interactive off/parse fail → `staticFallbackModel`; soft `interactionParams` OK empty; pretty ≠ correct; Data-first exclusive trees

## Diff scope (Experience only)

### New

| Path | Role |
|---|---|
| `apps/web/src/features/opening/teaching/blocks/matrix-transform.tsx` | MatrixTransformBlock + View + StaticView; pure state machine (pause/reset/step/keyboard); `resolveEffectiveAutoplay` (reduced-motion forces off); text-alt panel; honesty copy; interactive flag helper |
| `apps/web/src/features/opening/teaching/blocks/matrix-transform.test.ts` | T14 state/keyboard; T15 reduced-motion/autoplay + flag; T16 static fallback SSR; interactive chrome SSR |

### Updated

| Path | Change |
|---|---|
| `apps/web/src/features/opening/teaching/component-catalog.ts` | `CATALOG_IDS` += `matrix_transform`; aliases `matrix_transform` / `matrix-viz` / `matrix_viz` / `matrixviz` |
| `apps/web/src/features/opening/teaching/component-catalog.test.ts` | T12 alias + decideBlockRender ok; T13 illegal html/script still fail-soft |
| `apps/web/src/features/opening/teaching/block-renderer.tsx` | `case "matrix_transform"` → mount `MatrixTransformBlock` (strip chrome keys; interactive via env flag) |
| `apps/web/src/features/opening/teaching/block-renderer.test.ts` | T17 mounts interactive + matrix-viz alias; unknown still fail-soft; T17b env off → static |

### Explicitly not touched

- Data: `packages/contracts|domain` teaching-math-model / teaching-plan allowlist（已在 tip `95b4bdf`）
- No new migration / no `0058`
- teaching-workspace / resume-card / preference-controls / block-commands 行为未改写
- No OpenMAIC / raw HTML animator / mastery invention
- No commit / push / hermes / stash / reset / self-ACCEPT / `tasks.json` verified
- 无关未跟踪文档（`rp5-gha-…`、`p0-assistant-list-…`）未动

## UX summary

1. **Catalog** allowlists `matrix_transform`; legacy `matrix-viz*` normalize to it (no longer unknown→skip when type known).  
2. **Interactive** stepper: 暂停/继续、重置、上一步/下一步、文字替代；键盘 Space / Home / ←→ / `[` `]`；`aria-keyshortcuts` 已标注。  
3. **`prefers-reduced-motion: reduce`** → `resolveEffectiveAutoplay` **forces false**（内容 `autoplay` 本就 default false）。  
4. **文字替代** 面板：`buildTextAlternative` 同参表格+标签。  
5. **Interactive off**（`OPENING_MATRIX_TRANSFORM_INTERACTIVE=0|false|no|off`）或调用方 `interactive={false}` → **`staticFallbackModel` 表 + 文字**（同参；非空 unknown）。  
6. **Parse fail** → 诚实错误列表 + `data-math-params-error`；**不伪造数值**。  
7. 数字一律走 domain `stepPlan` / `stepApply` / `formatVectorCells` / `staticFallbackModel`；UI 展示诚实文案「漂亮不等于已核验正确」。  
8. Soft `stepIndex`/`paused`/`showTextAlt` 可经 `onInteractionChange` + `parseMatrixTransformInteractionParams` 导出；**本切片未强制 POST checkpoint**（软缺口，见下）。

## Soft gaps (honest)

1. **Browser:** `not_run` / pending_user（本切片无交互浏览器验收；pretty ≠ correct）。  
2. **Checkpoint soft-write：** `onInteractionChange` 回调已就绪，但 TeachingWorkspace **未**在本切片接线 POST `interactionParams[blockId]`；空默认 OK（PM lock 4 / Plan soft）。  
3. **jsdom 用户事件：** vitest 环境为 `node`；键盘/按钮以 **纯函数状态机 + SSR markup** 覆盖，完整 DOM keydown/click 机 **not_run**（与 V2-14 Continue 交互机 soft gap 同风格）。  
4. **Autoplay timer：** reduced-motion / default-off 已测；真实 interval 推进仅在 `effectiveAutoplay && !paused` 时挂载，浏览器下目视 **not_run**。  
5. **Compiler emit** 首单元真实 matrix 内容 — Data lock 7 follow-up；不阻塞 Experience。  
6. Data soft gaps（optional Y vs A·x cross-check 等）本切片不宣称。

## Commands run + results

### Tip

```text
$ git rev-parse HEAD
95b4bdf3df71cb6f4ac30aba42eadd9bc39f17b4

$ git rev-parse --short HEAD
95b4bdf

$ git log -1 --oneline
95b4bdf feat(opening): V2-15 matrix_transform math model (Data half)

$ git branch --show-current
feat/opening-release

$ ls packages/database/src/migrations/0058* 2>/dev/null || echo 'no 0058'
no 0058

$ date '+%Y-%m-%d %H:%M %Z'
2026-10-11 13:52 CST
```

### Targeted vitest

```text
$ PATH="./node_modules/.bin:$PATH" bash scripts/run-heavy.sh vitest run \
    apps/web/src/features/opening/teaching/blocks/matrix-transform.test.ts \
    apps/web/src/features/opening/teaching/component-catalog.test.ts \
    apps/web/src/features/opening/teaching/block-renderer.test.ts

 Test Files  3 passed (3)
      Tests  27 passed (27)
   Duration  ~3.07s
# exit 0
```

（matrix-transform.test 7 + component-catalog.test 14 + block-renderer.test 6 = 27）

### Typecheck

```text
$ cd apps/web && npx tsc -p tsconfig.json --noEmit
# exit 0 (no diagnostics)
```

### Browser

```text
not_run / pending_user
```

### Dirty scope (no commit)

```text
 M apps/web/src/features/opening/teaching/block-renderer.test.ts
 M apps/web/src/features/opening/teaching/block-renderer.tsx
 M apps/web/src/features/opening/teaching/component-catalog.test.ts
 M apps/web/src/features/opening/teaching/component-catalog.ts
?? apps/web/src/features/opening/teaching/blocks/
#   matrix-transform.tsx
#   matrix-transform.test.ts
# (+ this evidence file when written)
```

## Accept ask (Integrator) — 中文交接

请 **ACCEPT** V2-15 Experience UI 半边，若满足：

1. Tip 仍为 `95b4bdf`（脏树仅 Experience：`blocks/matrix-transform*` + catalog + block-renderer；**未**改 Data contracts/domain/teaching-plan）。  
2. Catalog 含 `matrix_transform`；`matrix-viz` / `matrix_viz` / `matrixviz` 别名映射到它；非法 html/script 仍 fail-soft。  
3. UI 暴露 **暂停 / 重置 / 步进 / 键盘**；`prefers-reduced-motion` **强制** autoplay off；文字替代走 `buildTextAlternative`。  
4. Interactive off / parse fail → **静态表 + 文字**（`staticFallbackModel`）；parse OK 时不落空 unknown。  
5. 数字以 domain 纯函数为准；诚实文案标注 pretty ≠ correct。  
6. 定向 vitest **3 files / 27 tests** 绿 + `apps/web` tsc 干净；Browser 诚实 `not_run`。  
7. Soft gaps（浏览器、checkpoint POST 未接线、jsdom 用户事件 not_run、compiler emit OOS）已如实记录。

**请勿**在 Integrator ACCEPT 前把 `tasks.json` 标 verified。
