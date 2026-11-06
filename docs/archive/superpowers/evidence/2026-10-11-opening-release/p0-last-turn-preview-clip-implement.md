# P0 — lastTurnPreview max 280 clip

**Date:** 2026-10-11 (Asia/Shanghai)  
**Agent:** AIstudy Data  
**Baseline tip:** `aa3f81ba26b244f13a6f10979a69c2912ed7345d`  
**Trigger:** Paula Zod `lastTurnPreview` too_big (max 280), path `[0,"lastTurnPreview"]`

## Fix
- `packages/database/src/repositories/opening-conversations.ts`
  - SQL: wrap full CASE (deleted-source message **or** `t.text`) in `LEFT(..., 280)` (not only ELSE branch)
  - Map: `clipLastTurnPreview(...)` defensive slice to 280
  - Exported `LAST_TURN_PREVIEW_MAX` / `clipLastTurnPreview`
- Test: `packages/database/src/repositories/opening-conversations-preview.test.ts` — oversize string fails schema parse; clipped passes

## Commands
```text
npx vitest run packages/database/src/repositories/opening-conversations-preview.test.ts --project unit
# 4 passed
```

## Non-actions
No push / commit / stash / reset / hermes. Did not modify `0053_*` migration tree.

## Ready for Integrator Accept

## Follow-up (PM 2026-10-11): PG char vs JS code-unit

Confirmed root cause class: Postgres `LEFT(n)` is by characters; Zod `.max(280)` is JS `String.length` (UTF-16 code units). Map-layer `clipLastTurnPreview` uses `slice(0, 280)` by code units.

Added regression: 280× `😀` (PG-char-clipped residue → JS length 560) fails schema until clipped; then parses. Vitest **4** passed.
