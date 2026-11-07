# Hermes quick-fix — vision soft readiness（不挡文本辅导）

**Date:** 2026-10-09 ~23:51 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release` @ **`03ea7b4`**  
**Owner:** AIstudy AI（severity/gates）+ Experience（links / soft UX / `#daily-budget`）  
**Commit/push:** 已在 tip `03ea7b4`（`feat(web): surface daily AI budget on advanced settings`）；本 agent **不再另推**  
**tasks.json:** **not edited**

## Product alignment

| Rule | Status |
|---|---|
| Daily budget 0 → `available_model` unavailable | **KEEP** |
| `vision_model` missing must **not** hard-block text tutor / “AI 为何还不可用” | **DONE** — `severity: soft` + checklist hard-blocker filter |
| Links → `/settings/advanced`、`#daily-budget` | **DONE on tip**（Experience 半） |

## AI-side files (gates/contract)

| File | Role |
|---|---|
| `packages/ai/src/opening/ai-readiness.ts` (+ test) | `buildAiReadinessItems` + `severity`; soft: `vision_model`, `reconciled_unknown` |
| `packages/ai/src/index.ts` | exports |
| `apps/web/src/app/api/opening/ai-readiness/route.ts` | uses builder（items 带 `severity`） |
| `apps/web/src/features/opening/assistant/ai-readiness.tsx` (+ test) | 仅 hard blocker 打开「AI 为何还不可用」；soft vision 可单独提示 |

## Shared contract → Integrator

- Additive: readiness item `severity: "hard" | "soft"`.
- No `packages/contracts` zod yet — Integrator 可补 schema。
- Budget-0 / catalog `budget_disabled` **未改**.

## Experience handoff

Tip 已含 Experience 改动（见同目录 `ai-budget-readiness-ux.md`）：`/settings/advanced` 链接、`#daily-budget`、vision soft 提示面板。若仍有文案微调由 Experience 收口；**AI 侧不再改 UI 链接**。

## Verification (re-run @ 03ea7b4)

```text
node node_modules/vitest/vitest.mjs run --project unit \
  packages/ai/src/opening/ai-readiness.test.ts \
  apps/web/src/features/opening/assistant/ai-readiness.test.ts
→ passed（与 budget-contract-discovery 一并跑时：3 files / 16 passed | 4 expected fail）
```

**Browser:** not run.

## Verdict

**Accept-ready** on tip for Hermes vision soft-gate + budget-0 hard keep.
