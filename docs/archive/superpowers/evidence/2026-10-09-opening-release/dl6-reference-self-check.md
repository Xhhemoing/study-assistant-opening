# DL6 Trustworthy practice verdict with learner reference self-check — agent-owned checks accepted

Verifier: AIstudy Integrator (not the implementer). Workspace: `/workspace/study-assistant-opening`, branch `feat/opening-release`. Uncommitted.

## Diff vs `14-loop-closure.md` § DL6

**Data half**
- `GET /api/opening/attempts/[id]` (`apps/web/src/app/api/opening/attempts/[id]/route.ts` + `attempt-service.ts`): returns `deliveredAssistance` from session exposures; submit floors assistance via `resolveAssistance` (submitted value cannot go below delivered).
- `opening-observation-revisions.ts`: replace carrying `referenceCheck` requires unchanged `answer` (else `VALIDATION`); sets `verdictSource` to `reference_checked` and binds session reference source. Repo maps `VALIDATION` → HTTP **400** (not the plan’s 422).
- `opening-learning-evidence-context.ts`: same-problem prior reference check treated as revealed for subsequent attempts (eligibility context, no new table).
- Retest reconcile: revision path keeps calling `reconcileOpeningRetestEvidence`; integration locks that activity `result` tracks the post-revision conclusion.

**UI half** (detail in [`dl6-ui-accept.md`](./dl6-ui-accept.md))
- Two-step self-compare: step 1 `submitAttempt` (`self_report`); step 2 `ReferenceCheckStep` → `reviseObservation(buildSelfCompareRevision(...))` with reason `"对照参考核对"`, answer read-only; hidden when no `referenceSourceId`. Unclear skips revision.
- Help preselect raise-only from `getAttempt` / `deliveredAssistance`; skill-label reuse + empty-stem retest hint; DL3 `retestId` preserved via `withRetestSubmit`.
- No mastery/稳固 status claims on touched UI (disclaimer copy only). UI does not depend on 422.

## Verification (agent-owned, Integrator re-run 2026-10-09)

- `node node_modules/vitest/vitest.mjs run --project unit apps/web/src/features/opening/learning/` — 16 files, **158** passed.
- `node node_modules/vitest/vitest.mjs run --project unit packages/domain/src/opening/` — 30 files, **376** passed.
- `OPENING_TEST_DB=1` `OPENING_TEST_DATABASE_URL=postgres://aistudy:aistudy@127.0.0.1:5432/aistudy_opening_test` `vitest --project handler tests/integration/handler/opening-reference-self-check.test.ts` — **4** passed.
- Same env, `vitest --project handler tests/integration/handler/opening-learning-attempts.test.ts` — **10** passed (plan verification command pair with reference-self-check).
- Same env, `vitest --project integration tests/integration/opening-reference-self-check-retest.test.ts` — **2** passed.
- Same env, `vitest --project integration tests/integration/opening-observation-revision-eligibility.test.ts` — **5** passed.
- `node node_modules/typescript/bin/tsc -p apps/web/tsconfig.json --noEmit` — exit 0.
- `node node_modules/typescript/bin/tsc -p packages/database/tsconfig.json --noEmit` — exit 0.
- `node node_modules/typescript/bin/tsc -p packages/domain/tsconfig.json --noEmit` — exit 0 (optional).

Postgres `127.0.0.1:5432` / `aistudy_opening_test` was up; handler + integration green.

## Not run

- Browser walk for Paula (two-step self-compare, help floor, skill labels). Plan/`AGENTS.md` leave browser to the user; same follow-up pattern as DL5/DL2. UI-half detail remains in `dl6-ui-accept.md`.

## Ledger

- `tasks.json` DL6 → `verified` with this evidence path. No commit. DL7 untouched.
