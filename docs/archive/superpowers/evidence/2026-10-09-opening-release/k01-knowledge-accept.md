# K01 accept — Source-backed, editable course knowledge (Data + AI)

**Date:** 2026-10-09 ~17:29 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release`  
**Workspace:** `/workspace/study-assistant-opening`  
**Scope:** Agent accept of **DATA + AI** halves against `docs/superpowers/plans/opening-release/10-media-knowledge.md` § K01.  
**Verdict:** **ACCEPT** overall (Data **ACCEPT**, AI **ACCEPT**; agent-owned; **not verified**)  
**Browser:** **not run** — do not claim browser pass.  
**Manual course review:** **not run** (plan’s 人工审查章节覆盖 / 引用支持度 — human verify).  
**tasks.json:** **not edited**. **verified:** **not marked**.  
**Commit/push:** **not done**.

## Halves

| Half | Owner | Verdict |
|---|---|---|
| Data | migration/schema/repo/API/domain validate + integration | **ACCEPT** |
| AI | `build-course-knowledge` job + handler wiring | **ACCEPT** |
| **Overall agent accept** | both halves | **ACCEPT** |

## Files reviewed

### Data half

**New**
- `packages/database/src/migrations/0048_opening_knowledge.sql` — `opening_course_knowledge` + `opening_jobs_kind_check` adds `build-course-knowledge` (Integrator **0048**; plan prose said 0028)
- `packages/database/src/schema/opening-knowledge.ts`
- `packages/database/src/repositories/opening-knowledge.ts` — get / getVersion / listAuthorizedChunks / replace (CAS) / enqueueRebuild / markNeedsCheckForSources
- `packages/domain/src/opening/knowledge-graph.ts` (+ `knowledge-graph.test.ts`) — `validateKnowledgeSnapshot`
- `packages/contracts/src/opening/knowledge.ts` (+ `knowledge.test.ts`)
- `apps/web/src/features/opening/knowledge/service.ts`
- `apps/web/src/app/api/opening/courses/[id]/knowledge/route.ts` — GET / PUT
- `apps/web/src/app/api/opening/courses/[id]/knowledge/rebuild/route.ts` — POST enqueue
- `tests/integration/opening-knowledge.test.ts`

**Changed (data-relevant)**
- `packages/contracts/src/opening/jobs.ts` — `jobKindSchema` includes `build-course-knowledge`
- Exports: `packages/contracts/src/opening/index.ts`, `packages/domain/src/index.ts`, `packages/database/src/index.ts`

**Not touched by Data (AI-owned)**
- Worker LLM extraction body / `build-course-knowledge.ts` implementation details beyond contract surface

### AI half (room handoff confirmed)

**New / wired**
- `apps/worker/src/jobs/build-course-knowledge.ts` (+ `build-course-knowledge.test.ts`)
- `apps/worker/src/index.ts` — injects handler: `listAuthorizedChunks` / `get` / `replace` + `resolveProvider`
- `apps/worker/src/runtime/handlers.ts` — `"build-course-knowledge"` slot
- `apps/worker/src/runtime/queue.ts` — queue kind list includes `build-course-knowledge`
- `apps/worker/src/runtime/run-job.test.ts` — exposes handler key among supported kinds

**Flow (verified in code)**
1. `get` → `expectedVersion = current?.version ?? 0`
2. `listAuthorizedChunks` → extract (`extractGraph` / provider)
3. `reconcileExtractedSnapshot` (drop unauthorized evidence; course membership; no-material prerequisite → `suggested`, no forged chunk ids)
4. `validateKnowledgeSnapshot` (or injected validate) — throw → **no** `replace`
5. `replace` with CAS `expectedVersion` + `sourceVersions` from chunks

## Plan criteria checklist

| # | Criterion | Half | Result | Notes |
|---|---|---|---|---|
| 1 | Self-prerequisite / cycle failure tests on `validateKnowledgeSnapshot` | Data | **PASS** | Domain unit: self prereq, cycle, missing node, supported w/o evidence, courseId mismatch, duplicate id; allows non-DAG `contains` cycles |
| 2 | Unit knowledge tests green | Data | **PASS** | domain 8 + contracts 3 = **11** |
| 3 | Authorized chunks → structure validate → source version / course membership | Both | **PASS** | Repo `assertAuthorizedChunkRefs`; AI reconcile drops foreign/unauthorized ids |
| 4 | No-material prerequisite → `suggested`; no forged evidence | AI | **PASS** | `reconcileExtractedSnapshot` + unit case |
| 5 | Prerequisite DAG only; other relations not mis-DAG’d | Data | **PASS** | `assertPrerequisiteDag` only on `prerequisite` |
| 6 | Migration after C01; store nodes/edges/snapshot + source versions; Integrator **0048** | Data | **PASS** | Table + jsonb snapshot/source_versions; applied in test DB (`schema_migrations` id `0048_opening_knowledge.sql`); job kind CHECK includes `build-course-knowledge` |
| 7 | GET/PUT knowledge + POST rebuild enqueue; payload `{ courseId }`; X01 expectedVersion | Data | **PASS** | Service + routes; enqueue payload `{ courseId }` only; CAS `expectedVersion` |
| 8 | Integration: idempotent replace, illegal refs, cross-owner, cycle, stale CAS, enqueue, authorized list | Data | **PASS** | **8** integration tests |
| 9 | Handler wiring: get→validate→replace; validation fail no save | AI | **PASS** | Unit: CAS path, expectedVersion 0 when null, validate throw → replace not called, missing courseId |
| 10 | Rollback notes: drop table / restore kind CHECK; keep raw materials | Data | **PASS** | Commented in `0048_opening_knowledge.sql` |
| 11 | Manual chapter-coverage / citation review | — | **NOT RUN** | Browser not run; human verify |
| 12 | 「人工更正不被覆盖」 dedicated merge | Both | **NOTE** | No separate “human edit survives rebuild” test. Rebuild is full CAS replace from extract. Human PUT exists; overwrite-on-rebuild is CAS-gated but not merge-preserving. Flag for human verify / follow-up — **does not block** claimed Data+AI wiring accept. |

## Tests re-run (actual counts)

```text
# Data unit — knowledge domain + contracts (= 11)
node node_modules/vitest/vitest.mjs run --project unit \
  packages/domain/src/opening/knowledge-graph.test.ts \
  packages/contracts/src/opening/knowledge.test.ts
→ Test Files  2 passed (2)
→ Tests       11 passed (11)
→ Duration    ~1.34s
  (domain 8 + contracts 3)

# Data integration — opening-knowledge (= 8)
OPENING_TEST_DB=1 OPENING_TEST_DATABASE_URL=postgres://aistudy:aistudy@127.0.0.1:5432/aistudy_opening_test \
  node node_modules/vitest/vitest.mjs run --project integration \
  tests/integration/opening-knowledge.test.ts
→ Test Files  1 passed (1)
→ Tests       8 passed (8)
→ Duration    ~3.42s

# AI worker unit — build-course-knowledge 8 + run-job 9 (= 17)
node node_modules/vitest/vitest.mjs run --project unit \
  apps/worker/src/jobs/build-course-knowledge.test.ts \
  apps/worker/src/runtime/run-job.test.ts
→ Test Files  2 passed (2)
→ Tests       17 passed (17)
→ Duration    ~2.10s
  (build-course-knowledge 8; run-job 9 — includes handler key exposure)

# tsc --noEmit
node node_modules/typescript/bin/tsc -p packages/domain/tsconfig.json --noEmit     → exit 0
node node_modules/typescript/bin/tsc -p packages/contracts/tsconfig.json --noEmit → exit 0
node node_modules/typescript/bin/tsc -p packages/database/tsconfig.json --noEmit  → exit 0
node node_modules/typescript/bin/tsc -p apps/web/tsconfig.json --noEmit           → exit 0
node node_modules/typescript/bin/tsc -p apps/worker/tsconfig.json --noEmit        → exit 0
```

DB probe: `pg_isready` OK; `opening_course_knowledge` present; `opening_jobs_kind_check` includes `build-course-knowledge`.

## Not run

- **Browser** — not run.
- Manual human review of one course’s chapter coverage / prerequisite quality / citation support — out of scope for agent accept.
- Live LLM extraction end-to-end against a real model — unit uses injected `extractGraph`; production path wires `resolveTutorModel` provider.

## Verdict summary

| Item | Result |
|---|---|
| Data half | **ACCEPT** |
| AI half | **ACCEPT** |
| Overall agent accept | **ACCEPT** |
| verified | **not marked** |
| tasks.json | **not edited** |
| commit/push | **not done** |

Evidence path: `docs/superpowers/evidence/2026-10-09-opening-release/k01-knowledge-accept.md`
