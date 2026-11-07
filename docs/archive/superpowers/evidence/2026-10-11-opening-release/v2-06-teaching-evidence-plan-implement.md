# V2-06 Teaching evidence — Plan-stage evidence (Understand + Plan only)

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy AI (executor / Grok Bot)  
**Branch:** `feat/opening-release`  
**Tip HEAD:** `cccc39272fd3a7d565a946b3979d0231220cbee2` (`cccc392`) — **matches required tip**  
**Stage:** Understand → Plan only. **No product Implement. No migrations/ALTER. No push / hermes / stash / reset / commit.**  
**Gates:** `docs/superpowers/plans/opening-release/review-test-gates.md` (list what was read / run; do **not** self-ACCEPT)

## Diff scope (this slice)

### Written (docs only)

| Path | Role |
|---|---|
| `docs/superpowers/plans/ai-led-learning-v2/v2-06-teaching-evidence-understand.md` | Understand |
| `docs/superpowers/plans/ai-led-learning-v2/v2-06-teaching-evidence-plan.md` | Plan (await ACCEPT) |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-06-teaching-evidence-plan-implement.md` | This plan-stage evidence |

### Explicitly not touched

- No `packages/ai/src/opening/teaching-evidence.ts`
- No `packages/domain/src/opening/teaching-coverage.ts`
- No edits to `context.ts` / `citations.ts` / `pick-sources.ts` / `tutor-chunks.ts` / `tutor-turn.ts`
- No migration SQL under `packages/database/src/migrations/`
- No ALTER / migrate / psql
- No `tasks.json` status → verified / in_progress / planned changes
- No push / hermes / stash / reset / commit
- Unrelated untracked evidence files present in tree were **not** created or modified by this slice

## Tip / branch verification

```text
$ git rev-parse HEAD
cccc39272fd3a7d565a946b3979d0231220cbee2

$ git branch --show-current
feat/opening-release

$ git log -1 --oneline
cccc392 feat(opening): V2-05 versioned teaching content (migration 0054)

$ ls packages/database/src/migrations/*.sql | tail -1
packages/database/src/migrations/0054_opening_teaching_content.sql
```

**Result:** tip OK. Migrations tip ends at **0054** (V2-05 landed). V2-06 Plan prefers **no DDL**; if later needed, Integrator assigns `00xx`.

## Inventory commands / Reads

### Tip confirm

```text
$ git rev-parse HEAD
cccc39272fd3a7d565a946b3979d0231220cbee2
```

**Result:** exit 0 — matches required baseline.

### Reuse entry points (rg + Read)

```text
$ rg -n "selectContext|renderContext|keywordOverlapScore" packages/ai/src/opening/context.ts
$ rg -n "resolveCitations|soft" packages/ai/src/opening/citations.ts
$ rg -n "shouldAutoPickSources|pickSourceIds" packages/ai/src/opening/pick-sources.ts
$ rg -n "chunksAtSnapshots|listChunksAtVersion" apps/worker/src/jobs/tutor-chunks.ts
$ rg -n "allowedSourceIds|selectContext|resolveCitations|preferCitationsForPage|MAX_PROVIDER_CHUNKS" apps/worker/src/jobs/tutor-turn.ts
```

**Result:** exit 0 — behaviors cited line-level in Understand §Inventory (Package C miss-fallback L107–111; soft citations L189–190; no re-narrow L126–128; version pin in tutor-chunks L13–27).

### V2-05 sourceRefs (landed)

```text
$ rg -n "teachingSourceRefSchema|sourceRefs" packages/contracts/src/opening/teaching-content.ts
```

**Result:** exit 0 — `{ sourceId, version?, chunkId?, page? }` on ActivitySpec (L39–46, L105).

### V2-02 fixtures

```text
$ ls tests/fixtures/opening/teaching/unit-rank-nullspace/lecture/retrieval-allowlist.json
$ ls tests/fixtures/opening/teaching/unit-rank-nullspace/eval-heldout/{ISOLATION.md,retrieval-denylist.json}
$ ls tests/fixtures/opening/teaching/unit-rank-nullspace/anomaly-cases/cases.json
```

**Result:** exit 0 — allowlist / denylist / ISOLATION / anomaly cases Read in full for Understand.

### Plan §V2-06 + gates

```text
$ rg -n "V2-06｜建立来源包" docs/superpowers/plans/ai-led-learning-v2/plan.md
$ Read docs/superpowers/plans/opening-release/review-test-gates.md
$ Read …/v2-05-teaching-content-understand.md + plan + plan-implement evidence (style reference)
```

**Result:** scope/reuse/proposed paths/acceptance/rollback aligned; evidence format matches V2-05 plan-implement.

### Additional Reads (completed; no product mutation)

| Path | Purpose |
|---|---|
| `packages/ai/src/opening/context.ts` (+ `context.test.ts` Package C cases) | selectContext / renderContext / miss-fallback |
| `packages/ai/src/opening/citations.ts` | soft resolveCitations default |
| `packages/ai/src/opening/pick-sources.ts` | shouldAutoPickSources |
| `apps/worker/src/jobs/tutor-chunks.ts` | version pin |
| `apps/worker/src/jobs/tutor-turn.ts` | privacy, selectContext, soft cites, soft page guard |
| `packages/domain/src/opening/tutor-policy.ts` | preferCitationsForPage / assertCitationsForPage soft |
| `packages/contracts/src/opening/sources.ts` | SourceChunk / Citation locators |
| `packages/contracts/src/opening/teaching-content.ts` | teachingSourceRefSchema |
| V2-02 allowlist, denylist, ISOLATION, sources-index, goals, anomaly-cases, activity-outline | fixture sample |
| `plan.md` §V2-06; `tasks.json` V2-06 | task fields |
| `review-test-gates.md` | evidence rules |

## Planned product tests (from Plan §6.2) — status

| ID | Status | Reason |
|---|---|---|
| E1–E10 (cross-source page, overlong anchors, Chinese paraphrase, zero-relevance, image-only, privacy, held-out leak, provider delimiters, external-search boundary, soft citations regression) | **`not_run`** | Plan stage only; modules not landed |
| `vitest` teaching-evidence / teaching-coverage | **`not_run`** | No Implement |
| `vitest` context / citations / pick-sources / tutor-turn regressions | **`not_run`** | Docs-only; not re-executed this slice |
| `tsc` / typecheck | **`not_run`** | Docs-only |
| Live provider payload capture | **`not_run`** | No runtime |
| Browser / E2E | **`not_run`** | N/A this slice |
| Migration apply | **`not_run`** | Plan prefers no DDL |

## Plan summary (for Accept)

1. Teaching evidence pack + coverage table + claim-kind classify; reuse `chunksAtSnapshots` + `selectContext` / `renderContext`.  
2. Anchors = `sourceId + sourceVersion + chunkId` (+ optional page/slideLabel/startMs); never page-alone across sources.  
3. Coverage statuses `covered|partial|uncovered|conflict`; uncovered conditions visible; no fake %.  
4. Held-out denylist + privacy exclude + no-material → no forged cites.  
5. Package C miss-fallback preserved; Package D soft citations preserved; coverage is orthogonal honesty.  
6. First sample = V2-02 unit-rank-nullspace fixtures.  
7. Migration **likely none**; optional later `00xx` via Integrator only.  
8. Thin adapter for tutor-turn / future V2-07 compile — no second chunk loader.  
9. Rollback = disable new assembly; keep authorized user-selected reads.

## Ask Integrator

**Please Plan ACCEPT** (or REJECT with gaps) before any product Implement.  
This evidence **does not** self-ACCEPT / self-verify / move `tasks.json`.

## Verdict this slice

- Understand + Plan **written**.  
- Tip still `cccc392…` at evidence time.  
- Confirm: **no Implement / no migration / no push** performed by this agent.  
- Await Integrator **Plan ACCEPT**.
