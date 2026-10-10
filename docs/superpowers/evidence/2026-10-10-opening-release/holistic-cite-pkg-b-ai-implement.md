# cite Package B — AI implement (server course-pool fill)

**Owner:** AIstudy AI  
**Date:** 2026-10-10 ~22:54 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release` (working tree)  
**Status:** implemented — awaiting Integrator Accept  
**Push:** **未推** (no commit / no push)

## Scope (AI half only)

On saved tutor `submitTurn` (`createTutorService`):

1. Load owned conversation (`getOwned`) — uses `courseId`.
2. If client `sourceIds.length === 0` **and** `conversation.courseId` is non-null → call dep `listReadySourceIdsForCourse(scope, courseId)` and use the result as effective `sourceIds` for authorization, page selection, and `appendSavedTurn`.
3. If client `sourceIds` is non-empty → keep them (explicit selection outranks course pool; no merge/expand).
4. If `courseId` set but pool returns `[]` → leave `sourceIds` empty (free/general path; no `COURSE_SOURCES_REQUIRED` 422).
5. Privacy + cap 32: **owned by Data** inside the helper — AI does not re-filter or re-limit.
6. Ephemeral: **skipped** this slice (no new optional `courseId` on ephemeral input); saved path only. Package A UI honesty covers empty-cite labeling.

## Data dep contract (wired)

```ts
listReadySourceIdsForCourse(scope: { workspaceId: string; ownerUserId: string }, courseId: string): Promise<string[]>
```

- Named export factory: `createOpeningCourseReadySourcesRepository(sql)` from `@aistudy/database`
- Semantics (Data): owned non-archived course; membership `uploaded`+`ready`; excludes `opening_privacy_exclusions`; `ORDER BY` sort_order/created_at/id; `LIMIT 32`; missing course → `OpeningKnowledgeError` `NOT_FOUND`
- Runtime wire:

```ts
listReadySourceIdsForCourse: (scope, courseId) =>
  createOpeningCourseReadySourcesRepository(sql).listReadySourceIdsForCourse(scope, courseId),
```

**Data helper was present and wired** (not left as a test-only stub). Unit tests inject the same `(scope, courseId)` signature via deps.

## Files touched (AI)

| Path | Change |
|---|---|
| `apps/web/src/features/opening/tutor/tutor-service.ts` | optional dep `listReadySourceIdsForCourse`; effectiveSourceIds fill on empty+courseId |
| `apps/web/src/features/opening/tutor/tutor-service.test.ts` | 4 Package B fill tests; factory accepts courseId + pool stub |
| `apps/web/src/features/opening/runtime.ts` | wire `createOpeningCourseReadySourcesRepository(sql).listReadySourceIdsForCourse` |
| `docs/superpowers/evidence/2026-10-10-opening-release/holistic-cite-pkg-b-ai-implement.md` | this evidence |

## Files deliberately not touched

- Experience UI: `assistant-view*`, `message-list*`, `message-model*`, upload/picker (Package A / Experience B)
- Data repo implementation (already landed; see `holistic-cite-pkg-b-data-implement.md`)
- Ephemeral service / contracts courseId surface
- `tasks.json`, Pipeline parse paths, GraphRAG/embeddings
- No commit / no push

## Tests

```bash
./node_modules/.bin/vitest run apps/web/src/features/opening/tutor/tutor-service.test.ts
```

**Result:** Test Files **1 passed**; Tests **17 passed** (13 prior continuity + **4** Package B fill).

Package B cases:

1. `courseId` set + client `sourceIds: []` → pool called → `appendSavedTurn` gets filled ids  
2. non-empty client `sourceIds` → pool **not** called; append keeps client ids  
3. `courseId: null` + empty → no pool call; append `[]`  
4. `courseId` set + pool `[]` → append `[]` (no throw)  

Existing SOURCE_UNAVAILABLE / page selection / replay clientKey tests still pass.

Did **not** run full monorepo vitest.

## Blockers / cross-file notes

- No blocker. Data export already in `packages/database/src/index.ts`.
- Experience Package A / B UI diffs exist in the same working tree (`assistant-view.tsx`, `upload-strip.tsx`, `source-page-controls.tsx`, `course-source-selection.ts`, etc.) — **left alone** by AI half.
- No conflict with Data: AI consumes `(scope, courseId)` factory method; does not duplicate privacy/LIMIT.

## Acceptance hooks for Integrator

- [ ] Server fill when empty client sourceIds + conversation.courseId
- [ ] Explicit sourceIds outrank pool
- [ ] Empty pool → empty sourceIds, no hard 422
- [ ] Runtime wires real Data helper
- [ ] Vitest tutor-service 17 green
- [ ] 未推
