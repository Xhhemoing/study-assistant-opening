# P04 Experience half accept — action-digest (domain/web slice)

**Date:** 2026-10-09 ~18:01 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release`  
**Workspace:** `/workspace/study-assistant-opening`  
**Scope:** Integrator accept of **Experience half only** against `docs/superpowers/plans/opening-release/11-proactive-acceptance.md` § P04 — digest domain, action-service, route, Today card, revision adapters.  
**Prior AI half:** ACCEPTed in `p04-ai-extract-study-actions-accept.md` (extract-study-actions + migration 0051). Experience consumes those candidates; AI half not re-litigated.  
**Verdict:** **ACCEPT** (Experience half; agent-owned)  
**P04 verified:** **not marked** — integration waiting Data persist overlay; browser not run.  
**Browser:** **not run** — do not claim browser pass.  
**tasks.json:** **not edited**.  
**Commit/push:** **not done**.

## Files reviewed

**Create (matched plan Create / claimed)**
- `packages/domain/src/opening/action-digest.ts` (+ `action-digest.test.ts`) — `buildActionDigest`, `resolveDedupeGroup`, `applySourceRevision`, `blockerToDigestCandidate`, `deltaTaskIdsForRevision`, mastery assert
- `apps/web/src/features/opening/planning/action-service.ts` (+ `action-service.test.ts`) — `createOpeningActionService`, `createExtractJobCandidateSource` (reads succeeded `extract-study-actions` job results / 0051 kind), `createInMemoryActionCandidateStore` accept/reject overlay, `applyDecisionOverlay`
- `apps/web/src/app/api/opening/action-digest/route.ts` — `GET` / `POST` digest + decide (overlay only)
- `apps/web/src/features/opening/planning/action-digest-card.tsx` (+ `action-digest-card.test.ts`) — Today surface helpers + card
- `apps/web/src/features/opening/planning/action-revision-adapters.ts` — T03/P02 additive adapters; `proposeDeltaPlan` via plan-service

**Modify (wiring, not silent confirmation change)**
- `apps/web/src/features/opening/planning/today-view.tsx` — `ActionDigestCard` above `DailyDraftCard` (P04a); no separate planning entry
- `apps/web/src/features/opening/client/api.ts` — `getActionDigest` / `decideActionDigest`
- `apps/web/src/features/opening/planning/plan-service.ts` — additive `proposeDeltaPlan` (delta taskIds only; propose/accept/reject full-day path unchanged)

**Present but not executed this accept**
- `tests/integration/opening-action-digest.test.ts` — stub/`it.todo` pending Data durable overlay (`OPENING_TEST_DB`); **not run**

## Plan criteria matched (Experience-relevant)

| # | Criterion (from § P04) | Result | Notes |
|---|---|---|---|
| 1 | Reject fixture: rejected suggestion not re-prompted | **PASS** | Exact plan fixture in `action-digest.test.ts`; also overlay reject in `action-service.test.ts` |
| 2 | Dedupe by revision/semantic key; unclear cross-source stay separate | **PASS** | Same `dedupeKey` merges `sourceIds`; different keys stay two confirmation items |
| 3 | Source revision supersedes prior pending; accepted schedule forces confirmation | **PASS** | `applySourceRevision` + service revise + delta-only replan |
| 4 | Primary ≤ 3; pendingConfirmationCount not truncated with primary | **PASS** | Cap + full confirmation count unit |
| 5 | K02 learning blockers map into digest candidates | **PASS** | `blockerToDigestCandidate` + service blocker source |
| 6 | action-service + `GET`/`POST` `/api/opening/action-digest` | **PASS** | Reads 0051 extract job candidates + in-memory decide overlay; never auto-creates tasks/plans |
| 7 | Card on Today above P04a draft; no separate planner entry | **PASS** | `today-view.tsx`: `ActionDigestCard` then `DailyDraftCard` |
| 8 | No silent change to old API confirmation meaning | **PASS** | Decide is overlay-only; `proposeDeltaPlan` / adapters additive; T03/P02 accept/reject contracts not rewritten |
| 9 | Consumes AI extract candidates (0051 jobs) | **PASS** | `createExtractJobCandidateSource` + service test via `candidatesFromImportChunks` / extracted source |

**Out of scope / not claimed for this half (gaps below, not ACCEPT blockers for Experience unit slice):**
- Integration `opening-action-digest` (waiting Data)
- Durable accept/reject persistence
- Live `listAuthorizedImportChunks` (AI stub still `[]`)
- Browser / U04 surface QA

## Tests re-run (actual)

```text
node node_modules/vitest/vitest.mjs run --project unit \
  packages/domain/src/opening/action-digest.test.ts \
  apps/web/src/features/opening/planning/action-service.test.ts \
  apps/web/src/features/opening/planning/action-digest-card.test.ts
# → Test Files  3 passed (3)
# → Tests  20 passed (20)
# Breakdown: action-digest 11 + action-service 7 + action-digest-card 2 = 20
# Matches claimed unit 20
```

**tsc (optional, run):**
- `npx tsc -p packages/domain --noEmit` → exit 0
- `npx tsc -p apps/web --noEmit` → exit 0

**Not run:**
- `npm run test:integration -- opening-action-digest` (waiting Data persist overlay; file is todo stub)
- Browser / e2e

## Known gaps (ACCEPT half; P04 not verified)

1. **Integration not run** — `tests/integration/opening-action-digest.test.ts` skipped/todo until Data durable decisions overlay / repo.
2. **In-memory overlay not durable** — route/module process memory; accept/reject lost across restarts; explicit until Data lands a decisions table (no migration invented here).
3. **Data `listAuthorizedImportChunks` still AI stub** — `apps/worker/src/index.ts` returns `[]`; Experience can read succeeded job results when jobs have data, but live chunk projection remains stub (noted from prior AI accept; not re-litigated).
4. **Browser not run** — do not claim browser pass.
5. **P04 not verified** — full P04 remains open until durable overlay + integration (+ later U04/browser as applicable).
6. **tasks.json not edited**; **no commit/push**.

## Verdict

**ACCEPT** — Experience action-digest half meets § P04 Experience-relevant reject/dedupe/revision/3-cap/K02/service/route/Today-card/confirmation-semantics criteria; consumes AI extract (0051) candidates via overlay; **20** unit tests green; domain+web tsc green. Full P04 stays unverified pending Data persistence + integration; browser not run.
