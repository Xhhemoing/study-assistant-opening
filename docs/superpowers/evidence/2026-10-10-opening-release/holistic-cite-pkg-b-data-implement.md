# cite Package B — Data implement

**Owner:** AIstudy Data  
**Date:** 2026-10-10 (Asia/Shanghai)  
**Base tip:** `0031b85` (Package A + cite plan)  
**Status:** implemented — awaiting Integrator Accept  
**Push:** not pushed

## Scope (Data half only)

`listReadySourceIdsForCourse(sql, scope, courseId): Promise<string[]>`

- Course owned by workspace owner, not archived; else `OpeningKnowledgeError` `NOT_FOUND`
- Sources via `course_asset_memberships` (`asset_type='source'`)
- `upload_state='uploaded'` and `parse_state='ready'`
- Privacy: `NOT EXISTS` on `opening_privacy_exclusions`
- Cap: `READY_COURSE_SOURCE_IDS_CAP = 32` (`LIMIT 32`)
- Order: `m.sort_order ASC, m.created_at ASC, s.id ASC`
- Factory: `createOpeningCourseReadySourcesRepository(sql)` → `(scope, courseId)` for AI deps injection

## Files

| Path | Change |
|---|---|
| `packages/database/src/repositories/opening-course-ready-sources.ts` | new |
| `packages/database/src/repositories/opening-course-ready-sources.test.ts` | new (7 tests) |
| `packages/database/src/index.ts` | export list + factory + cap + type |

## Not done (other owners)

- Experience UI (courseId bind, picker default membership, upload auto-select)
- AI tutor/ephemeral server fill of empty `sourceIds`
- HTTP route (not required if deps inject repository)
- commit / push

## Commands

```bash
npx vitest run packages/database/src/repositories/opening-course-ready-sources.test.ts
```

**Result:** Test Files 1 passed; Tests **7 passed**.

## Acceptance hooks for Integrator

- [ ] Export from `@aistudy/database`: `listReadySourceIdsForCourse`, `createOpeningCourseReadySourcesRepository`, `READY_COURSE_SOURCE_IDS_CAP`
- [ ] SQL excludes privacy + non-ready; LIMIT 32 present
- [ ] Vitest 7 green
- [ ] No UI / tutor-service edits in this Data slice
