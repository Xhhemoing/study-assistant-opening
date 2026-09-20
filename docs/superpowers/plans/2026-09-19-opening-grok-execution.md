# Opening Release Grok Execution Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans; use one sequential `xhh-grok/grok-4.6-fast` worker unless a later handoff explicitly allocates disjoint worktrees. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 Grok Bot 按依赖完成 Opening release 的质量修复、学习闭环、规划闭环、真实体验和已批准的邮箱/钉钉、媒体、知识结构与主动辅导能力；每个任务只在对应证据门禁通过后推进状态。

**Architecture:** 保留 Next.js App Router + TypeScript 模块化单体、独立 worker、PostgreSQL、BullMQ/Redis、私有 S3 和现有 contracts/domain/AI/database 分层。Provider 只负责 AI 边界；domain 保持纯函数；所有持久化和权限校验由服务器完成。扩展能力复用现有 source、conversation、candidate、learning、planning 和 privacy 边界，不另造第二套任务、记忆或评分系统。

**Tech Stack:** Node.js 20+, npm workspaces, Next.js, React, TypeScript, PostgreSQL, BullMQ/Redis, S3-compatible storage, Vitest, Playwright, existing parser runtime, FFmpeg/faster-whisper/Docling only after artifact and license checks.

## Global Constraints

- Baseline branch is `feat/opening-release`; baseline commit is `ee455ab`; the worktree is intentionally dirty. Never reset, checkout, clean, or revert another agent's changes.
- All implementation in this execution is written by `xhh-grok/grok-4.6-fast`; the coordinator reviews diffs and reruns gates. Do not claim independent review by an unavailable agent.
- No commit, push, deployment, production migration, production/user database access, paid model call, external school mailbox, DingTalk organization, or live-device claim without explicit authorization.
- Preserve the approved 37-task ledger. Current ledger evidence is historical: `15 verified`, `22 planned`. Do not promote a task merely because code exists or a unit test passes.
- New code files stay at or below 200 lines. Split focused modules before adding unrelated logic to an existing large file.
- Domain functions are pure. SQL and migrations belong to `packages/database`; browser code never owns authoritative facts; AI output is validated before persistence.
- Provider/model calls are disabled by default. Fake adapters may test deterministic failures, but they cannot certify model quality, retention, provider JSON compatibility, or educational effect.
- Every behavior change follows `RED -> root cause -> minimal fix -> same-command GREEN -> type/lint/integration evidence`.
- Every scope and repository query is principal/workspace bound. Never accept owner, workspace, source ownership, recipient, or provider download URL from an untrusted client field.
- DB tests must use the guarded isolated URL and `OPENING_TEST_DB=1`; never run destructive fixtures against a development or user database.
- Preserve existing migration files and numbers. Applied migrations must stay contiguous (migrate.ts enforces `MIGRATION_VERSION_GAP`); no gaps, placeholders, or loader exceptions. Current reservations: M01 `0022` (applied), M02 `0023` (coordinator reallocated 2026-09-20: M02 precedes P02 in execution order), P02 `0024`, C01 `0025`, K01 `0026`, K02 `0027`. Check the actual disk before adding any migration. Existing `0016`-`0022` are not reusable. The coordinator allocates every new migration number; never pick one autonomously.
- UI changes use Tailwind utilities and existing `lucide-react`; provide loading, empty, error, retry, keyboard, mobile and long-text states. Do not display invented progress, fake mastery, fake conversations or fake provider availability.
- Research findings are not implementation evidence. Real model semantics, real provider billing, real IMAP/DingTalk permission, real audio/video quality and real device behavior remain separately labeled.

## Source Of Truth

Read before each slice:

- `AGENTS.md` and the nearest nested `AGENTS.md`.
- `docs/superpowers/plans/2026-09-12-opening-release-implementation.md`.
- `docs/superpowers/plans/opening-release/tasks.json`.
- `docs/superpowers/plans/opening-release/interfaces.md`.
- `docs/superpowers/plans/opening-release/capability-interfaces.md`.
- The slice subplan: `01-foundation.md` through `11-proactive-acceptance.md`.
- `docs/plans/2026-09-18-quality-dual-agent.md`.
- `docs/quality/opening-real-use-audit.md` and `docs/quality/opening-plan-research-backlog.md` when a requirement or evidence boundary is unclear.

Do not overwrite `tasks.json` status/evidence while implementing. The integrator updates status only after the combined-tree gates below are observed.

## Execution Map

| Stage | Tasks | Required predecessor | Main result |
|---|---|---|---|
| 0 | Quality repair Q-R1 | Existing dirty repair | Server history, budget safety, config validation, durable evidence |
| 1 | M01, M02 | T03; then M01 | Candidate memory, privacy epoch, deletion and restore exclusion |
| 2 | L01, L02, P02 | M01; L01; P01/F03 | Learning observations, explainable retests, versioned plans |
| 3 | M03, L03, P03, U02 | M02; L02; P02/I03; I01/I02/U01 | Ephemeral mode, real learning read client, reminders, upload/viewer flow |
| 4 | U03 | M03, L03, P03, U02 | Real saved conversation and learning/planning UI |
| 5 | Q03, Q01, Q02 | P03/M02; U03/Q03; Q01 | Backup/restore, security/recovery suite, browser/mobile and evaluation evidence |
| 6 | C01, V01 | X01 contracts are already verified; C01 needs M02+P02 from earlier stages; V01 needs I02/I03 (verified) | Consent/vault/import lineage, media processing |
| 7 | C02, C03, K01 | C01; X01/C01/I02/T02 | IMAP, authorized DingTalk, source-backed knowledge graph |
| 8 | K02, P04, U04 | K01/L02/T03; C02/C03/K02/P02/M01; expansion predecessors | Skill evidence, action digest, capability UI |
| 9 | Q04 | U04 and Q02 | CAP01-CAP06 acceptance and final release evidence |

The single Grok worker executes stages sequentially in this order. Within a stage, tasks run in the listed order (for example K01 before K02, P04 before U04). The plan validator may report additional ready tasks such as `M01, U02, V01` earlier than their stage; deferring them is an intentional single-worker ordering choice, not an invitation to reorder. Database tests and migrations run serially.

## Stage 0: Quality Repair Q-R1

**Purpose:** Finish the currently active repair before using it as a foundation. This is not a new ledger task and must not be marked as all of T01-T03 or M1 complete.

**Files:**

- Modify: `packages/contracts/src/opening/tutor.ts`, `packages/contracts/src/opening/provider-history.test.ts`.
- Modify: `packages/ai/src/opening/provider.ts`, `packages/ai/src/opening/provider.test.ts`.
- Create/modify: `packages/database/src/repositories/opening-tutor-history.ts`, `opening-tutor-jobs.ts`, `tests/integration/opening-tutor-history.test.ts`.
- Modify: `apps/worker/src/jobs/tutor-turn.ts`, `tutor-turn.test.ts`, `runtime/budgeted-call.ts`, `runtime/budgeted-call.test.ts`.
- Modify: `packages/database/src/repositories/opening-budget.ts`, focused budget/foundation/tutor integration tests.
- Modify: `packages/config/src/opening-model.ts`, `env.ts`, `env.test.ts`, `index.ts`, `.env.example`; update `apps/worker/src/index.ts` only through the same serial handoff.
- Modify: `docs/plans/2026-09-18-quality-dual-agent.md` with observed evidence only.

**Required behavior:**

- Server builds bounded history from the owned conversation; only prior completed whole exchanges enter the provider; current/future/pending/other-workspace turns do not.
- History is at most 40 messages and 12,000 characters, preserves chronological user/assistant order, and invalidates conservatively when any cited source is missing, revoked, or at a different version.
- Provider sends history with `user`/`assistant` roles before the current question and rejects system-role injection or over-limit input.
- Daily reservation counts completed current-day spend and every unresolved reservation, including old unknown outcomes; workspace locking prevents concurrent overspend; request replay with changed payload conflicts.
- Known pre-send failures release; post-send uncertainty, malformed output, missing usage and settlement failure retain capacity. Never convert missing usage to zero charge. Respect the positive amount database constraint.
- Paid model calls remain disabled when cap/key/prices are not explicitly valid. Validate finite, bounded `OPENING_TUTOR_*` and opening-model values before worker startup. Add direct workspace dependencies if imports require them, without upgrading unrelated packages.

**RED/GREEN gates:**

```bash
node node_modules/vitest/vitest.mjs run --project unit packages/contracts/src/opening/provider-history.test.ts packages/ai/src/opening/provider.test.ts apps/worker/src/runtime/budgeted-call.test.ts apps/worker/src/jobs/tutor-turn.test.ts packages/config/src/env.test.ts
OPENING_TEST_DB=1 OPENING_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/aistudy_opening_test node node_modules/vitest/vitest.mjs run --project integration tests/integration/opening-budget.test.ts tests/integration/opening-tutor-history.test.ts tests/integration/opening-tutor-turn.test.ts tests/integration/opening-foundation.test.ts
```

Then run package typechecks for contracts/config/ai/database/worker/web and changed-file lint. Add a real worker -> adapter serialization -> PostgreSQL test with only fetch replaced; no paid call.

## Stage 1: Memory And Privacy

### M01: Candidate, confirmed and temporary memory

**Files:** Follow `04-memory.md`: memory schema/repository, migration `0022_opening_memory_privacy.sql`, pure `packages/domain/src/opening/memory-policy.ts` tests, web service/routes and guarded handler tests. Shared contract changes are made first in `packages/contracts/src/opening/memory.ts` and exports.

**Acceptance:** candidate is never a fact; temporary requires expiry; course scope is enforced; confirm/reject/delete uses expected version and client key; duplicate confirmation is idempotent; rejected proposals are suppressed; no source-less or cross-workspace memory is loaded.

**Commands:**

```bash
node node_modules/vitest/vitest.mjs run --project unit packages/domain/src/opening/memory-policy.test.ts packages/contracts/src/opening/contracts.test.ts
OPENING_TEST_DB=1 OPENING_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/aistudy_opening_test npm run test:handler -- opening-memory
```

### M02: Privacy deletion, epoch and restore exclusion

**Migration allocation (coordinator decision, revised 2026-09-20):** the migration loader enforces contiguous versions, so placeholders are forbidden. M02 takes `0023_opening_memory_privacy_epoch.sql` (already on disk, renamed by the coordinator); P02 shifts to `0024`, C01 to `0025`, K01 to `0026`, K02 to `0027` at their own slices. Do not renumber applied files; downstream tasks use the number stated in their own subplan after the coordinator confirms it.

**Files:** Follow `04-memory.md`: `opening-privacy.ts`, `privacy-guard.ts`, its unit test, `opening-privacy.test.ts`, worker writeback guard and backup adapter boundary. Do not rewrite legacy event guards.

**Acceptance:** delete is transactional, increments privacy epoch, prevents stale worker writes, records content-free exclusions, suppresses re-extraction, and rejects backups that lack required privacy metadata. Cross-workspace, duplicate and delete/writeback race tests are required.

### M03: Listening and no-save mode

**Files:** `packages/ai/src/opening/conversation-policy.ts`, tests, ephemeral service/route and handler tests from `04-memory.md`.

**Acceptance:** listen cannot create task candidates; ephemeral history is bounded and refresh-cleared; response/citations/candidates/private text are not persisted; provider failure creates no saved fallback; no provider zero-retention claim is made.

## Stage 2: Learning And Negotiated Planning

### L01: Learning sessions, exposure and observations

**Files:** Follow `05-learning.md`: inspect existing `0019_opening_learning.sql` before writing any SQL; schema/repository/service/routes and `assistance.ts` tests. Shared contract update precedes consumers.

**Acceptance:** server-known hint/reveal exposure overrides client independence only for the same session; new retest sessions do not inherit exposure; source version and ownership are checked; self-report/model-suggestion/reference-checked/unknown remain distinct; unknown work never becomes formal correct boolean.

### L02: Explainable learning state and retest candidate

**Files:** `packages/domain/src/opening/learning-summary.ts`, `retest-policy.ts` tests, worker candidate job, accept route. Reuse P02 candidate integration only after P02 exists; until then keep accepted retest visible without claiming scheduled execution.

**Acceptance:** empty evidence stays empty, assisted success remains needs_check, independent reference-checked evidence is only observed_independent, stale evidence is ignored, candidates are small and dated heuristics.

### P02: Tasks, drafts and atomic acceptance

**Files:** Follow `06-planning.md`: inspect migration registry and actual disk; P02 uses `0024` (reserved by the coordinator after the M02 contiguous renumbering). Add schema/repository/domain/service/routes/handler tests.

**Acceptance:** hard blocks including sleep are never stolen; ambiguous deadlines remain unconfirmed; candidate consumption is transactional; draft has complete input snapshot/base version; concurrent stale acceptance returns 409; same client key is idempotent and changed payload conflicts.

### P03: Due items and reminder state

**Files:** Follow `06-planning.md`: reminder policy, worker job/channel adapter, route and integration tests.

**Acceptance:** in-app due state is not called push delivery; external channel defaults disabled; sent requires provider receipt; duplicate/restart/reschedule/quiet-hours/unknown outcomes are visible and bounded.

## Stage 3: Experience Primitives

### U02: Upload, progress and source viewer

**Files:** Follow `07-experience.md`: inbox upload client/state/tests/components and `tests/e2e/opening-upload.spec.ts`.

**Acceptance:** begin -> private PUT -> complete is ordered; progress is actual bytes; duplicate complete is safe; failed parsing still permits original viewing; retry does not create a second source; unsupported formats and mobile interruption are explicit.

### L03: Real learning read client

**Files:** `read-service.ts`, course learning route, `learning-client.ts` and tests, `tests/contract/opening-no-mock.test.ts`.

**Acceptance:** 503 remains an error, no demo data is injected, server summary is used, and opening features contain no mock-provider/mock-data imports.

### U03: Real conversation/learning/planning interface

**Files:** Follow `07-experience.md`: typed API client, assistant components, memory panel, course view, today/plan components, action rule test, browser loop.

**Acceptance:** saved mode polls durable jobs and reloads from server; ephemeral mode is separate; duplicate send/cancel/lost response are explicit; plan 409 disables resubmit; memory deletion and learning evidence labels are visible; no raw HTML execution.

## Stage 4: Delivery Gates

### Q03: Build, backup, restore and readiness

**Files:** Follow `08-delivery.md`: backup repository/scripts, Docker profiles, health route, readiness script, docs and guarded backup/privacy test.

**Acceptance:** allowlisted versioned backup includes object hashes, source lineage, privacy epoch/journal and no credentials/sessions; restore into an empty isolated namespace rejects wrong hashes/unknown versions and never resurrects deletion; pending paid jobs restore cancelled; readiness reports configuration honestly.

### Q01: Cross-module security, failure and concurrency

**Files:** `tests/integration/handler/opening-loop.test.ts`, `opening-concurrency.test.ts`, `opening-failure-recovery.test.ts`, `tests/contract/opening-safety-boundaries.test.ts`, plus Q03 backup test integration.

**Acceptance:** full saved flow inspects DB rows/versions; anonymous/cross-owner reads are denied; crash windows, MIME spoof, prompt injection, budget exhaustion, stale accept and delete/writeback races have regressions.

### Q02: Browser, mobile checklist and evaluation evidence

**Files:** Follow `08-delivery.md`: e2e fixture/specs, evaluation cases/evaluator, evidence template.

**Acceptance:** real application APIs/DB are used for final browser flow; only deterministic fault injection uses fake provider; mobile/desktop states, refresh, keyboard, equation overflow, failed parser, memory deletion and plan conflict are covered. Live model/device/audio/handwriting results are separately marked pass, fail or blocked with sample denominator.

## Stage 5: Approved Capability Expansion

### C01: Connection consent, credentials and lineage

The X01 capability contracts are already ledger-verified and the files `connections.ts`, `imports.ts`, `media.ts`, `knowledge.ts`, `proactive.ts` exist under `packages/contracts/src/opening/`. Do not rewrite them; if C01 needs a new field, extend additively and flag it to the coordinator first.

**Files:** Follow `09-connections.md`: connection schema/repository/import repository, migration `0025`, credential vault, import-identity tests, web connection services/routes and guarded handler tests.

**Acceptance:** strict DTOs never expose secrets; import identity includes connection/container/generation/remote ID; AES-GCM nonce/AAD/key rotation boundaries are tested; revoke increments version, deletes credentials, cancels jobs and blocks stale writeback; no arbitrary URL/recipient/scope.

### C02: School-hosted IMAP

**Files:** IMAP client/sync/parser modules and tests, sync job, manual `.eml` route, fixtures/docs, isolated IMAP integration test.

**Acceptance:** use pinned ImapFlow/MailParser after artifact/license check; read-only UID sync, bounded 100-message rounds, streaming limits, cursor advances only after committed source/attachment, UIDVALIDITY reset, retry and duplicate receipt. No real school connection means `blocked`, not verified.

### C03: Authorized DingTalk

**Files:** thin client/policy/tests, sync job, signed event route, integration tests and operations doc.

**Acceptance:** official permission mapping is documented; robot-send does not imply message-read; signature/replay/org/revocation/pagination/rate-limit failures are handled; no authorized organization sample means integration remains blocked.

### V01: Media transcription and alignment

**Files:** TypeScript media validation/processing and tests, parser Python modules/tests, parse job, API routes, handler registration, pinned manifest and fixtures. Follow `10-media-knowledge.md`.

**Acceptance:** FFmpeg argv has no shell interpolation/network input; duration/size/CPU/RAM/timeout limits are enforced; audio transcription and video keyframes are separately represented; corrections create a new source version; unsupported visual coverage is visible; no accuracy claim without authorized samples.

### K01 and K02: Knowledge and targeted tutoring

**Files:** K01 contracts/domain graph tests, schema/repository/migration `0026`, build job, service/routes/integration; K02 tutor policy/repository/migration `0027`, action API and adaptive-loop integration. Follow `10-media-knowledge.md`.

**Acceptance:** knowledge nodes/edges are source-backed and editable; supported requires current evidence; self-prerequisite/cycles/foreign references are rejected; corrections and source revocation create needs_check rather than silently deleting history. K02 separates assisted, independent, delayed and transfer evidence; it reuses L02/T03/P02 and does not create a second scoring system.

### P04 and U04: Action digest and capability UI

**Files:** action digest pure rule/tests, extraction job/service/route, connection settings, knowledge evidence, media reader, action surface, settings route and real-API e2e fixture/spec.

**Acceptance:** rejected/superseded candidates do not reappear; duplicate/revised sources dedupe by stable semantic identity; at most three primary actions; uncertain dates remain confirmed-needed; UI exposes authorization, lineage, parser limitations and action evidence without fake readiness.

### Q04: Expanded acceptance

**Files:** capability privacy integration/e2e cases/evidence plus Q03 backup/restore/compose modifications.

**Acceptance:** CAP01-CAP06 tests distinguish offline synthetic evidence from real school/org/device evidence; revoked imports, attachments, transcripts and knowledge references cannot resurrect from old backup; connection restore is disabled until reauthorization; all blocked external permissions are explicit.

## Verification Matrix

Run focused gates after every task, then the combined gates at stage boundaries.

```bash
node scripts/validate-opening-plan.mjs
node --test tests/tooling/*.test.mjs
npm run lint
npm run typecheck
npm test -- --project unit --project contract
npm test -- --project '@aistudy/spike-*'
OPENING_TEST_DB=1 OPENING_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/aistudy_opening_test npm run test:integration
OPENING_TEST_DB=1 OPENING_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/aistudy_opening_test npm run test:handler
npm run test:browser
npm run build
node scripts/verify-ci.mjs
```

Do not run unrestricted `npm test` as a gate: it repeats the integration and handler database suites that the explicit project commands above already cover. Run the browser gate only for stages that contain browser tasks (3, 4, 5, 8) or when services are already running; otherwise report it as skipped, not failed.

For commands longer than the shell timeout, run with `.tmp/quality-repair/<gate>.log` and `.tmp/quality-repair/<gate>.exit`, poll to process termination, and report the exact exit code. Integration, handler and browser DB fixtures run serially. Build, browser, live provider, real device, real mailbox, DingTalk and model-quality results must remain separate evidence categories.

## Handoff Record

At the end of each task, Grok must report:

1. exact task ID and changed paths;
2. failing test command and observed failure;
3. root cause;
4. minimal implementation;
5. same-command passing output;
6. type/lint/integration/browser results;
7. migration and dependency changes, if any;
8. unverified limits, blocked permissions and rollback steps.

The coordinator reviews the diff, reruns the affected gate on the combined worktree, then updates task status/evidence. No status is promoted from planned to verified from a prose claim.

## Plan Self-Review

- All 22 currently planned ledger IDs appear in the execution map stages 1-9: `M01,M02,M03,L01,L02,L03,P02,P03,U02,U03,Q01,Q02,Q03,C01,C02,C03,V01,K01,K02,P04,U04,Q04`. Verified X01 is referenced as a landed contract, not restated as pending work.
- Stage 0 is explicitly a prerequisite repair and does not silently alter the ledger.
- Migration numbers are guarded; no task is instructed to rewrite `0016`-`0021`.
- External permissions, live-provider semantics, model quality and devices have explicit blocked states.
- No placeholder task, automatic release claim, paid-call instruction or production database instruction is present.

## Observed evidence (M01)

- Timestamp: 2026-09-19 ~23:59 CST (UTC+8), host `xhh`, branch `feat/opening-release`, HEAD `ee455ab` (dirty intentional; no commit/push).
- Tip: M01 memory lifecycle — `isMemoryEligible` + context/review assembly; migration `0022_opening_memory_privacy.sql` (filesystem registry via migrate.ts); repo propose/confirm-once/reject-suppress + delete stub; decision API 401/403/404/409/idempotent; cards expose why/when; additive `createdAt`/`updatedAt` on MemoryItem.
- RED: memory-policy stub always-true → 3 fail. Handler written before GREEN.
- GREEN unit: `node node_modules/vitest/vitest.mjs run --project unit packages/domain/src/opening/memory-policy.test.ts packages/contracts/src/opening/contracts.test.ts` → exit 0, 2 files / 21 tests.
- GREEN handler: `OPENING_TEST_DB=1 OPENING_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/aistudy_opening_test node node_modules/vitest/vitest.mjs run --project handler tests/integration/handler/opening-memory.test.ts` → exit 0, 1 file / 6 tests.
- Other: typecheck domain/contracts/database/web exit 0; eslint tip files exit 0; `node scripts/validate-opening-plan.mjs` PASS (Ready still lists M01 until integrator promotes); tooling 22 pass.
- Limits: no paid model; M02 delete/privacy epoch not implemented; domain `src/index.ts` export append required outside strict allowlist note.

## Observed evidence — M02 (Coder, xhh)

Date: 2026-09-20 Asia/Shanghai.

Migration: `0023_opening_memory_privacy_epoch.sql` (coordinator reallocated from 0024 because the loader requires contiguous versions; P02 shifts to 0024; renamed and re-pointed by the coordinator before verification).

GREEN on xhh (Coder, before coordinator renaming): privacy-guard unit 1 passed; opening-privacy integration 4 passed; database/worker/web typecheck exit 0; changed-file eslint exit 0.

Coordinator resolution (2026-09-20 01:19–01:22 CST):
- Loader enforces contiguous versions (`MIGRATION_VERSION_GAP`); placeholders/exceptions rejected. Renamed `0024_opening_memory_privacy_epoch.sql` → `0023_...` and re-pointed `opening-privacy.test.ts` (sql0023 variable) instead. Reservations shifted: P02→0024, C01→0025, K01→0026, K02→0027 across the execution plan, master plan and subplans (06-planning/09-connections/10-media-knowledge). Validator PASS 37 tasks; tooling 22 pass.
- Repaired the polluted isolated-test registry: Coder's blocked 0024 attempt had persisted `0023_opening_planning.sql`/`0024_opening_memory_privacy_epoch.sql` rows in `schema_migrations` of `aistudy_opening_test`; deleted both orphan rows via the guarded URL, then `applyMigrations` re-applied `0023_opening_memory_privacy_epoch.sql` cleanly.
- Re-verified on combined tree: opening-privacy 4/4; guard unit pass; M01 handler regression 6/6; combined integration (privacy+budget+history+tutor-turn+foundation) 25/25 exit 0; worker/database typecheck exit 0.
- Coordinator wire decision: the production `privacy` wiring in `apps/worker/src/index.ts`/`createOpeningJobRepository` was NOT authorized inside the M02 allowlist and remained outstanding. It was subsequently authorized and delivered inside the L01+M02-wire dispatch (see below).

## Observed evidence — L01 + M02-wire (Coder, xhh; coordinator-authorized carryover)

Date: 2026-09-20, branch `feat/opening-release`, HEAD `ee455ab` (dirty intentional; no commit/push). Coder reported unit 25 / learning-integration 4 / tsc / eslint pass.

- M02 wire: `opening-jobs.ts` exposes workspace privacy epoch reads; `tutor-turn.ts` checks `assertCurrentEpoch(jobEpoch, currentEpoch)` after the budgeted call and before `completeTurn`, and honors privacy-excluded source IDs before retrieval; `apps/worker/src/index.ts` wires `privacy` + `learning` deps. Race regression exists in `opening-privacy.test.ts` (epoch bump fails stale guard).
- L01: contract requires `sessionId` (schema rejects absent session); `opening-learning.test.ts` covers session-exposure overriding client independent, new-session non-inheritance, verdictSource kinds, clientKey replay idempotency, cross-workspace NOT_FOUND. Domain `resolveAssistance` unit green. `tutor-turn.ts` records delivered help (`delivered: true`) only for hint/explain modes bound to an explicit `learningSessionId`.
- Coordinator rerun on combined tree (09:14–09:15 CST): L01 integration 4/4; assistance unit green; tutor-turn regression 5/5; M01 handler regression 6/6; worker/contracts/web typecheck exit 0; changed-file eslint exit 0; plan validator PASS.
- Limits: no migration used (0019 pre-existing, as allocated); L02/L03 not started; M02 disk state confirmed consistent (0022 applied, 0023 privacy epoch present via earlier coordinator rename + registry repair); bot's prior M02 BLOCKED note is stale — all three blockers were resolved by the coordinator before this dispatch.

## Observed evidence — L02 (Coder, xhh)

Date: 2026-09-20 09:21–09:22 CST. Coder reported unit 3 files/11 tests, tsc domain/database/worker/web, eslint pass; migration none (0024 untouched).

- Implementation: `learning-summary.ts` (empty→empty; needs_check unless every evidence is independent+correct+reference_checked; due retest→needs_review; evidence IDs/sample/lastObservedAt surfaced); `retest-policy.ts` (2-day editable heuristic, batch limit default 1, skips observed_independent and missing source refs/prompt — no invented stems); worker `retest-candidate.ts` (scope-bound, payload validation, proposals persisted via `opening_jobs` kind=retest, no calendar scheduling); `opening-retests.ts` accept is idempotent by accepted-flag with clientKey+result marker `scheduled: false`; retest service/route reuse the repository without duplicating rules.
- Coordinator rerun on combined tree (09:31 CST): domain+worker unit 11/11 exit 0; L01+privacy integration regression 8/8 exit 0; worker/domain/contracts/web typecheck exit 0; changed-file eslint exit 0; validator PASS. File sizes 66/66/75/89 lines (all <200).
- Limits: needs_check cannot be upgraded by model confidence (requires reference_checked independent evidence) — asserted by unit tests; accept stores due entry without claiming scheduling; prompts are labeled heuristic; L03 not started. Prior M02 BLOCKED residue in Coder notes remains stale: M02 was closed by the coordinator after the 0023 rename + registry repair.

## Observed evidence — P02 (Coder, xhh)

Date: 2026-09-20 09:37–09:44 CST. Coder reported day-planner 15/15, handler opening-plans 6/6, tsc, eslint, validator PASS; migration `0024_opening_planning.sql`.

- Implementation: migration 0024 (tasks/plan drafts/acceptances/hard blocks/timetable sessions tables); repository with transactional candidate consumption, baseVersion+inputSnapshot+hardBlocksFingerprint draft model, clientKey idempotency with payload-conflict detection, stale accept 409, fingerprint invalidation on newly inserted hard blocks; plan service + routes (tasks/timetable/today/plans/accept). Day-planner pure rules (P01 heritage) untouched and still 15/15.
- Coordinator rerun on combined tree (10:09 CST): handler opening-plans 6/6 (including stale-409/idempotent-replay/changed-payload-conflict/sleep-protection/fingerprint-invalidation cases); day-planner 15/15; L01+M02 integration regression green; database/web typecheck exit 0; changed-file eslint exit 0; validator PASS.
- Ledger: 0024 slot consumed as allocated; disk now 0020–0024 contiguous. P03 remains the only Stage-2/3 planning dependency for U03; L03/M03/U02 remain open before U03.

GREEN on xhh:
- `node node_modules/vitest/vitest.mjs run --project unit apps/worker/src/runtime/privacy-guard.test.ts` → 1 passed, exit 0
- `OPENING_TEST_DB=1 OPENING_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/aistudy_opening_test node node_modules/vitest/vitest.mjs run --project integration tests/integration/opening-privacy.test.ts` → 4 passed, exit 0
- `npm run typecheck -w @aistudy/database` / `@aistudy/worker` / `@aistudy/web` → exit 0
- eslint on M02 changed files → exit 0

BLOCKED / Coord:
- M01 handler regression: coordinator resolved by renaming the M02 file to `0023` and re-pointing `opening-privacy.test.ts`; no placeholder, no loader exception.
- Validator: coordinator shifted reservations (P02→0024, C01→0025, K01→0026, K02→0027) in the execution plan; validator PASS re-verified below.
- Production wire incomplete within allowlist: `apps/worker/src/index.ts` does not pass `privacy` into `createTutorTurnHandler`; `createOpeningJobRepository` has no `workspacePrivacyEpoch` — optional hooks no-op until Coord authorizes those paths.

## Observed evidence — L01+M02-wire (Coder, xhh)

Date: 2026-09-20 Asia/Shanghai. No new migration.

GREEN on xhh:
- unit: `node node_modules/vitest/vitest.mjs run --project unit apps/worker/src/runtime/run-job.test.ts apps/worker/src/jobs/tutor-turn.test.ts packages/domain/src/opening/assistance.test.ts` → 25 passed, exit 0
- int: `OPENING_TEST_DB=1 OPENING_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/aistudy_opening_test node node_modules/vitest/vitest.mjs run --project integration tests/integration/opening-learning.test.ts` → 4 passed, exit 0
- typecheck: database/contracts/domain exit 0; worker via `npx tsc -p tsconfig.json --noEmit` exit 0 (npm run-heavy.sh blocked: bash missing on PATH this shell)
- eslint on changed wire/L01 files exit 0

Inventory: ObservationInput already required sessionId; resolveAssistance + 0019 schema/repo/routes present — filled gaps only (clientKey replay, tutor learningSessionId exposure, handler/repo integration tests, prod privacy/learning wire).

Residual (not this card PASS): M02 contiguous 0023 + validate-opening-plan C01/0024 collision.

