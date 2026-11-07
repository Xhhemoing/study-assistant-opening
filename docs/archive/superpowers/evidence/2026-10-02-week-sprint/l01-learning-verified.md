# L01 Learning Sessions, Observations and Delivered Help Verification

Status: implementation and non-browser verification complete in this workspace. Browser acceptance remains pending user review. This is not release approval or evidence of learning effectiveness or mastery.

## Implemented behavior

- Authenticated learning sessions bind an owned, active course and admitted uploaded source material. Observations require `sessionId` and enforce session/course/skill/source ownership.
- Server-owned attempts capture problem/item identity, source versions, and start/submission times. Unknown historical identity or incomplete reference checking remains unknown.
- Raw `assistance` and reported outcomes remain original facts. The newer S2 design in `2026-09-27-learning-continuity-implementation.md` separates those facts from server-derived evidence eligibility; it does not rewrite a declaration to `hinted`. Delivered pre-submission help sets `eligibility.independentAttempt` to `no` with `help_before_submission`, despite a client declaration of `independent`.
- `hint` and `explain` help is recorded only with a retrievable completed assistant turn, atomically in the tutor completion transaction. `listen` and `think_together` do not attach learning sessions or produce help exposures. Failed or unknown-outcome provider calls produce no delivered help.
- Unrelated problems/new sessions do not automatically inherit help. A new attempt on the same known problem retains prior answer exposure separately; help after the captured answer does not retroactively become pre-submission help.
- `self_report`, `model_suggestion`, `reference_checked`, and `unknown` stay distinct. A reference label alone does not grant verified correctness. Unknown work is not projected into a fake boolean graded event.
- Observation corrections use the separate append-only revision API. Exact submission replays reuse the saved row; changed intent conflicts.

## Fix and TDD evidence

The delivery repository previously returned the new input when an exposure ID already existed, without comparing the saved association or level. It also accepted another attempt in the same session for a completed assistant turn.

- Added `tests/integration/opening-learning-help.test.ts`. Initial real PostgreSQL run: 6 tests, 5 failed / 1 passed. Failures showed an inferred problem ID lost on replay, changed level/turn/attempt accepted for the same ID, and a new exposure assigned to the wrong attempt.
- `opening-learning-help.ts` now checks the completed turn's null-safe attempt association, resolves the canonical problem from the owned attempt, compares exposure ID replay against session/turn/level/attempt/problem, and maps both first-write and replay responses from stored facts. Replays/conflicts leave facts and committed history revision unchanged.
- Read-only review identified a nullable canonicalization edge: `??` treated a known problem-free attempt as missing identity. The added problem-free-attempt regression failed before the fix. The repository now preserves an attempt's known `null` problem and rejects a supplied problem ID.
- Expanded the actual handler/worker delivery path to test both help modes, redelivery, new-session independence, definitive provider failure, timeout/unknown outcome, and non-learning conversation modes. Provider outputs/failures are controlled fixtures; no external model was called.
- An initial new handler assertion incorrectly expected `learningSessionId` in the turns HTTP response. The existing API returns only `jobId` and `turnId`; the assertion was removed and the actual persisted turn/session and exposure rows are checked instead.

## Final verification

All database checks used the repository-managed isolated PostgreSQL at `127.0.0.1:15432/aistudy_opening_test` via `.local/opening-e2e/check-service-tests.ps1` and the `scripts/opening-test-db.mjs` guard. No production or default application database was used. Final observed runs on 2026-10-03:

```text
powershell.exe -NoProfile -File .local/opening-e2e/check-service-tests.ps1 --project integration tests/integration/opening-learning.test.ts tests/integration/opening-learning-attempts.test.ts tests/integration/opening-learning-help.test.ts tests/integration/opening-tutor-turn.test.ts tests/integration/opening-observation-revisions.test.ts --silent
Test Files  5 passed (5)
Tests       50 passed (50)

powershell.exe -NoProfile -File .local/opening-e2e/check-service-tests.ps1 --project handler tests/integration/handler/opening-learning-attempts.test.ts tests/integration/handler/opening-observations.test.ts --silent
Test Files  2 passed (2)
Tests       11 passed (11)

node node_modules/vitest/vitest.mjs run --project unit packages/domain/src/opening/assistance.test.ts packages/domain/src/opening/evidence-eligibility-assistance.test.ts packages/database/src/repositories/opening-learning.test.ts packages/database/src/repositories/opening-tutor-terminal.test.ts apps/worker/src/jobs/tutor-turn.test.ts apps/web/src/features/opening/learning/observation-service.test.ts --silent
Test Files  6 passed (6)
Tests       74 passed (74)

npm run typecheck -w @aistudy/database
Exit 0

node node_modules/eslint/bin/eslint.js packages/database/src/repositories/opening-learning-help.ts tests/integration/opening-learning-help.test.ts tests/integration/handler/opening-learning-attempts.test.ts
Exit 0
```

- Additional strict compilation of the two new/changed test roots and their imported dependencies passed using TypeScript's compiler API with `tsconfig.base.json`: `Explicit test roots: PASS (2 files plus imported dependencies)`. An earlier invocation used the root project-reference configuration and fell back to obsolete compiler defaults; that failed invocation is not application verification. The corrected strict configuration passed without source workarounds.
- The isolated migration registry reports `0019_opening_learning.sql`, `0028_opening_learning_attempts.sql`, `0029_opening_observation_revisions.sql`, and `0038_opening_learning_eligibility.sql` as `verified`. No new migration was needed.
- Read-only child review was advisory, not independently executed acceptance. The nullable finding was confirmed by the failing real database regression before correction.
- `graphify update .` completed AST-only. SQL extraction remains absent because the optional SQL parser is not installed; source SQL and actual PostgreSQL execution, not graph output, provide the database evidence.

## User acceptance and boundaries

Entry: `/opening/courses/<courseId>` (existing learning view in the course detail). Requires an authenticated owner, a course with parsed uploaded material, the existing learning migrations, and a working worker/provider configuration for help.

1. Start an attempt and record an unverified or self-reported answer. Expect a saved observation with explicit unknown verification, not a mastery claim.
2. Start another attempt, request hint/explain, wait for successful delivery, then declare independence and submit. Expect help-aware qualification, not independent credit.
3. Start a fresh session with a different problem. Expect no automatic transfer of the prior problem's help; this still does not establish verified correctness.
4. Refresh and inspect observation history. Expect the saved record and provenance to remain visible. A failed help request must not appear as delivered assistance.

These are pending manual browser checks, not reported passes. No agent browser automation, production migration, deployment, full repository gate, real-provider acceptance, or Q03 recovery drill was performed. L02 summary/retest acceptance, L03 cross-device client acceptance, and K01/K02 learning-loop acceptance remain separate tasks.
