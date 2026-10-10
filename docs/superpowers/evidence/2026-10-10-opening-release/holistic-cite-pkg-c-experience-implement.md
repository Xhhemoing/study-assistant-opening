# Cite Package C — Experience thin UI implement

**Date:** 2026-10-10 (Asia/Shanghai)  
**Branch:** `feat/opening-release` (HEAD baseline `acceadb`; dirty tree includes AI Package C WIP)  
**Owner:** Experience  
**Plan:** `docs/superpowers/plans/opening-release/holistic-chat-cite-audit-p0-plan.md` § Package C (toast / checkbox sync)  
**Status:** IMPLEMENT (Experience half only) — **not committed / not pushed**

## Scope done (Experience)

1. **Schema**
   - Did **not** edit contracts: AI already added optional `effectiveSourceIds: z.array(uuid).max(32).optional()` on `ephemeralTurnResponseSchema` (dirty in `packages/contracts/src/opening/tutor.ts`). Client parses via existing `ephemeralTurnResponseSchema.parse`.

2. **Ephemeral response → selection sync**
   - After `replyEphemeral` succeeds, if `output.effectiveSourceIds?.length > 0`:
     - `setSelectedSourceIds(uniqueCappedSourceIds(...))` (dedupe, cap 32, order-preserving; trust server ids only).
     - Set dismissible notice: `已按问题自动选入 N 份课程材料`.
   - Omitted / undefined / empty → no notice (explicit client selection path unchanged).
   - Notice cleared on next submit; also dismissible via「关闭」.

3. **courseId on ephemeral request**
   - When `boundCourseId` is set, pass `courseId` into `replyEphemeral` so AI pool fill / auto-pick can run and echo `effectiveSourceIds`.

4. **hadMaterialContext**
   - Ephemeral append uses effective ids when present (so auto-picked turns are not treated as “一般说明”).

5. **Saved-turn path**
   - **Not wired:** `submitTurn` returns job ids only; no `effectiveSourceIds` on saved response yet. Ephemeral path is enough for this package (per contract). Sticky resume after auto-pick remains Data/AI follow-up.

## Out of scope (AI owns)

- `packages/ai` pick-sources / context fallback
- `ephemeral-service` / tutor-turn server echo logic (already WIP on tree)
- Persist effectiveSourceIds on saved turns

## Files touched (Experience)

| Path | Change |
|---|---|
| `apps/web/.../assistant/course-source-selection.ts` (+ test) | `uniqueCappedSourceIds` |
| `apps/web/.../assistant/assistant-view.tsx` (+ test) | `autoSelectSourcesNotice` / `applyEffectiveSourceIds`; ephemeral sync + notice banner; pass `courseId` |

## Gates

```bash
cd apps/web && npx tsc --noEmit
# from repo root:
npx vitest run apps/web/src/features/opening/assistant/course-source-selection.test.ts \
  apps/web/src/features/opening/assistant/assistant-view.test.ts --project unit
```

**Results (2026-10-10 ~23:22 CST):**
- `apps/web` `npx tsc --noEmit` — PASS
- vitest unit (2 files) — **43 passed** (includes Package C helpers)

## Diff summary (Experience only)

- Helpers: unique capped replace of selection from server echo; notice only when length > 0.
- UI: emerald status banner under composer pending hint, dismissible.
- Request: optional `courseId: boundCourseId` on ephemeral POST.

## Blockers / notes

- **Schema ready** (AI dirty): no Experience contracts edit required.
- Saved-path echo still absent — documented above; not blocking ephemeral Package C UX.
- Soft-confirm (Package A) may still fire before empty+course auto-pick; after success the auto-select notice replaces “一般说明” expectation — product polish deferred.
