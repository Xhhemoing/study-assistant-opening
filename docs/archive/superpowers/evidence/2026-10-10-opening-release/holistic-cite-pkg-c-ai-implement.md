# cite Package C — AI implement (retrieval fallback + thin smart pick)

**Owner:** AIstudy AI  
**Date:** 2026-10-10 ~23:23 CST (Asia/Shanghai)  
**Branch tip baseline:** `feat/opening-release` @ `acceadb`  
**Status:** implemented — awaiting Integrator Accept  
**Push:** **未推** (no commit / no push / no stash / no reset)

## Scope (AI half)

1. **`selectContext` honesty fallback** (`packages/ai/src/opening/context.ts`): when query scores are all 0 but usable chunks exist, keep preferPage/preferChunkId then budget-fill selected sources in deterministic order — never silently empty.
2. **`pickSourceIds` / `shouldAutoPickSources`** (`packages/ai/src/opening/pick-sources.ts`): keyword/CJK rank sources by best chunk score; top-K default **6**; only auto-narrow when client `sourceIds` empty and pool size > K. Explicit client selections never narrowed.
3. **Wire** ephemeral + tutor-service (+ light tutor-turn): apply pick then `selectContext` fallback.
4. **`effectiveSourceIds`** on `ephemeralTurnResponseSchema` (optional): echo **only** when server changed selection vs client input (fill/auto-pick). Explicit non-empty client ids used as-is → omit field (Experience toast contract).

## Files

| Path | Change |
|---|---|
| `packages/ai/src/opening/context.ts` (+test) | score helper + miss fallback |
| `packages/ai/src/opening/pick-sources.ts` (+test) | thin smart pick |
| `packages/ai/src/index.ts` | exports |
| `packages/contracts/src/opening/tutor.ts` (+contracts.test) | optional `effectiveSourceIds` |
| `apps/web/.../ephemeral-service.ts` (+test) | fill/pick/fallback + echo |
| `apps/web/.../tutor-service.ts` | pick after B fill on saved submit |
| `apps/worker/src/jobs/tutor-turn.ts` | selectContext fallback path |
| this evidence | |

Experience UI left alone (`assistant-view` / toast owned by Experience).

## Tests

```bash
./node_modules/.bin/vitest run \
  packages/ai/src/opening/context.test.ts \
  packages/ai/src/opening/pick-sources.test.ts \
  apps/web/src/features/opening/tutor/ephemeral-service.test.ts \
  packages/contracts/src/opening/contracts.test.ts \
  apps/worker/src/jobs/tutor-turn.test.ts
```

**Result:** Test Files **5 passed**; Tests **118 passed** (~23:23 CST).

## Contract (aligned with Experience)

- Field: `effectiveSourceIds?: string[]` (uuid, max 32) on ephemeral response.
- Present only when server changed selection; UI syncs checkboxes +「已按问题自动选入 N 份课程材料」when length > 0.

## Non-goals

No embeddings / Pinecone / GraphRAG; no Package D; no push.

## REJECT re-fix (2026-10-10 ~23:26 CST)

Integrator REJECT (`holistic-cite-pkg-c-ai-accept.md`): worker `tutor-turn` top-K on any `sourceIds.length > 6` including explicit client selections.

**Fix:** remove worker-side `pickSourceIds` entirely. Thin pick remains only at submit (`tutor-service` / ephemeral) via `shouldAutoPickSources(clientEmpty, pool>K)`. Worker turns already persist effective ids from submit — never re-narrow.

**Regression tests added:**
- `tutor-turn.test.ts`: explicit 7 matching sources → all 7 reach provider context (not capped to 6)
- `tutor-service.test.ts`: empty+pool>8 → append ≤6 with best match first; explicit 7 ids unchanged, pool helper not called

**Re-run:**
```bash
./node_modules/.bin/vitest run \
  apps/worker/src/jobs/tutor-turn.test.ts \
  apps/web/src/features/opening/tutor/tutor-service.test.ts \
  packages/ai/src/opening/context.test.ts \
  packages/ai/src/opening/pick-sources.test.ts \
  apps/web/src/features/opening/tutor/ephemeral-service.test.ts \
  packages/contracts/src/opening/contracts.test.ts
```
→ **6 files / 138 passed**. 未推.
