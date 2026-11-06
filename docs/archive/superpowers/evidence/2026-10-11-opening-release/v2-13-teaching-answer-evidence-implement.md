# V2-13 Teaching & answer evidence — Implement Evidence

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Data implementer (executor / Grok Bot)  
**Branch:** `feat/opening-release`  
**Baseline tip (assignment):** `e85a73bff8df93de254e68c5286721860c6723e1` (`e85a73b`)  
**Tip HEAD at Implement write (dirty; no commit):** `94549528873488d2a784324f7e0806e02599e9e9` (`9454952`) — ancestor includes `e85a73b`; one later unrelated commit `fix(ai): keep teaching-compiler browser-safe (no node:crypto)` landed on tip while this slice worked; **not** V2-13 product  
**Status:** **implemented, awaiting Integrator Implement ACCEPT** — do **not** self-ACCEPT; `tasks.json` not marked verified  
**Hard rules held:** No push / hermes / stash / reset / commit · No Experience UI · Migration **0057 only** · Exclusive Data tree

## Authority followed

- Plan ACCEPT: `docs/superpowers/evidence/2026-10-11-opening-release/v2-13-teaching-answer-evidence-plan-accept.md`
- Migration assign: `docs/superpowers/evidence/2026-10-11-opening-release/v2-13-migration-number-assigned.md` → **0057**
- Plan: `docs/superpowers/plans/ai-led-learning-v2/v2-13-teaching-answer-evidence-plan.md`
- Understand: `docs/superpowers/plans/ai-led-learning-v2/v2-13-teaching-answer-evidence-understand.md`
- Gates: `docs/superpowers/plans/opening-release/review-test-gates.md`
- PM locks: kind CHECK + backfill hint; nullable activity_id + item_version_id; unknown≡unverified; remove transfer default; omit dimension → no SkillEvidence; activity complete ≠ mastery; nest existing model; course v1 unchanged; instruction ≠ item assistance; no history backfill as independent/correct/transfer

## Diff scope

### New

| Path | Role |
|---|---|
| `packages/database/src/migrations/0057_opening_help_exposure_kind.sql` | DDL: `kind` NOT NULL CHECK + backfill `'hint'`; nullable `activity_id`; nullable `item_version_id` + indexes/FKs |
| `packages/database/src/migrations/0057_opening_help_exposure_kind.test.ts` | T15/T18 SQL assertions (hint-only SET; no parallel mastery table) |
| `packages/domain/src/opening/teaching-exposure.ts` | classifyTutorHelpKind; instruction filter; independence/read/activity-complete guards; PM unknown→unverified alias |
| `packages/domain/src/opening/teaching-exposure.test.ts` | T2/T10 + classifier/filter/guard units |
| `packages/database/src/repositories/opening-learning-help.test.ts` | T12 surface: INSERT columns include kind/activity_id/item_version_id |

### Updated

| Path | Change |
|---|---|
| `packages/contracts/src/opening/learning.ts` (+ `index.ts`, `contracts.test.ts`) | `helpExposureKindSchema`; `helpExposureSchema.kind` required; optional activityId/itemVersionId; additive `activityScopedObservationInputSchema` |
| `packages/domain/src/opening/retest-close-evidence.ts` (+ test) | **Removed** `RETEST_CLOSE_DEFAULT_DIMENSION`; omit dimension → `null` |
| `packages/domain/src/opening/evidence-eligibility-types.ts` | optional `kind` on `EvidenceHelpExposure` |
| `packages/domain/src/opening/evidence-eligibility-timing.ts` (+ assistance tests) | skip `kind=instruction` in item assistance / prior-answer loop |
| `packages/domain/src/opening/assistance.ts` (+ test) | `resolveAssistanceFromExposures` filters instruction |
| `packages/domain/src/index.ts` | export teaching-exposure; drop RETEST_CLOSE_DEFAULT export |
| `packages/database/src/repositories/opening-learning-help.ts` | persist kind + activity_id + item_version_id; conflict checks kind; legacy read→hint |
| `packages/database/src/repositories/opening-learning.ts` | `listDeliveredExposures` excludes `kind='instruction'` |
| `packages/database/src/repositories/opening-learning-evidence-context.ts` | SELECT/map `kind` (default hint) into eligibility helpHistory |
| `packages/database/src/schema/opening-learning.ts` | drizzle columns for kind/activityId/itemVersionId |
| `packages/database/src/repositories/opening-backup-apply.ts` | backup column inventory +kind/activity_id/item_version_id |
| `packages/database/src/repositories/opening-skill-evidence.ts` | docs only: no activity-complete → link API |
| `packages/database/src/repositories/opening-tutor-jobs.ts` (+ terminal test) | helpExposure type requires `kind` |
| `apps/web/.../attempt-service.ts` | explicit `dimension: "transfer"` at retest close call site (no domain default) |
| `apps/worker/src/jobs/tutor-turn.ts` (+ test) | **thin field pass:** `kind: classifyTutorHelpKind(...)` |
| `apps/worker/src/jobs/retest-close.test.ts` | explicit dimension on link path; omit-dimension → no link |

### Explicitly not touched

- **Experience UI** / teaching chrome
- V2-06 citation / claim orchestration (beyond one-line kind on helpExposure)
- V2-12 skip semantics
- Invented migrations other than **0057**
- push / commit / hermes / stash / reset / self-ACCEPT / `tasks.json` verified flip
- Unrelated untracked evidence (`rp5-gha-…`, `p0-assistant-list-…`) left as-is

## Behavior landed

| Rule | Behavior |
|---|---|
| ExposureKind | `instruction` \| `hint` \| `solution` required on write; historical/missing read → `hint` |
| Instruction ≠ item help | Filtered in eligibility timing, `resolveAssistanceFromExposures`, and `listDeliveredExposures` |
| Hint/solution | Still elevate via existing level/eligibility paths when `delivered=true` |
| Unknown | Wire stays `unverified` (`mapPmUnknownOutcome`) |
| Transfer default | Removed from domain; omit dimension → no SkillEvidence; callers pass explicit dimension |
| Activity complete | `assertActivityCompleteDoesNotUpgradeMastery` forbids SkillEvidence / outcome rewrite / force independent |
| Course APIs | `observationInputSchema.courseId` still required; activity adapter additive only |
| History backfill | 0057 SET kind=`'hint'` only |
| Tutor-turn | Thin kind mapping via domain helper; no orchestration rewrite |

## Tests T1–T18

| ID | Status | Where / note |
|---|---|---|
| T1 | **pass** | `contracts.test.ts` — kind required; unknown kind reject |
| T2 | **pass** | `teaching-exposure.test.ts` classifyTutorHelpKind |
| T3 | **pass** | eligibility-assistance + assistance — instruction ignored |
| T4 | **pass** | eligibility-assistance — prior solution kind → prior_answer_exposure |
| T5 | **pass** | existing assistance / contracts no-problemId; summary needs_check path via learning-summary-progress |
| T6 | **pass** | contracts outcome enum + learning-summary-progress historicalIncorrect |
| T7 | **pass** | retest-close-evidence — omit dimension → null |
| T8 | **pass** | retest-close-evidence — explicit transfer links |
| T9 | **pass** | retest-close-evidence honesty + worker omit-dimension |
| T10 | **pass** | teaching-exposure assertActivityCompleteDoesNotUpgradeMastery |
| T11 | **pass** | teaching-activity.test — courseId still required on observationInputSchema |
| T12 | **pass** (unit surface) | opening-learning-help.test INSERT columns; live DB insert **not_run** |
| T13 | **pass** | learning-summary-progress / fixtures keep self_report vs model_suggestion distinct |
| T14 | **pass** | evidence-eligibility-version.test (existing version_* reasons) |
| T15 | **pass** | 0057 migration test — hint-only SET; no mastery table |
| T16 | **pass** | tutor-turn.test — explain without attempt → kind instruction |
| T17 | **pass** | opening-skill-evidence.test (flagsForNode honesty unchanged) |
| T18 | **pass** | 0057 migration test — no parallel mastery CREATE TABLE |

### not_run (honest)

| Item | Reason |
|---|---|
| Live DB migrate/apply of **0057** | `OPENING_TEST_DATABASE_URL` unset; no DB → **not_run** |
| DB-backed insertOpeningDeliveredHelp idempotent conflict against real Postgres | needs OPENING_TEST_DATABASE_URL |
| Full eligibility rebuild against migrated help rows | needs DB |
| End-to-end activity status=completed → no SkillEvidence row | needs DB + activity write path (domain guard unit-covered) |

## Commands run + results

### Tip

```text
$ git rev-parse HEAD
94549528873488d2a784324f7e0806e02599e9e9

$ git merge-base --is-ancestor e85a73b HEAD && echo ancestor
ancestor

$ test -z "$OPENING_TEST_DATABASE_URL" && echo unset
unset
```

### Unit (focused)

```text
$ PATH="./node_modules/.bin:$PATH" bash scripts/run-heavy.sh vitest run \
    packages/contracts/src/opening/contracts.test.ts \
    packages/contracts/src/opening/teaching-activity.test.ts \
    packages/domain/src/opening/teaching-exposure.test.ts \
    packages/domain/src/opening/retest-close-evidence.test.ts \
    packages/domain/src/opening/assistance.test.ts \
    packages/domain/src/opening/evidence-eligibility-assistance.test.ts \
    packages/domain/src/opening/evidence-eligibility-version.test.ts \
    packages/domain/src/opening/learning-summary-progress.test.ts \
    packages/database/src/migrations/0057_opening_help_exposure_kind.test.ts \
    packages/database/src/repositories/opening-learning-help.test.ts \
    packages/database/src/repositories/opening-tutor-terminal.test.ts \
    packages/database/src/repositories/opening-skill-evidence.test.ts \
    apps/web/src/features/opening/learning/attempt-service.retest-close.test.ts \
    apps/worker/src/jobs/tutor-turn.test.ts \
    apps/worker/src/jobs/retest-close.test.ts

 Test Files  15 passed (15)
      Tests  170 passed (170)
   Duration  ~8.5s
exit 0
```

### Typecheck

```text
$ PATH="./node_modules/.bin:$PATH" bash scripts/run-heavy.sh tsc -p packages/contracts/tsconfig.json --noEmit
exit 0
$ PATH="./node_modules/.bin:$PATH" bash scripts/run-heavy.sh tsc -p packages/domain/tsconfig.json --noEmit
exit 0
$ PATH="./node_modules/.bin:$PATH" bash scripts/run-heavy.sh tsc -p packages/database/tsconfig.json --noEmit
exit 0
$ PATH="./node_modules/.bin:$PATH" bash scripts/run-heavy.sh tsc -p apps/worker/tsconfig.json --noEmit
exit 0
$ PATH="./node_modules/.bin:$PATH" bash scripts/run-heavy.sh tsc -p apps/web/tsconfig.json --noEmit
exit 0
```

## Deferred handoff (non-blocking)

- **Worker orchestration / AI:** tutor-turn only got the thin `kind` field pass via `classifyTutorHelpKind`. Binding real `problemId` on item help when known remains a worker/AI improvement (today still often `problemId: null`); domain helper + eligibility filters already protect against instruction pollution.
- **Experience UI:** display kind / needs_check copy — OOS this slice.
- **Live migrate 0057:** Integrator/ops apply when DB available; Implement did not ALTER live DB.

## Blockers

**None blocking Integrator Implement ACCEPT.** Unit/typecheck green; DB-backed cases honestly **not_run**.

## Readiness

Ready for Integrator **Implement ACCEPT**. This evidence does **not** self-ACCEPT, does not flip `tasks.json`, and does not commit/push.
