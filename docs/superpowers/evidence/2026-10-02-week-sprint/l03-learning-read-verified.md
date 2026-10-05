# L03 Real Learning Read and Course Integration Verification

Status: implementation and non-browser verification complete in this workspace. Browser A/B synchronization remains pending user acceptance. This is not release approval, evidence of learning effectiveness, or evidence of mastery.

## Implemented behavior

- The owner-scoped legacy `/api/opening/courses/[id]/learning` route keeps the server-derived learning summary path and returns an empty array for an owned course with no observations. It rejects anonymous access and conceals foreign or missing courses.
- The fixed-snapshot `/api/opening/courses/[id]/learning/summary` route validates `courseId`, `limit`, and `groupCursor` at the HTTP boundary, binds cursors to the owner, workspace, course, page size, privacy epoch, policy version, and evaluated timestamp, and returns complete group counts with bounded representatives.
- Summary reads distinguish `ready` from `updating`, repair stale eligibility before returning conclusions, preserve `evaluatedAt` across cursor traversal, and reject a changed semantic snapshot with `409` rather than mixing pages.
- `createOpeningLearningClient` validates successful responses and throws `OpeningApiError` for HTTP or malformed responses. It never creates demonstration or fallback learning data.
- `createCourseSummaryController` owns one course scope, handles initial load, cursor pagination, eligibility progress, snapshot conflicts, privacy refreshes, cancellation, and error states. The course view exposes empty, updating, error, ready, and load-more states from that server response.
- The no-mock contract continues to reject opening routes that import mock providers.

## Verification

All database-backed checks used the repository-managed isolated PostgreSQL at `127.0.0.1:15432/aistudy_opening_test` through `.local/opening-e2e/check-service-tests.ps1`. No production/default database or external/paid model provider was used. Database tests were run serially because they clear the same isolated database.

```text
node node_modules/vitest/vitest.mjs run --project unit apps/web/src/features/opening/client/learning-client.test.ts apps/web/src/features/opening/learning/course-summary-state.test.ts apps/web/src/features/opening/learning/course-view.test.ts apps/web/src/features/opening/learning/course-history-state.test.ts apps/web/src/features/opening/learning/summary-page-service.test.ts apps/web/src/features/opening/learning/summary-response.test.ts apps/web/src/features/opening/learning/read-service.test.ts --silent
Test Files  7 passed (7)
Tests       77 passed (77)

node node_modules/vitest/vitest.mjs run --project contract tests/contract/opening-no-mock.test.ts --silent
Test Files  1 passed (1)
Tests       1 passed (1)

powershell.exe -NoProfile -File .local/opening-e2e/check-service-tests.ps1 --project handler tests/integration/handler/opening-learning-summary-read.test.ts --silent
Test Files  1 passed (1)
Tests       3 passed (3)

powershell.exe -NoProfile -File .local/opening-e2e/check-service-tests.ps1 --project handler tests/integration/handler/opening-learning-read.test.ts --silent
Test Files  1 passed (1)
Tests       2 passed (2)

powershell.exe -NoProfile -File .local/opening-e2e/check-service-tests.ps1 --project handler tests/integration/handler/opening-learning-history.test.ts --silent
Test Files  1 passed (1)
Tests       5 passed (5)

powershell.exe -NoProfile -File .local/opening-e2e/check-service-tests.ps1 --project integration tests/integration/opening-learning-summary-pagination.test.ts --silent
Test Files  1 passed (1)
Tests       3 passed (3)

npm run typecheck -w @aistudy/database
Exit 0

npm run typecheck -w @aistudy/web
Exit 0

node .local/opening-e2e/check-test-types.mjs
Explicit test roots: PASS (5 files plus imported dependencies)

npx eslint apps/web/src/app/api/opening/courses/[id]/learning/route.ts apps/web/src/app/api/opening/courses/[id]/learning/summary/route.ts apps/web/src/features/opening/client/learning-client.ts apps/web/src/features/opening/learning/course-summary-state.ts apps/web/src/features/opening/learning/course-view.tsx apps/web/src/features/opening/learning/summary-page-service.ts tests/contract/opening-no-mock.test.ts tests/integration/handler/opening-learning-read.test.ts tests/integration/handler/opening-learning-history.test.ts tests/integration/handler/opening-learning-summary-read.test.ts
Exit 0

git diff --check
Exit 0
```

The new HTTP regression in `tests/integration/handler/opening-learning-summary-read.test.ts` covers an owned empty page, authentication, foreign-course concealment, malformed query rejection, stable group pagination, a second login session rereading the committed record, and `409` after the semantic snapshot changes. The test initially exposed a fixture error: one session was seeded with two different skill labels, which the learning repository correctly rejected. The fixture was corrected to create one session per skill, and the isolated rerun passed `3/3`; no application validation was weakened.

A parallel web typecheck invocation briefly observed a stale `supportsVision` type while unrelated uncommitted model-catalog edits were being read concurrently. The same web typecheck was rerun alone and passed with exit 0; the L03 files were not changed for that transient result.

## User acceptance and boundaries

Course entry: `/opening/courses/<courseId>`. Requires an authenticated owner, an active course, and the existing learning data. Manual browser checks remain pending: submit an observation in browser/device A, open or refresh the same course in browser/device B, confirm the server summary and empty state are rendered, paginate the course summary, and inspect error/retry states. No agent browser automation, screenshot, real-provider acceptance, production deployment, full release gate, Q03 restore drill, or K01/K02 acceptance was performed.
