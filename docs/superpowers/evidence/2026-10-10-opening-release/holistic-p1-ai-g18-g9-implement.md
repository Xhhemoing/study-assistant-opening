# Holistic upload/materials P1 — AI G18 + G9 align implement

**Date:** 2026-10-10 ~23:45 CST (Asia/Shanghai)  
**Branch tip at start:** `feat/opening-release` @ `3af5c01`  
**Owner:** AI (this wave)  
**Status:** implemented locally — **no commit / push / stash / reset**

Companion: `holistic-upload-materials-audit-understand.md` G18/G9; P0 plan P1 backlog; Pipeline note in `holistic-p1-pipeline-g12-g19-g8-g9-implement.md` § Note for AI.

---

## What changed

### G18 — Surface budget confirm on assistant when hard-blocked (main)

**Problem:** After R2, daily budget lives under `/settings/advanced`; learners miss `budgetConfirmedAt` + positive cap. Readiness panel existed but confirm CTA was easy to miss (generic “打开高级设置” buried under a long checklist).

**UX (assistant checklist, above composer — already embedded in `assistant-view.tsx`):**

1. When hard-blocked **and** blockers include `daily_budget` and/or `available_model`:
   - Compact banner leads with: **「日额度未开启/未确认，辅导暂不可用」**
   - Primary CTA button: **「去确认每日额度」** → `/settings/advanced#daily-budget` (hash already used by settings nav / `#daily-budget` section in `ai-settings-panel.tsx`)
   - Short supporting copy that names cap + confirm requirement
2. Checklist list still follows for other hard rows; soft rows (`parser_ocr`, `vision_model`, `reconciled_unknown`) stay filtered out of the hard list.
3. Provider-only hard fail keeps the previous generic advanced-settings link (no budget banner).
4. Reuses existing readiness API items only — no new schema / no extra `budgetConfirmedAt` field required for copy (effective cap 0 already surfaces as `daily_budget` hard fail).

**Helpers** in `ai-readiness-model.ts`: `needsBudgetConfirmCta`, `isBudgetRelatedHardBlocker`, `BUDGET_CONFIRM_*` constants; soft-key set includes `parser_ocr`.

**Presentational split:** `AiReadinessChecklistView` (items in) + fetch wrapper `AiReadinessChecklist` — unit-testable via `renderToStaticMarkup`.

Did **not** restyle Experience materials UI (G5/G13/G15/G16); only touched readiness files for G18.

### G9 — Soft `parser_ocr` align / verify (do not regress)

Verified against Pipeline contract (`holistic-p1-pipeline-g12-g19-g8-g9-implement.md` § Note for AI):

| Field | Expected (Pipeline) | AI verify |
|---|---|---|
| Soft key | `parser_ocr` | Present in `AI_READINESS_SOFT_KEYS` (`packages/ai`) and checklist soft set / legacy filter |
| Fact | `parserOcrReady` from `PARSER_OCR_MODEL_DIR` trim | Route wires it; builder uses it |
| Detail ok / not | `扫描件 OCR 已配置` / `扫描件 OCR 未配置` | Unchanged |
| fixHint | mentions `PARSER_OCR_MODEL_DIR` | Unchanged |
| Severity | soft only — must not hard-block text tutor | Checklist filter + unit tests assert soft OCR never hard-blocks / never opens budget banner alone |

AI wave did not rework Pipeline G9 plumbing; consolidated checklist soft-key handling so G18 CTA logic and G9 soft filter share one model. Soft OCR fail alone still renders nothing (no hard panel).

---

## Tests

```bash
npm test -- --project unit \
  apps/web/src/features/opening/assistant/ai-readiness.test.ts \
  packages/ai/src/opening/ai-readiness.test.ts
```

Result: **2 files, 22 tests passed** (vitest 4.1.10).

Coverage added for G18:

- Banner + CTA + `#daily-budget` href when `daily_budget` hard-fails
- CTA when only `available_model` hard-fails
- No budget banner for provider-only hard fail
- Soft `parser_ocr` alone → empty render (never hard-blocks)

---

## Files touched (this AI wave)

| Path | Gap |
|---|---|
| `apps/web/src/features/opening/assistant/ai-readiness-model.ts` | G18 helpers + G9 soft-key set |
| `apps/web/src/features/opening/assistant/ai-readiness.tsx` | G18 banner/CTA; presentational split; G9 soft filter via model |
| `apps/web/src/features/opening/assistant/ai-readiness.test.ts` | G18 + G9 soft OCR tests |

Pipeline-owned G9 files already on the tree (left aligned, not re-authored beyond verify): `packages/ai/.../ai-readiness.ts`, route `parserOcrReady`, inbox OCR copy.

---

## Explicit non-goals

- No commit / push / stash / reset.
- Did not touch untracked `rp5-gha…` evidence.
- No Data G4 / Pipeline G12/G19/G8 rework.
- No Experience G5/G13/G15/G16 materials UI.
- No hermes deploy.
- Did not edit `tasks.json` verified rows.

---

## Suggested Accept focus

1. Hard-blocked + `daily_budget`/`available_model` → lead「日额度未开启/未确认…」+ CTA「去确认每日额度」→ `/settings/advanced#daily-budget`.
2. Soft `parser_ocr` never hard-blocks; alone does not open readiness hard panel.
3. Unit tests green; evidence path this file; **未推**.
