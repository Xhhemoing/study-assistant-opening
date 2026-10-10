# Cite Package C — Experience thin UI ACCEPT

**Date:** 2026-10-10 ~23:23 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release` @ tip `acceadb` (dirty tree; Experience half uncommitted)  
**Owner:** Integrator ACCEPT (Experience half only)  
**Plan:** `docs/superpowers/plans/opening-release/holistic-chat-cite-audit-p0-plan.md` § Package C (toast / checkbox sync)  
**Implement evidence:** `holistic-cite-pkg-c-experience-implement.md`  
**Verdict:** **ACCEPT**

## Slice

Experience thin UI only:

- Ephemeral `effectiveSourceIds` → sync checkboxes +「已按问题自动选入 N 份课程材料」
- `replyEphemeral` passes `courseId` when `boundCourseId` set
- Must **not** own contracts / `packages/ai` (AI half still WIP on tree)

## Diff vs tip `acceadb` (Experience files reviewed)

| Path | Verdict |
|---|---|
| `apps/web/.../assistant/assistant-view.tsx` | In scope — helpers + submit wiring + emerald banner |
| `apps/web/.../assistant/assistant-view.test.ts` | In scope — Package C helper tests |
| `apps/web/.../assistant/course-source-selection.ts` | In scope — `uniqueCappedSourceIds` |
| `apps/web/.../assistant/course-source-selection.test.ts` | In scope — dedupe/cap tests |

**Out of this Accept (dirty AI WIP — not rejected for Experience, not accepted here):**

- `packages/contracts/src/opening/tutor.ts` (+ contracts.test) — schema `effectiveSourceIds` (AI)
- `packages/ai/src/opening/context.ts`, `pick-sources.ts` (+ tests, index)
- `apps/web/.../tutor/ephemeral-service.ts` (+ test), `tutor-service.ts`
- `apps/worker/src/jobs/tutor-turn.ts` (+ test)
- `apps/web/src/features/opening/runtime.ts` (`listReadySourceIdsForCourse` wire for ephemeral)

Experience half did **not** edit contracts or `packages/ai`. No Experience scope creep into AI packages.

## Stronger review (green tests ≠ UX)

Unit suite only covers **exported helpers** (`autoSelectSourcesNotice`, `applyEffectiveSourceIds`, `uniqueCappedSourceIds`). It does **not** mount `AssistantWorkspace` or spy `replyEphemeral`. A green suite alone would not prove checkbox sync / banner.

**Code review of `handleSubmit` (ephemeral path):**

1. Clears `autoSelectNotice` on each submit.
2. Passes `courseId: boundCourseId` into `api.replyEphemeral` when bound.
3. On success: `applyEffectiveSourceIds(output.effectiveSourceIds)` → `setSelectedSourceIds` when non-empty; `setAutoSelectNotice` when notice non-null.
4. Append uses `turnSourceIds = applied.sourceIds ?? selectedSourceIds` so auto-picked turns set `hadMaterialContext` (via existing append helper).
5. Banner: `role="status"`, emerald styling, dismissible「关闭」; omitted/empty echo → no notice.

No dead-helper / test-only path found. Helpers are called from the real submit path. No fabricated client ids.

## Saved-turn gap (honest)

**Not verified / not wired:** saved `submitTurn` still returns job ids only; no `effectiveSourceIds` on saved response. Implement evidence documents this; sticky resume after auto-pick remains Data/AI follow-up. Accepts ephemeral Package C UX only.

Soft-confirm (Package A) may still fire before empty+course auto-pick — product polish deferred (noted in implement evidence); not a reject for this slice.

## Gates re-run (2026-10-10 ~23:23 CST)

```bash
(cd apps/web && npx tsc -p tsconfig.json --noEmit)
# PASS (exit 0)

npx vitest run \
  apps/web/src/features/opening/assistant/course-source-selection.test.ts \
  apps/web/src/features/opening/assistant/assistant-view.test.ts \
  --project unit
# Test Files  2 passed (2)
# Tests       43 passed (43)
```

## AI half

**Out of slice / not accepted here.** Dirty AI/contracts/worker changes remain for separate AI Package C implement + accept.

## Verdict

**ACCEPT** — Experience thin UI for Package C ephemeral auto-select notice + checkbox sync + `courseId` on ephemeral request. Gates green. AI half and saved-turn echo explicitly not accepted in this evidence.
