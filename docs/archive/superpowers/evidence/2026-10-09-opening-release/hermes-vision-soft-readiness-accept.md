# Hermes accept — vision soft readiness（不挡文本辅导）

**Date:** 2026-10-09 ~23:52 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release` @ **`03ea7b4`**  
**Workspace:** `/workspace/study-assistant-opening`  
**Evidence:** `hermes-vision-soft-readiness.md`  
**Verdict:** **ACCEPT** (agent-owned; **not verified**)  
**Browser:** **not run**. **tasks.json:** **not edited**.

## Criteria vs tip `03ea7b4`

| # | Criterion | Result | Notes |
|---|---|---|---|
| 1 | Budget 0 stays hard blocker | **PASS** | `daily_budget` / `available_model` not in `AI_READINESS_SOFT_KEYS`; `effectiveCapCents > 0` required |
| 2 | Vision missing → severity soft; not in hard 「AI 为何还不可用」 | **PASS** | `vision_model` → `severity: "soft"`; UI hard-blocker filter excludes soft |
| 3 | Optional additive `severity` field OK | **PASS** | `AiReadinessItem.severity: "hard" \| "soft"`; additive, no contracts zod required yet |

## Quick checks re-run

```text
rg severity soft / AI_READINESS_SOFT_KEYS in packages/ai/src/opening/ai-readiness.ts
→ soft keys: vision_model, reconciled_unknown; budget remains hard

node node_modules/vitest/vitest.mjs run --project unit \
  packages/ai/src/opening/ai-readiness.test.ts
→ Test Files  1 passed; Tests  5 passed
```

## Recommendation

**ACCEPT** Hermes vision soft-gate + budget-0 hard keep on tip `03ea7b4`. Do **not** mark verified; do **not** edit `tasks.json`.
