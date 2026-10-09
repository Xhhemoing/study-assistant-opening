# K02 accept — Skill-linked evidence, targeted tutoring and retest feedback

**Date:** 2026-10-09 ~17:46 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release`  
**Workspace:** `/workspace/study-assistant-opening`  
**Scope:** Agent accept of **DATA + EXPERIENCE + AI** halves against `docs/superpowers/plans/opening-release/10-media-knowledge.md` § K02.  
**Verdict:** **ACCEPT** overall (Data **ACCEPT**, Experience **ACCEPT**, AI **ACCEPT**; agent-owned)  
**Browser:** **not run** — do not claim browser pass.  
**Commit/push:** **not done** (this accept file only until Phase 2 ledger close).

## Halves

| Half | Owner | Verdict |
|---|---|---|
| Data | migration 0049 + repo + L01 same-tx link + VALIDATION + integration | **ACCEPT** |
| Experience | tutor-actions flags via Data repo; no client self-report; adaptive; no mastery % | **ACCEPT** |
| AI | retest-close-evidence + retest-close job + attempt-service retestId→nodeId+dimension | **ACCEPT** |
| **Overall agent accept** | all three | **ACCEPT** |

## Files reviewed

### Data half

**New**
- `packages/database/src/migrations/0049_opening_skill_evidence.sql` — `opening_skill_evidence` (dimensions recall/explain/procedure/transfer/timed; UNIQUE workspace+observation+node+dimension); rollback `DROP TABLE` only; LearningEvent/observations remain authoritative
- `packages/database/src/schema/opening-skill-evidence.ts`
- `packages/database/src/repositories/opening-skill-evidence.ts` (+ unit test) — `createOpeningSkillEvidenceRepository`: `link` / `listByNode` / `listByObservation` / `flagsForNode`; `linkOpeningSkillEvidenceInTx` for L01 same-tx
- `tests/integration/opening-adaptive-loop.test.ts` — **7** cases

**Changed (data-relevant)**
- `packages/database/src/repositories/opening-learning-observations.ts` — same-tx SkillEvidence when `nodeId`+`dimension` both set; VALIDATION if only one provided
- `packages/contracts/src/opening/knowledge.ts` — `skillEvidenceSchema`; learning ObservationInput optional `nodeId`/`dimension`
- Exports: `packages/database/src/index.ts`, `packages/contracts/src/opening/index.ts`

**VALIDATION (repo + L01)**
- Missing workspace / observation outside scope → NOT_FOUND
- `courseId` mismatch vs observation → VALIDATION
- `nodeId` not in existing course knowledge snapshot → VALIDATION
- Partial skill-link fields on observation → VALIDATION (`nodeId and dimension must be provided together`)
- No snapshot → link allowed (logical node ref until K01 lands)

### Experience half

**Changed**
- `apps/web/src/features/opening/learning/tutor-actions.ts` (+ `tutor-actions.test.ts`) — binds `createOpeningSkillEvidenceRepository` / `flagsForNode`; `forbiddenObservationQueryKeys` rejects client `hasCheckedIndependent` / `hasAssistance` / exposure / retestDue self-report; nodeId path uses server-loaded flags → `recommendTutorAction` adaptive; `assertNoMasteryPercentage`
- Domain adaptive share: `packages/domain/src/opening/tutor-policy-adaptive.ts` + overload in `tutor-policy.ts` (decision order: due → assisted-without-independent → clarify → new independent_variant)

### AI half

**New**
- `packages/domain/src/opening/retest-close-evidence.ts` (+ test **8**) — `shouldAppendRetestEvidence` (independent+correct only); `prepareRetestSkillLink` (retestId required; exact label → nodeId; default dimension `transfer`); `nextTutorKindAfterRetestClose`
- `apps/worker/src/jobs/retest-close.ts` (+ test **4**) — `createRetestCloseHandler`: clear due + Data `link`; skips assisted/unverified, already-linked, no_node

**Changed**
- `apps/web/src/features/opening/learning/attempt-service.ts` (+ `attempt-service.retest-close.test.ts` **1**) — on `retestId`, resolve snapshot + `prepareRetestSkillLink` → pass `nodeId`+`dimension` into L01 `insertObservation` (same-tx Data link)
- Domain export of retest-close-evidence helpers; worker exports `createRetestCloseHandler`

## Plan criteria checklist

| # | Criterion | Half | Result | Notes |
|---|---|---|---|---|
| 1 | Assisted success → `independent_variant` (fail-first style unit) | Exp/AI | **PASS** | Domain tutor-policy + Experience tutor-actions node path |
| 2 | Decision order: due → assisted → clarify → independent context | Exp/AI | **PASS** | `recommendAdaptiveTutorAction` |
| 3 | SkillEvidence dimensions + problem/assistance via observations; no self-report upgrade | Data/Exp | **PASS** | flagsForNode joins eligibility; client query keys forbidden |
| 4 | Reuse L02 retest / T03 tutor / no separate scoring; unassisted retest appends evidence + clears due | AI | **PASS** | retest-close handler + attempt submit enrichment |
| 5 | Integration adaptive loop + cross-skill isolation | Data | **PASS** | **7** integration tests |
| 6 | Migration SkillEvidence projection; LearningEvent v1 compatible; rollback drops table only | Data | **PASS** | 0049 applied in test DB |
| 7 | No mastery % in API/UI actions | Exp | **PASS** | assertNoMasteryPercentage + tests |
| 8 | Manual effect report / causal claims | — | **NOT RUN** | Agent accept is wiring + tests only |

## Tests re-run (actual counts)

```text
# Data unit — skill-evidence (= 4)
node node_modules/vitest/vitest.mjs run --project unit \
  packages/database/src/repositories/opening-skill-evidence.test.ts
→ Test Files  1 passed (1)
→ Tests       4 passed (4)

# Data integration — opening-adaptive-loop (= 7)
OPENING_TEST_DB=1 OPENING_TEST_DATABASE_URL=postgres://aistudy:aistudy@127.0.0.1:5432/aistudy_opening_test \
  node node_modules/vitest/vitest.mjs run --project integration \
  tests/integration/opening-adaptive-loop.test.ts
→ Test Files  1 passed (1)
→ Tests       7 passed (7)
→ Duration    ~3.95s

# Experience unit — tutor-actions + tutor-policy (= 29)
node node_modules/vitest/vitest.mjs run --project unit \
  apps/web/src/features/opening/learning/tutor-actions.test.ts \
  packages/domain/src/opening/tutor-policy.test.ts
→ Tests       19 + 10 = 29 passed

# AI unit — retest-close-evidence 8 + retest-close 4 + attempt-service.retest-close 1 (= 13)
node node_modules/vitest/vitest.mjs run --project unit \
  packages/domain/src/opening/retest-close-evidence.test.ts \
  apps/worker/src/jobs/retest-close.test.ts \
  apps/web/src/features/opening/learning/attempt-service.retest-close.test.ts
→ Tests       13 passed (13)

# Combined unit wave (all K02 files above)
→ Test Files  6 passed (6)
→ Tests       46 passed (46)

# tsc --noEmit
node node_modules/typescript/bin/tsc -p packages/contracts/tsconfig.json --noEmit → exit 0
node node_modules/typescript/bin/tsc -p packages/database/tsconfig.json --noEmit  → exit 0
node node_modules/typescript/bin/tsc -p packages/domain/tsconfig.json --noEmit     → exit 0
node node_modules/typescript/bin/tsc -p apps/worker/tsconfig.json --noEmit        → exit 0
node node_modules/typescript/bin/tsc -p apps/web/tsconfig.json --noEmit           → exit 0
```

DB probe: `pg_isready` OK; `schema_migrations` includes `0049_opening_skill_evidence.sql`; table `opening_skill_evidence` present.

## Not run

- **Browser** — not run.
- Live classroom effect report (independent new-item / delayed accuracy / hint dependence) — human / follow-up; not required for agent wiring accept.
- Production worker queue slot registration for a named `retest-close` job kind — handler is factory-exported; attempt-path same-tx link covers the L02 close projection claimed here.

## Recommendation

**ACCEPT** all three halves. Proceed to Phase 2 ledger close (`k02-skill-evidence.md` + `tasks.json` K02 → verified). Leave C02/K01/DL4 verified; do not touch V01. No commit/push from this accept step alone.
