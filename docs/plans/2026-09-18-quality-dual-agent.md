# Quality repair and two-agent development plan

Status: current repair implemented; local verification recorded below. Baseline: ee455ab. No commit, push or deployment.

## Current repair slice

Existing task-level verification missed transport and persistence boundaries. Keep the approved 37-task product scope; repair these foundations before claiming material-grounded tutoring.

| Lane | Exclusive files | Behavior and checks |
|---|---|---|
| A: tutor transport | `packages/ai/src/opening/provider.ts`, `provider.test.ts`; `apps/worker/src/jobs/tutor-turn.ts`, `tutor-turn.test.ts`; `packages/database/src/repositories/opening-tutor-jobs.ts`; `tests/integration/opening-tutor-turn.test.ts` | Material reaches the real HTTP adapter; structured citations/candidates validate; citations survive persistence. First failing boundary tests, then implementation and same tests. |
| B: retrieval | `packages/ai/src/opening/context.ts`, `context.test.ts`; `packages/database/src/repositories/opening-source-chunks.ts`; `tests/integration/opening-retrieval.test.ts` | Chinese sentence retrieves relevant material; current source versions exclude stale chunks; deterministic preference and budget behavior preserved. |
| Integrator | `scripts/validate-opening-plan.mjs`, `tests/tooling/opening-plan.test.mjs`, `.github/workflows/ci.yml`, opening plans, `README.md`, this plan | Reject planned migration-number collisions; renumber only future migrations; avoid repeated CI suites; publish accurate ownership, status and remaining gates. |

Verification commands:

```bash
node --test tests/tooling/*.test.mjs
node scripts/validate-opening-plan.mjs
bash scripts/run-heavy.sh node node_modules/vitest/vitest.mjs run --project unit --project contract
npm run typecheck -w @aistudy/ai
npm run typecheck -w @aistudy/database
# Isolated test services and OPENING_TEST_DB=1 required:
node node_modules/vitest/vitest.mjs run --project integration tests/integration/opening-tutor-turn.test.ts tests/integration/opening-retrieval.test.ts
```

## Working agreement for two developers/agents

1. One integrator owns the task ledger, shared contracts, package exports, lockfile, CI and migration allocation. Two implementation lanes use separate worktrees at the same recorded baseline. Never share an index or edit the same file concurrently.
2. Each handoff names allowed paths, interface assumptions, failing acceptance, test command and unresolved risks. An agent that needs another lane's file reports the dependency; the integrator applies the shared change once.
3. Prepare worktree dependencies before dispatch. Never run destructive database fixtures concurrently against the same database; the integrator serializes DB gates or allocates separate guarded test databases.
4. Agent output is a patch plus RED/GREEN evidence, not a completion claim. Integrator reviews the patch, applies it, and reruns affected checks on the combined tree. No staging, commit or push by a worker.
5. A connection/tool failure is reported and setup repaired before retry. A passing mock-provider test does not certify the real HTTP adapter, real model quality or production release.
6. Final review checks boundary behavior, negative paths, file ownership and evidence. Record exact observed results and limitations; never promote a whole task from a partial slice.

## Second repair slice: active

Direct implementation continues while the agent budget is unavailable; no retry of paid delegation. Shared files are edited serially.

- Contracts first: `packages/contracts/src/opening/tutor.ts` adds optional, bounded role/text history; new `provider-history.test.ts` verifies limits and disallows system-role injection.
- History lane: new `packages/database/src/repositories/opening-tutor-history.ts`, wired through `opening-tutor-jobs.ts`; `apps/worker/src/jobs/tutor-turn.ts` loads only prior completed exchanges in the owned conversation. Exclude revoked/missing/stale cited sources; conservative invalidation clears history rather than leaking derived text. At most 40 messages / 12,000 characters, whole exchanges, before the current turn. Provider transports these roles before the new question. Verify `tests/integration/opening-tutor-history.test.ts`, provider and worker unit tests, and the real-adapter durable path.
- Budget lane: `opening-budget.ts` validates explicit daily cap (default zero), locks the workspace during reservation, counts today's completed spend and all unresolved reservations, rejects conflicting replay and protects terminal states. No migration required. Update budget/foundation/tutor integration fixtures with explicit test caps.
- Runtime/config: `packages/config/src/opening-model.ts`, `env.ts`, `index.ts`, `.env.example`, `apps/worker/src/index.ts`; reject invalid pricing/configuration, derive conservative per-request reservation from serialized input plus output limit. `budgeted-call.ts` keeps unknown/malformed/missing-usage/settlement-failure costs reserved rather than releasing them. Verify config and budget-call tests before implementation.
- Commands: focused Vitest unit files; isolated PostgreSQL integration project; contracts/config/AI/database/worker/web type checks; changed-file lint; broad unit/contract suite with log and exit capture. Database checks run serially. Final handoff records failures, fixes, rechecks and unmeasured real-provider limits.

## Subsequent work packages

| Order | Lane A | Lane B | Integration gate |
|---|---|---|---|
| Next | Server-built bounded conversation history, including revocation filtering | Daily budget: completed + reserved + unknown spend, validated pricing, missing-usage estimate | Real adapter request tests; multi-connection budget tests; no paid call required |
| Then | U02/thin-chat upload, polling and failure recovery | M01/M02 scoped memory and deletion protocol | Browser flow with real APIs; privacy deletion tests before memory enablement |
| Then | L01/L02 evidence and delayed retests | P02 pure planning and V01 independent media adapters | Preserve retest-to-task and privacy dependencies; serialize migrations |
| Expansion | C01/C02/C03 consent and authorized ingestion | K01/K02 fixtures, extraction and learning rules | Contract-first parallel work; final integration waits for required consent/lineage |

External permissions, real model semantics, mobile device behavior and restore drills remain explicit acceptance gates. No estimate of learning benefit or release readiness follows from local tests. Existing approved scope is unchanged.

## Current verification and handoff

- RED: provider/context checks produced 8 expected failures; isolated PostgreSQL tests produced 2 failures (citations empty, stale source returned). Migration validator then exposed three obsolete/colliding plan references.
- Cause: adapter ignored chunks and replaced structured fields with empty arrays; completeTurn omitted citations; multi-source SQL omitted current-version filtering; Chinese queries were whitespace-only; migration reservations were not compared with disk.
- Fix: transport material and chunk IDs, validate JSON content, persist citations, filter current versions, normalize CJK matching and precompute ranking/length, validate/renumber future migration reservations. Initial CJK implementation overweighted overlapping grams; normalized weights restored the mixed-language regression.
- GREEN: focused unit 3 files / 28 tests; isolated PostgreSQL 2 files / 8 tests; tooling 22 tests; plan structure PASS (37 tasks). Broad unit/contract: 148 passed files, 1 skipped; 731 passed tests, 12 skipped, 1 todo. Full isolated integration project: 27 files / 137 tests passed (118.94s). AI/database/worker/web/e2e type checks and changed-file ESLint passed. CI contract: 4 tests passed.
- Integration fixture replaces only fetch for the main success path; worker, provider serialization/parsing and PostgreSQL persistence remain real. No paid model call occurred.
- Delegation attempts hit a connection failure, missing dependency setup, then HTTP402 agent-budget exhaustion. Tests were recovered/reviewed from isolated worktrees; main session completed implementation. Do not claim two successful implementation agents or independent review. Worktrees remain at `../study-assistant-opening-agent-a` and `../study-assistant-opening-agent-b` with test drafts; their dependency junctions point to the main install and are suitable only while dependencies remain unchanged.
- First broad command exceeded the tool's 60-second output deadline and left a process alive. Stopped the orphan and reran with log/exit files. Broad unit/contract completed in 93.64s. For future long gates, capture logs and check process termination before restarting.
- Graph refresh completed; SQL coverage still excludes 22 files because `tree_sitter_sql` is unavailable. Generated graph output is not part of the patch.
- Remaining acceptance: server history, daily spend enforcement and missing-usage accounting, production build, browser/device checks, provider JSON-mode compatibility and semantic quality. Keep real-model enablement gated by budget authorization and validation.

## Risks and rollback

Provider structured JSON is an intentional wire-contract tightening; malformed/plain output must fail visibly rather than fabricate citations. Verify supported provider behavior before live enablement. This slice should require no database migration: citations already have storage. Future migration renumbering edits plans only, never applied SQL. Rollback is reverting the code/config patch; preserve stored data.

## Observed evidence (Q-R1 / Stage 0)

- Timestamp: 2026-09-19 22:06–22:08 CST (UTC+8), host `xhh`, branch `feat/opening-release`, HEAD `ee455ab` (dirty intentional; no commit/push).
- Tip: replace bare `Number(process.env.OPENING_TUTOR_*)` in `apps/worker/src/index.ts` with `loadOpeningTutorConfig()` (finite positive int Zod); export from `@aistudy/config`; cover in `env.test.ts`; document in `.env.example`. Strengthen `tests/integration/opening-tutor-turn.test.ts` so a prior completed exchange appears in the real provider HTTP `messages` body (fetch-only mock).
- RED: `node node_modules/vitest/vitest.mjs run --project unit packages/config/src/env.test.ts` → 2 failed (`loadOpeningTutorConfig` missing). Integration history assertion failed once on wrong message index, then fixed.
- GREEN unit: `node node_modules/vitest/vitest.mjs run --project unit packages/contracts/src/opening/provider-history.test.ts packages/ai/src/opening/provider.test.ts apps/worker/src/runtime/budgeted-call.test.ts apps/worker/src/jobs/tutor-turn.test.ts packages/config/src/env.test.ts` → exit 0, 5 files / 43 tests.
- GREEN integration: `OPENING_TEST_DB=1 OPENING_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/aistudy_opening_test node node_modules/vitest/vitest.mjs run --project integration tests/integration/opening-budget.test.ts tests/integration/opening-tutor-history.test.ts tests/integration/opening-tutor-turn.test.ts tests/integration/opening-foundation.test.ts` → exit 0, 4 files / 21 tests.
- Other gates: `npm run typecheck -w @aistudy/config` exit 0; `npm run typecheck -w @aistudy/worker` exit 0; eslint on changed files exit 0.
- Integrator verification (2026-09-19 23:29–23:33 CST): reran on combined tree — focused unit 5 files / 43 tests exit 0; guarded integration 4 files / 21 tests exit 0; contracts/config/ai/database/worker/web typecheck exit 0; changed-file eslint exit 0; plan validator PASS; `git diff --check` clean after fixing a trailing blank line in `.env.example`.
- Integrator completion of allocated-but-missing work: declared missing direct workspace dependencies `@aistudy/config` and `@aistudy/database` in `apps/worker/package.json` and refreshed `package-lock.json` (no version changes); verified worker tsc and focused unit tests after the fix.

## Observed evidence (M01 / Stage 1)

- Timestamp: 2026-09-19 23:54–23:59 CST, host `xhh`, branch `feat/opening-release`, HEAD `ee455ab` (dirty intentional; no commit/push). Reviewer `xhh` claims independent rerun; coordinator independently verified on the combined tree below.
- Implementation: `packages/domain/src/opening/memory-policy.ts` (isMemoryEligible/forContext/forReview/cardMeta); `0022_opening_memory_privacy.sql` (kind check, temporary-requires-expires check, text<=4000, workspace FK, indexes); `opening-memory.ts` repository (propose candidate/temporary, rejected-equivalent suppression, transactional confirm/reject with expectedVersion+clientKey idempotency, delete stub delegated to M02); `memory.ts` contract adds createdAt/updatedAt only; memory service/routes (401 anonymous, 403 model/worker caller header, 404 cross-workspace, 409 stale); handler tests cover anonymous/model-caller/idempotent-confirm/stale/cross-workspace/reject-suppression.
- GREEN (coordinator rerun on combined tree, 2026-09-20 00:21–00:22): domain+contracts unit 21 tests exit 0; guarded handler `opening-memory.test.ts` 6 tests exit 0 with OPENING_TEST_DB=1; typecheck contracts/domain/database/web exit 0; changed-file eslint exit 0; plan validator PASS 37 tasks; migration registry auto-discovers SQL by directory scan, no manual registration needed for 0022.
- Integrator fixes: removed a trailing blank line at EOF in `packages/domain/src/index.ts` flagged by `git diff --check`.
- Deviations accepted: `x-opening-caller` model/worker rejection is defense-in-depth beyond the session principal; `packages/database/src/index.ts` and `packages/domain/src/index.ts` export additions were necessary and inside the spirit of the allocated export wiring; memory delete is an explicit M02 stub, not implemented early.
- Limits: candidate proposals are not yet wired from tutor worker output (M01 scope is lifecycle + decision API only, per 04-memory.md); cross-workspace list filtering relies on workspace binding plus courseId filter; M02 privacy epoch/deletion remains blocking before any sensitive long-term memory enablement.
- Limits: no paid model call; `packages/config/src/opening-model.ts` remains untracked vs `ee455ab` (pre-existing dirty + this tip). Stage 1+ not started.
