# Cite Package B — Experience UI implement

**Date:** 2026-10-10 (Asia/Shanghai)  
**Branch:** `feat/opening-release` (on top of Package A tip `0031b85`)  
**Owner:** Experience  
**Plan:** `docs/superpowers/plans/opening-release/holistic-chat-cite-audit-p0-plan.md` § Package B (C1/C3/C4/C5)  
**Status:** IMPLEMENT (Experience half only) — **not committed / not pushed**

## Scope done (Experience)

1. **courseId binding**
   - Assistant route reads `?courseId=` (`parseAssistantCourseIdParam`) and passes `initialCourseId` into `AssistantView`.
   - `createConversation` uses `learningAttempt?.courseId ?? initialCourseId ?? null`.
   - Resume / list filter / soft-confirm resolve via `resolveAssistantCourseId` (attempt → resume → query).
   - Soft confirm (Package A) also passes `hasReadyCourseMaterials` from membership-ready client filter.

2. **Membership-default picker**
   - Loads material-organization client `read()` memberships (no new membership semantics).
   - When `boundCourseId` set (and not practice-attempt-locked): `SourcePageControls` defaults to ready sources in membership; expand「显示工作区其他材料」for other ready workspace sources.
   - Selection capped at **32** (`MAX_ASSISTANT_SOURCE_IDS` / contracts TurnInput).

3. **Upload auto-select**
   - `UploadStrip.onUploaded(savedSourceIds?)` returns newly saved source ids.
   - Assistant auto-adds them into `selectedSourceIds` (pending ids kept; checkboxes appear when parse-ready).

## Out of scope / wait-on-Data

- **Did not edit** `packages/database`, tutor-service server fill, GraphRAG, Package A cite display.
- Data WIP may add `listReadySourceIdsForCourse` repository; **no web API client yet**. Experience filters client-side via organization memberships + sources list (`uploadState=uploaded` && `parseState=ready`). Prefer Data API when exposed on `/api/...`.

## Files touched (Experience)

| Path | Change |
|---|---|
| `apps/web/.../assistant/page.tsx` | `?courseId=` → `initialCourseId` |
| `apps/web/.../assistant/course-source-selection.ts` (+ test) | Resolve/parse/cap/membership helpers |
| `apps/web/.../assistant/source-page-controls.tsx` (+ test) | Membership default + expand + cap |
| `apps/web/.../assistant/upload-strip.tsx` | Callback returns saved source ids |
| `apps/web/.../assistant/assistant-view.tsx` (+ test) | Bind courseId, load org, auto-select, soft-confirm membership flag |

## Gates

```bash
cd apps/web && npx tsc --noEmit
# from repo root:
npx vitest run apps/web/src/features/opening/assistant/course-source-selection.test.ts \
  apps/web/src/features/opening/assistant/source-page-controls.test.ts \
  apps/web/src/features/opening/assistant/assistant-view.test.ts --project unit
```

**Results (2026-10-10 ~22:54 CST):**
- `apps/web` `npx tsc --noEmit` — PASS
- vitest unit (3 files) — **43 passed**

## Manual smoke

1. Open `/opening/assistant?courseId=<uuid>` → create turn → conversation persists courseId.
2. Course with membership ready sources → picker shows members; expand shows others.
3. Upload in inspector with courseId → new id appears in selection once saved.
