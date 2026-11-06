# IMPLEMENT：Holistic cite Package A — Never silent-ungrounded (C2/C16/C19)

**Date:** 2026-10-10 ~22:48 CST (Asia/Shanghai)  
**Owner:** Experience (Grok Bot executor)  
**Branch:** `feat/opening-release`  
**Tip baseline:** `a837bb8` (hermes deploying — **not pushed**)  
**Status:** **READY_FOR_ACCEPT** (no commit / no push / `tasks.json` untouched)  
**Plan:** `docs/superpowers/plans/opening-release/holistic-chat-cite-audit-p0-plan.md` § Package A  
**Auth:** Integrator AGREE + PM assigned Experience Package A

## Scope respected

- **No** commit / push  
- **No** force-every-turn citation (T02)  
- **No** fabricated chips from `sourceIds` alone  
- Free chat (`courseId==null`, no membership flag) still allows empty `sourceIds`  
- Package B/C/D retrieval / membership pool / page deep-link **not** in this turn

## Changes

### C16 — Ephemeral cite display parity

| Path | Change |
|---|---|
| `packages/contracts/src/opening/tutor.ts` | `ephemeralTurnResponseSchema` adds `citations: Citation[].default([])` |
| `apps/web/.../tutor/ephemeral-service.ts` | Soft-filter `citedChunkIds` → `resolveCitations(ids, context)` → return `citations` (unknown filtered; never fabricate) |
| `apps/web/.../assistant/assistant-view.tsx` | `appendEphemeralResponseIfActive` maps `output.citations` + `citationLabels`; stops hardcoding `citations: []` |

### C19 — General badge when materials intended but uncited

| Path | Change |
|---|---|
| `apps/web/.../assistant/message-model.ts` | `hadMaterialContext?: boolean`; `showsGeneralMaterialBadge()` |
| `apps/web/.../assistant/message-list.tsx` | Empty cites + `hadMaterialContext` →「一般说明（未引用材料）」; cites present keep「出处：」 |
| `assistant-view.tsx` | Ephemeral assistant sets `hadMaterialContext` from turn `sourceIds.length > 0` |

### C2 — Soft confirm empty selection in course context

| Path | Change |
|---|---|
| `assistant-view.tsx` | `shouldConfirmEmptyCourseSources` + `EMPTY_COURSE_SOURCES_CONFIRM`; `handleSubmit` confirms when `courseId` set and `sourceIds` empty; cancel opens 参考资料 (`setContextOpen(true)`); free chat skips |

## Files touched

- `packages/contracts/src/opening/tutor.ts`
- `packages/contracts/src/opening/contracts.test.ts`
- `apps/web/src/features/opening/tutor/ephemeral-service.ts`
- `apps/web/src/features/opening/tutor/ephemeral-service.test.ts`
- `apps/web/src/features/opening/assistant/assistant-view.tsx`
- `apps/web/src/features/opening/assistant/assistant-view.test.ts`
- `apps/web/src/features/opening/assistant/message-list.tsx`
- `apps/web/src/features/opening/assistant/message-list.test.ts`
- `apps/web/src/features/opening/assistant/message-model.ts`
- `apps/web/src/features/opening/assistant/message-model.test.ts`

## Commands run

```bash
cd apps/web && npx tsc --noEmit
# exit 0

npx vitest run \
  apps/web/src/features/opening/assistant/assistant-view.test.ts \
  apps/web/src/features/opening/assistant/message-list.test.ts \
  apps/web/src/features/opening/assistant/message-model.test.ts \
  apps/web/src/features/opening/assistant/composer.test.ts \
  apps/web/src/features/opening/tutor/ephemeral-service.test.ts \
  apps/web/src/features/opening/tutor/ephemeral-abort.test.ts \
  apps/web/src/features/opening/tutor/ephemeral-privacy.test.ts \
  apps/web/src/features/opening/client/api.test.ts \
  packages/contracts/src/opening/contracts.test.ts \
  packages/contracts/src/opening/snippets.test.ts
# 10 files / 158 tests passed
```

## Skipped checks

- Manual UI: 临时对话选材料 → 出处 chips; 不选材料自由问 → no false「出处」; course-bound empty selection confirm (unit covered; browser not driven this turn)
- Full monorepo / GHA / hermes redeploy
- Membership-aware `hasReadyCourseMaterials` wiring beyond helper + unit (Package B pool)

## Diff summary (uncommitted)

```
10 files changed, 234 insertions(+), 7 deletions(-)
tip still a837bb8 — working tree dirty, not committed/pushed
```

## Ready for Accept

- [x] Ephemeral assistant messages resolve `citedChunkIds` → `Citation[]` via service `resolveCitations`
- [x] Unknown ids filtered; no fabricated rows from sourceIds
- [x] MessageList general badge when `hadMaterialContext && citations.length===0`
- [x] Soft confirm when course-bound + empty sourceIds; free chat allowed
- [x] T02: do not force ≥1 citation every turn
- [x] `tsc --noEmit` + relevant vitest green
- [x] **Not** committed / **not** pushed

## Blockers / notes for Integrator

- None for Package A Accept. Coordinate hermes redeploy of tip `a837bb8` before push of this client/contract delta.
- Durable `TurnRecord` still lacks per-turn `sourceIds` in the API contract, so saved turns do not yet set `hadMaterialContext` after reload (ephemeral + MessageList unit cover C19; durable badge needs turn field or later package).
