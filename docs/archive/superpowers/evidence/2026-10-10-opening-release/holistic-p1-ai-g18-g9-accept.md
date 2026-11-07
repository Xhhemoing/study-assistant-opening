# ACCEPT：upload/materials P1 — AI G18 + G9 soft-align

**Date:** 2026-10-10 ~23:46 CST (Asia/Shanghai)  
**Reviewer:** Integrator (Grok Bot executor)  
**Branch:** `feat/opening-release`  
**Tip baseline:** `3af5c01` (working tree dirty for multiple P1 waves; this Accept covers **AI G18 + G9 only**)  
**Verdict:** **ACCEPT**  
**Claim:** `holistic-p1-ai-g18-g9-implement.md`  
**Plan:** `holistic-upload-materials-audit-p0-plan.md` § P1 backlog G18 / G9; gap inventory `holistic-upload-materials-audit-understand.md` § G18 / G9  
**Pipeline contract (G9):** `holistic-p1-pipeline-g12-g19-g8-g9-implement.md` § Note for AI

---

## Verdict

**ACCEPT** upload/materials P1 **AI G18 + G9 soft-align**:

1. **G18** — When the assistant readiness checklist is hard-blocked and blockers include `daily_budget` and/or `available_model`, the panel leads with banner copy **「日额度未开启/未确认，辅导暂不可用」** and primary CTA **「去确认每日额度」** → `/settings/advanced#daily-budget` (hash target exists on `ai-settings-panel.tsx` `id="daily-budget"`). Provider-only hard fail keeps the generic advanced-settings link (no budget banner).
2. **G9** — Soft `parser_ocr` remains soft-only (does not hard-block text tutoring); checklist soft-key set + `packages/ai` soft keys / route `parserOcrReady` / OCR copy stay aligned with Pipeline contract. **Not re-regressed** by the G18 wave.

No product edits by this Accept turn, no commit/push/stash/reset. Pipeline G4 cron, G12/G19/G8 packages, and Experience materials UI are **out of verdict** (dirty tree may contain that WIP).

---

## Gates (re-run 2026-10-10 ~23:45–23:46 CST)

```bash
cd /workspace/study-assistant-opening
npm test -- --project unit \
  apps/web/src/features/opening/assistant/ai-readiness.test.ts \
  packages/ai/src/opening/ai-readiness.test.ts
# → Test Files  2 passed (2)
# → Tests       22 passed (22)
# → vitest 4.1.10

npx tsc -p packages/ai/tsconfig.json --noEmit   # exit 0
npx tsc -p apps/web/tsconfig.json --noEmit      # exit 0
```

| Gate | Result |
|---|---|
| Vitest AI readiness (**2 files / 22**) | **Pass** |
| `packages/ai` tsc --noEmit | **Pass** (exit 0) |
| `apps/web` tsc --noEmit | **Pass** (exit 0) |

---

## Spot-checks (claim / plan acceptance hooks)

| Hook | Result |
|---|---|
| G18 lead: `BUDGET_CONFIRM_LEAD` = 「日额度未开启/未确认，辅导暂不可用」 | **Pass** — `ai-readiness-model.ts` + rendered in `AiReadinessChecklistView` |
| G18 CTA: 「去确认每日额度」 → `/settings/advanced#daily-budget` | **Pass** — `BUDGET_CONFIRM_CTA` / `BUDGET_CONFIRM_HREF`; `data-testid="ai-readiness-budget-cta"` |
| Settings hash target `#daily-budget` exists | **Pass** — `ai-settings-panel.tsx` `id="daily-budget"` |
| CTA when `available_model` hard-fails alone | **Pass** — helper + view test |
| No budget banner for provider-only hard fail | **Pass** — generic `/settings/advanced` link retained |
| Checklist still embedded above composer | **Pass** — `assistant-view.tsx` renders `<AiReadinessChecklist>` |
| G9 soft key `parser_ocr` in `AI_READINESS_SOFT_KEYS` | **Pass** — `packages/ai` |
| G9 fact `parserOcrReady` from `PARSER_OCR_MODEL_DIR` trim | **Pass** — route + builder |
| G9 detail ok/not + fixHint mentions `PARSER_OCR_MODEL_DIR` | **Pass** — unchanged Chinese copy |
| G9 severity soft — never hard-blocks text tutor | **Pass** — soft filter + empty render when OCR alone fails |
| Checklist soft set includes `parser_ocr` (legacy payloads) | **Pass** — `AI_READINESS_CHECKLIST_SOFT_KEYS` |
| Inbox scanned empty-text OCR honesty | **Pass** (Pipeline-owned; present) — 「图片或扫描页在未配置 OCR 时无法提取文字。」 |

### Stronger review (tests green without real G18 banner/link or G9 soft = REJECT)

| Risk | Assessment |
|---|---|
| Tests mock CTA without product banner | **Rejected risk** — `AiReadinessChecklistView` product JSX contains lead + Link + testids; tests use `renderToStaticMarkup` on the real view |
| Banner only in tests / constants unused | **Rejected risk** — constants imported and rendered in `ai-readiness.tsx` hard-blocked branch when `needsBudgetConfirmCta` |
| Soft OCR “verified” only by claim text | **Rejected risk** — unit asserts soft severity, hard-blocker false, soft-OCR-alone → empty HTML; filter excludes OCR from hard list even when budget banner shows |
| G18 waves regresses G9 soft filter | **Not observed** — soft set consolidated to include `parser_ocr`; soft OCR alone still opens no hard panel; hard list still filters soft rows |
| Fake href / wrong hash | **Rejected risk** — href matches settings nav + panel `id="daily-budget"` |

**Blockers:** none for AI G18 + G9 soft-align.

---

## G9 regression status (honest)

- **Pipeline wave** authored `packages/ai` `parser_ocr` soft item, route `parserOcrReady`, inbox OCR empty-text copy, and initial checklist soft-key honesty (same dirty tree vs `3af5c01`).
- **AI wave** consolidated checklist soft-key handling for G18 CTA logic and re-verified soft OCR never hard-blocks / never opens budget banner alone.
- Accept re-ran both readiness test files: soft OCR behavior still green; no hard-block regression found.
- Full OCR *extraction* (RapidOCR / scanned PDF text) remains an ops/env concern (`PARSER_OCR_MODEL_DIR`); this slice only covers **readiness honesty + soft severity**, not turning OCR on.

---

## Files in scope (this Accept)

| Path | Role |
|---|---|
| `apps/web/src/features/opening/assistant/ai-readiness-model.ts` | G18 helpers/constants + G9 soft-key set |
| `apps/web/src/features/opening/assistant/ai-readiness.tsx` | G18 banner/CTA presentational view; soft filter |
| `apps/web/src/features/opening/assistant/ai-readiness.test.ts` | G18 + G9 soft OCR unit coverage |
| `packages/ai/src/opening/ai-readiness.ts` | G9 soft item + facts (Pipeline-owned; verified) |
| `packages/ai/src/opening/ai-readiness.test.ts` | G9 soft unit coverage (verified) |
| `apps/web/src/app/api/opening/ai-readiness/route.ts` | `parserOcrReady` wiring (Pipeline-owned; verified) |
| `docs/superpowers/evidence/2026-10-10-opening-release/holistic-p1-ai-g18-g9-implement.md` | implement claim (read-only for Accept) |

## Explicitly not accepted here

- Pipeline G4 cron / worker sweep schedule
- Pipeline G12 (`extract-study-actions` queues), G19 (`PUBLIC_BASE_URL`), G8 (eml/ppt stored-only) as packages
- Experience G5/G13/G15/G16 materials UI
- hermes deploy / MemoryMax / Docling ops
- commit / push / stash / reset / `tasks.json` verified flips
