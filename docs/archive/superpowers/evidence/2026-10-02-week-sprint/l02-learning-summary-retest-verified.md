# L02 Explainable Learning State and Retest Verification

Status: implementation and non-browser verification complete in this workspace. Browser acceptance remains pending user review. This is not release approval, a calibrated retention model, or evidence of mastery.

## Implemented behavior

- `summarizeObservations` groups evidence by workspace/course/requirement/skill and uses the shared server-derived eligibility evaluator. It preserves raw observations, evidence IDs, source labels, representative eligibility details, unknown counts, historical incorrect counts, and source-version applicability.
- Empty evidence remains an empty state. Self-report, model-only, unverified work, missing attempt identity, incomplete reference checking, help-assisted work, changed sources, unavailable sources, and privacy-excluded sources remain `needs_check` or otherwise non-qualifying. A reference-checked independent correct attempt can show `observed_independent`, explicitly as limited observed evidence rather than mastery.
- Due retest identity is scoped by course, skill, and requirement. Accepted/due retests change the displayed state to `needs_review` without changing the underlying evidence qualification.
- Retest proposals use the editable two-day UTC heuristic by default, cap the batch at one by default, skip already observed-independent evidence, skip missing prompts/source references, and never invent a problem stem or accept source IDs outside captured evidence.
- The Worker retest handler reads the same course evidence and preferences as the course read path, carries evidence observation/root identities, filters unavailable/privacy-excluded sources, checks requirement identity, honors disabled retest suggestions, and persists proposals through the privacy-epoch-aware repository.
- Retest persistence validates current owned evidence/source references, avoids active duplicate activities and unchanged terminal evidence cycles, and accepts only task candidates into the existing P02 task bridge. Accepted entries are explicitly not calendar-scheduled by this slice.
- The course learning view exposes status, next action, evidence counts, source labels, applicability, and eligibility reasons from the server response. It does not manufacture a goal or mastery state when evidence is absent.

## Verification

All database checks used the repository-managed isolated PostgreSQL at `127.0.0.1:15432/aistudy_opening_test` through `.local/opening-e2e/check-service-tests.ps1`. No production/default database or external model was used. Final observed runs on 2026-10-03:

```text
node node_modules/vitest/vitest.mjs run --project unit packages/domain/src/opening/learning-summary.test.ts packages/domain/src/opening/learning-summary-progress.test.ts packages/domain/src/opening/learning-summary-aggregate.test.ts packages/domain/src/opening/retest-policy.test.ts apps/worker/src/jobs/retest-candidate.test.ts apps/web/src/features/opening/learning/read-service.test.ts apps/web/src/features/opening/learning/summary-page-service.test.ts --silent
Test Files  7 passed (7)
Tests       79 passed (79)

powershell.exe -NoProfile -File .local/opening-e2e/check-service-tests.ps1 --project integration tests/integration/opening-learning-consumers.test.ts tests/integration/opening-learning-consumer-races.test.ts tests/integration/opening-learning-summary-races.test.ts tests/integration/opening-learning-summary-projection.test.ts tests/integration/opening-learning-summary-performance.test.ts tests/integration/opening-learning-summary-pagination.test.ts tests/integration/opening-learning-preferences-consumers.test.ts --silent
Test Files  6 passed, 1 skipped (7)
Tests       63 passed, 1 skipped (64)

powershell.exe -NoProfile -File .local/opening-e2e/check-service-tests.ps1 --project handler tests/integration/handler/opening-learning-read.test.ts tests/integration/handler/opening-retest-accept.test.ts --silent
Test Files  2 passed (2)
Tests       5 passed (5)

npm run typecheck -w @aistudy/domain
Exit 0

npm run typecheck -w @aistudy/database
Exit 0

npm run typecheck -w @aistudy/worker
Exit 0

npm run typecheck -w @aistudy/web
Exit 0

node node_modules/eslint/bin/eslint.js packages/domain/src/opening/learning-summary.ts packages/domain/src/opening/retest-policy.ts apps/worker/src/jobs/retest-candidate.ts apps/web/src/features/opening/learning/read-service.ts apps/web/src/features/opening/learning/retest-service.ts
Exit 0
```

The integration set was first started in parallel with another handler process against the same destructive isolated database; that produced a deadlock and cross-test row-count failures. Root cause was test interference from concurrent `TRUNCATE`, not an application assertion. The same integration and handler commands were rerun serially and passed; no application fallback or retry was added.

## User acceptance and boundaries

Course entry: `/opening/courses/<courseId>`. Requires authenticated course ownership, uploaded parsed source material, and the existing learning data. Manual browser checks remain pending: inspect empty state, record self-report/reference-checked evidence, view qualification reasons, generate/accept a retest, refresh the course, and confirm no status is presented as mastery. No agent browser automation, real-provider acceptance, production deployment, full release gate, Q03 restore drill, or L03 cross-device acceptance was performed. L03 and K01/K02 remain separate tasks.
