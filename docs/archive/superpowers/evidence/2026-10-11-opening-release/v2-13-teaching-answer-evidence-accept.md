# V2-13 Teaching & answer evidence — Implement ACCEPT

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Reviewer:** AIstudy Integrator (executor / Grok Bot) — **≠** implementer (AIstudy Data)  
**Stage:** Independent Implement ACCEPT (Data half; no Experience UI)  
**Branch:** `feat/opening-release`  
**Baseline tip claimed:** `e85a73bff8df93de254e68c5286721860c6723e1` (`e85a73b`)  
**Tip HEAD at Accept (dirty; no commit):** `94549528873488d2a784324f7e0806e02599e9e9` (`9454952`)  
**Verdict:** **ACCEPT**

## Authority / inputs

| Doc | Role |
|---|---|
| `docs/superpowers/plans/opening-release/review-test-gates.md` | Gates |
| `docs/superpowers/plans/ai-led-learning-v2/v2-13-teaching-answer-evidence-plan.md` | Plan |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-13-teaching-answer-evidence-plan-accept.md` | Plan ACCEPT |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-13-migration-number-assigned.md` | Migr **0057** |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-13-teaching-answer-evidence-implement.md` | Data Implement claim |
| Style: `v2-12-teaching-commands-accept.md` | Accept sample |

## Tip / dirty tree

```text
$ git rev-parse HEAD
94549528873488d2a784324f7e0806e02599e9e9

$ git branch --show-current
feat/opening-release

$ git log --oneline -3
9454952 fix(ai): keep teaching-compiler browser-safe (no node:crypto)
e85a73b fix(domain): keep teaching-commands browser-safe (no node:crypto)
9a508a7 feat(opening): V2-12 teaching command controls UI

$ git merge-base --is-ancestor e85a73b HEAD && echo ancestor
ancestor

$ test -z "$OPENING_TEST_DATABASE_URL" && echo unset
unset
```

### Commits vs uncommitted (V2-13)

| Layer | What | V2-13? |
|---|---|---|
| Tip commit `9454952` | `packages/ai/src/opening/teaching-compiler.ts` only (`node:crypto` browser-safe) | **No** — unrelated AI tip; flagged separately |
| Uncommitted dirty product | contracts/domain/database help+eligibility+retest; migr **0057**; worker tutor-turn thin kind; attempt-service explicit dimension; new teaching-exposure (+tests) | **Yes** — V2-13 Data Implement |
| Untracked docs/evidence | plan / understand / migr-assign / implement / this accept | Docs only |
| Other untracked (`rp5-gha-…`, `p0-assistant-list-…`) | Left untouched | **Not** V2-13 |

**No** stash / reset / commit / push / hermes on this Accept. Worked dirty tree as-is.

## Migration 0057

| Check | Result |
|---|---|
| Filename | `packages/database/src/migrations/0057_opening_help_exposure_kind.sql` — **matches assign** |
| `kind TEXT` + NOT NULL + CHECK (`instruction`\|`hint`\|`solution`) | **Present** |
| Backfill `SET kind = 'hint'` only | **Present** (unit asserts SET values = `["hint"]` only) |
| nullable `activity_id` + FK + partial index | **Present** |
| nullable `item_version_id` + FK + partial index | **Present** |
| No parallel mastery `CREATE TABLE` | **Confirmed** (T15/T18 unit) |
| Live migrate apply | **`not_run`** (`OPENING_TEST_DATABASE_URL` unset) |

## Stronger review (PM frozen / Plan hard rules)

| Lock | Diff finding |
|---|---|
| DDL 0057 kind + backfill hint; nullable activity_id / item_version_id | SQL + drizzle schema + backup column inventory + help INSERT/map — **aligned** |
| instruction ≠ item help | Filtered in `evidence-eligibility-timing` (`kind=instruction` continue), `resolveAssistanceFromExposures` / `exposuresAffectingItemAssistance`, and `listDeliveredExposures` (`kind <> 'instruction'`) — **aligned** |
| correct/incorrect/unverified; unknown ≡ unverified (no rename) | `mapPmUnknownOutcome()` → `"unverified"`; wire enum unchanged — **aligned** |
| Remove default transfer | `RETEST_CLOSE_DEFAULT_DIMENSION` **deleted** from domain + exports; `prepareRetestSkillLink` returns null when `!input.dimension` — **aligned** |
| Omit dimension → no SkillEvidence | Domain + worker retest-close test — **aligned** |
| Completing activity ≠ mastery; no parallel mastery | Domain `assertActivityCompleteDoesNotUpgradeMastery`; skill-evidence docs forbid complete→link; migr forbids mastery table — **aligned** (call-site wiring soft gap below) |
| needs_check preserved | Contracts/summary still carry `needs_check` / `unverifiedCount` — **aligned** |
| Nest existing models; no Experience UI | Help table extended; teaching chrome / workspace **untouched** — **aligned** |
| tutor-turn thin kind pass-through | `classifyTutorHelpKind(...)` on helpExposure only; no orchestration rewrite — **aligned** |
| attempt-service explicit dimension | `dimension: "transfer"` at retest close call site — **aligned** |
| Tests not loosened | No `it.skip` / `.only` in claimed V2-13 test files |

### Soft gap (non-blocking)

- `assertActivityCompleteDoesNotUpgradeMastery` is exported + unit-covered (T10) but **not yet invoked** from a teaching-activity status transition path. No product path was found that links SkillEvidence on activity complete (repo docs forbid it). Treat as **soft_gap** — does not force REJECT; call-site hook can land when activity-complete write path is next touched.

## Independent re-runs (Integrator)

### Vitest (exact Data claim set)

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
   Duration  ~8.83s
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

## not_run (honest)

| Item | Reason |
|---|---|
| Live DB migrate/apply of **0057** | `OPENING_TEST_DATABASE_URL` unset; no DB |
| DB-backed `insertOpeningDeliveredHelp` idempotent conflict against real Postgres | needs DB |
| Full eligibility rebuild against migrated help rows | needs DB |
| End-to-end activity `status=completed` → no SkillEvidence row | needs DB + activity write path (domain guard unit-covered) |
| Experience UI / browser E2E for kind display | OOS this Data slice (Plan) |

## Soft gaps / blockers

| Kind | Note |
|---|---|
| soft_gap | Activity-complete mastery guard not yet called from status transition (unit + no wrong link API) |
| soft_gap | Worker still often passes `problemId: null` on help; domain filters protect instruction pollution (Data deferred) |
| soft_gap | Live migrate 0057 deferred to ops when DB available |
| **blockers** | **None** |

## Forbidden actions (this Accept)

- **No** push / hermes / commit / stash / reset  
- **No** product behavior edits to force green  
- **No** `tasks.json` → verified (left alone; Integrator verified flip is a separate step if required)  
- **No** Experience UI required or added  
- **No** live ALTER / migrate

## Verdict

**ACCEPT** Data Implement of V2-13 Teaching & answer evidence at dirty tip `9454952` (V2-13 product uncommitted; tip commit `9454952` is unrelated AI teaching-compiler fix only).

- Required runnable checks re-run green: vitest **15 files / 170 tests** exit 0; tsc contracts/domain/database/worker/web all exit 0.  
- Migr **0057** present and matches assign note.  
- PM hard rules hold under stronger review; soft gaps / DB paths honestly **`not_run`**.  
- Experience UI remains a separate slice.
