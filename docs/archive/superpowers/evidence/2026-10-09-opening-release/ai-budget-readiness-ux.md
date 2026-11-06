# AI daily budget UX + soft vision readiness (Experience)

**Date:** 2026-10-09 ~23:50 CST  
**Branch:** `feat/opening-release` (uncommitted UI)  
**Scope:** Expose daily-cap confirm on `/settings/advanced`; link readiness to advanced; vision non-blocking in checklist UI.

## Changes
- `ai-settings-panel.tsx` — always-visible `#daily-budget`「开启并确认每日额度」
- `settings-view.tsx` — short links to `/settings/advanced#daily-budget`
- `ai-readiness.tsx` (+ model/test) — hard blockers exclude vision; links → `/settings/advanced`
- `ai-readiness/route.ts` — uses shared item builder (AI half may own severity); Experience UI softens vision

## Gates
```
npx vitest run --project unit apps/web/src/features/opening/assistant/ai-readiness.test.ts apps/web/src/features/settings/settings-view.nav.test.ts apps/web/src/features/settings/ai-settings-model.test.ts
→ 3 files / 13 tests PASSED
npx tsc -p apps/web/tsconfig.json --noEmit → PASS (after label typing fix)
```
