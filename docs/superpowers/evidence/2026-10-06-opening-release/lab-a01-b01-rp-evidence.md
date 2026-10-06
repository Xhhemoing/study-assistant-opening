# LAB-A01 / LAB-B01 implemented + RP1/RP2 verified — 2026-10-06

- Working tree on `feat/opening-release` @ parent `6a58787`; commits: LAB-A01 strategy registry slice, LAB-B01 server-derived recommendations slice (local, push/hosted CI pending user authorization).
- Design basis: `docs/quality/2026-10-06-lab-duo-design-final-for-heidi-review.md` §4 (A01/B01 scope, B02 intentionally not implemented). Heidi sign-off for the A01/B01 implementation start is assumed from the in-flight working tree; the review decision itself is still owned by the user.

## LAB-A01 · strategy registry + require_page

- New `packages/domain/src/opening/strategy-registry.ts` (ADR-014 in-memory registry, single v1 `require_page` template; schema rejects `prefer_page`/`general_ok` and mastery keys), exported from the domain barrel.
- `TurnInput.strategyTemplateId` optional in contracts; persisted on `opening_turns` via additive migration `0044_opening_turn_strategy.sql` (rollback comment included); worker injects the template suffix after `instructionWithMemories(makeTutorInstruction(mode))` without changing `makeTutorInstruction` itself; unknown ids resolve explicitly to the default template.
- `require_page` enforced after `resolveCitations` and before any writeback: empty citations or page mismatch raise `PageCitationError`; the turn fails (`page_not_in_sources`), `completeTurn` is never called, no revealed exposure is written.

## LAB-B01 · server-derived tutor-action recommendations

- `GET /api/opening/courses/[id]/tutor-actions` no longer accepts client self-reported `assistedSuccess`/`retestDue`/`sessionExposures`/`problemRef`; unknown query keys are rejected with 400.
- Observations are server-derived: course ownership (404 cross-workspace), session ownership + course binding, delivered exposures aggregated to the highest level (revealed is never masked by a later hint), due retests from the real L02 `listDue` semantics (accepted due activity per skill).
- Recommendations remain pure reads over the frozen K02a baseline order (`retestDue` first; B02 micro-question branch stays disabled).

## Verification actually run (2026-10-06, local)

- unit `--project unit`: strategy-registry + tutor-policy + web tutor-actions + worker tutor-turn = 4 files / 56 tests passed; re-run after lint fix = 46 passed (2 files).
- handler (isolated DB guard `OPENING_TEST_DB=1`, loopback `aistudy_opening_test` @5433): `tests/integration/handler/opening-tutor-actions.test.ts` = 7/7 passed (after fixture priority fix: due retest moved to a different skill so revealed-exposure cases stay isolated; delayed_retest case now also asserts the baseline priority retestDue > revealed).
- migration `0044` recorded `verified` in `schema_migrations` on the isolated test DB.
- RP1/RP2 focused re-verification: unit `opening-tutor-history` + `opening-tutor-terminal` = 13 passed; integration `opening-tutor-history` + `opening-tutor-turn` = 24 passed (2 files).
- typecheck: domain/database/contracts packages + web + worker `tsc --noEmit` all exit 0. Targeted ESLint on all changed files exit 0 (one unused-import error found and fixed in `tutor-actions.test.ts`).

## Regression found and fixed during verification

- `opening-tutor-turn.test.ts` "replays the same client key…" fixture used a page-backed turn (currentPage 1) with an empty citation list from the fake provider. Under the require_page policy this is a policy-noncompliant response: the first run now refuses (`page_not_in_sources`), the job fails and the replay retries. Root-caused as stale fixture, not a product bug; the fixture now cites the real chunk (`actualChunkId`, page 1) returned by `replaceChunks`. Same file re-run: 19/19 passed.

## Boundaries / not verified

- Browser acceptance (strategy selector UI = LAB-U01) not implemented and not run; per repo convention owned by the user.
- Push, hosted CI and bound-SHA evidence pending user authorization; no tasks.json promotion for A01/B01 (not part of the 43-task ledger), RP1/RP2 promoted with this note as evidence.
- Real-model behavior of the injected suffix is untested (fixture provider only), consistent with prior K02a evidence.
