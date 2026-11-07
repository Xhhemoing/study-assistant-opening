# V2-03 accept — Activity / content / evidence compatibility ADR

**Date:** 2026-10-11 (Asia/Shanghai / CST)  
**Agent:** Integrator ACCEPT (executor)  
**Baseline tip:** `1a4cf465c86da7f08b6fda3044f9b0f932b80824`  
**Branch:** `feat/opening-release`  
**Task:** V2-03 — decide activity/content/evidence compatibility boundaries  
**Verdict:** **ACCEPT**

## Scope of this accept

Design-only accept of `docs/decisions/ADR-teaching-activity-context.md` (status: **提案 / 待批准**) against plan/tasks V2-03 acceptance and implement evidence. No product/schema edits, no commit/push/stash/reset, no migration execution authorized or observed.

## Inputs reviewed

| Artifact | Role |
|---|---|
| `docs/superpowers/plans/ai-led-learning-v2/plan.md` §V2-03 | Acceptance: clear compat decisions; no nullable-without-auth plan |
| `docs/superpowers/plans/ai-led-learning-v2/tasks.json` V2-03 | Same; approval_boundary = migrations/cross-package API need separate approval |
| `docs/decisions/ADR-teaching-activity-context.md` | Decision under review (proposal) |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-03-activity-compat-adr-implement.md` | Implement inventory |
| `docs/plans/2026-10-11-ai-led-learning-v2.md` | G3/G6/G8, Paula embed, facts ledger |

## Spot-check vs code reality (stronger review)

### Contracts — required vs optional `courseId`

| Claim (ADR / implement) | Code check | Result |
|---|---|---|
| `observationInputSchema` requires `courseId` (`learning.ts` ~L100) | L100 `courseId: uuidSchema` (required) | Match |
| `learningSessionCreateInputSchema` requires `courseId` (~L201) | L201 `courseId: uuidSchema` | Match |
| `retestCandidateSchema` requires `courseId` (~L182) | L182 `courseId: uuidSchema` | Match |
| `learningSummarySchema.courseId` optional (~L173) | L173 `uuidSchema.optional()` | Match |
| `learningAttemptSchema` requires `courseId` (`learning-attempts.ts` L25) | L25 `courseId: uuidSchema` | Match |
| history / summary-page inputs require `courseId` | `learning-history.ts` L6; `learning-summary-page.ts` L11/L19 | Match |
| conversations / memory / planning already nullable | `conversations.ts` nullable; `memory.ts` nullable; `planning.ts` nullable/optional | Match |
| learning-revisions patch `courseId` optional | `learning-revisions.ts` L8 optional | Match |

### SQL — `course_id NOT NULL` / nullable contrast

| Claim | Code check | Result |
|---|---|---|
| `0019` sessions + observations `course_id NOT NULL` | L9 sessions; L53 observations | Match |
| `0028` history_revisions PK `(workspace_id, owner_user_id, course_id)` all NOT NULL; item_versions + attempts NOT NULL | L1–4 PK; L8; L17 | Match |
| `0017` conversations `course_id` NULL | L9 `uuid NULL` | Match |
| `0049` skill_evidence `course_id NOT NULL` FK courses | L7 `REFERENCES courses(id) ON DELETE CASCADE` | Match |
| `0030` retest_activities `course_id NOT NULL` FK | L5 | Match |
| `0048` knowledge course-bound NOT NULL FK | `opening_course_knowledge.course_id` L10 NOT NULL FK; PK `(workspace_id, course_id)` | Match (see wording note) |
| `0037` workspace history PK without course | `opening_workspace_history_revisions` PK `(workspace_id, owner_user_id)` | Match |
| Library sole body store | `0001_library.sql`: documents / blocks (`content jsonb`) / revisions + append-only triggers; `0010_revision_proposals.sql` present | Match |

### Auth / revision seams

| Claim | Code check | Result |
|---|---|---|
| `lockLearningSession` JOIN courses + `archived_at IS NULL` | `opening-learning-facts.ts` L30–32 | Match |
| `nextLearningHistoryRevision` conflict key `(workspace, owner, courseId)` | L43–47 `ON CONFLICT (workspace_id,owner_user_id,course_id)` | Match |
| `createSession` requires live (non-archived) course | `opening-learning.ts` L26 | Match |
| Read path `assertOwnedCourse` before list/summarize | `read-service.ts` L16–23 | Match |
| Help path revises via `session.course_id` | `opening-learning-help.ts` L21, L42, L48 | Match |

### Backup / no parallel scoring / Paula embed

| Claim | Code check | Result |
|---|---|---|
| `OPENING_BACKUP_TABLES` includes learning sessions/observations/attempts/history_revisions | `opening-backup-records.ts` L7–15 | Match |
| Does **not** list `opening_skill_evidence` or eligibility | Absent from array; eligibility table exists in `0038` | Match; D6 correctly flags gap |
| `0049` comment: observation authoritative; SkillEvidence projection | Header comment lines 1–2 | Match D4 |
| Embed Today / 继续学习 | `today-resume-view.tsx` has「继续学习」link | Match D7 intent |
| Charter Paula embed + facts ledger + no fork scoring | Charter §Integration constraint + §Facts ledger | Reflected in ADR D4/D7 |

### No destructive migration in this slice

| Check | Result |
|---|---|
| `git status` product/schema (`packages/`, `apps/`, `*.sql`) vs HEAD | **Clean** — no diffs |
| Untracked in this slice | ADR + evidence docs only (plus pre-existing plan/charter/fixture docs unrelated to migration execution) |
| New migration files added by V2-03 | **None** |
| `psql` / ALTER / migration runner | Not indicated; implement evidence claims read-only; accept confirms no schema land |

## Decision claims vs V2-03 acceptance

| Required decision | ADR coverage | Accept |
|---|---|---|
| Activity identity = workspace+owner+activityId; courseId optional; no ghost courses | D1 | Pass |
| Single content store Document/Block/Revision | D2 | Pass |
| Single facts path `opening_learning_*` | D3 | Pass |
| v1 required courseId unchanged; v2 nullable needs auth + revision key; recommend activity revision table **A** | D3 + D3.1 | Pass |
| No parallel scoring; Episode/SkillEvidence projection only | D4 | Pass |
| Embed Today / continue-learning (Paula) | D7 | Pass |
| No migrations/ALTER executed | D8 + workspace check | Pass |
| Counterexamples: no-course auth/archive/later association; no UPDATE historical observation.course_id | D5 | Pass |
| Rollback: keep old APIs; no default backfill correct/independent/migrated | D6 | Pass |
| Not “nullable and forget auth” | Explicitly rejected D5/D3 seams table | Pass |

## Factual mismatches / notes (non-blocking)

1. **Wording precision on 0048:** ADR background table labels `0048` as「知识节点」. Actual table is `opening_course_knowledge` (course-scoped snapshot JSON), not a standalone `knowledge_nodes` relation. Constraint claim (`course_id NOT NULL` FK → courses) is **correct**; label is slightly loose. SkillEvidence `node_id` is a UUID column without FK to a separate nodes table in 0048/0049.
2. **ADR status remains proposal:** Approval checkboxes empty; M1 migrations / cross-package API still require separate PM/Paula approval per plan `approval_boundary` and ADR D8/后续.
3. No invented SQL constraints found in spot-check; cited line numbers for contracts and `opening-learning-facts.ts` align with tip `1a4cf465…`.

## Verdict rationale

V2-03 acceptance criteria are met: inventory of consumers/SQL exists; compat boundaries are explicit (D1–D7); v1 courseId-required behavior is preserved by design; nullable without auth rewrite is rejected with concrete seams and counterexamples; Paula embed and no-parallel-scoring are present; history PK evolution recommends option A without ghost courses; this slice did not land migrations or product/schema edits.

**ACCEPT** as a design ADR pending PM/Paula approval before any M1 ALTER or dual-path API implementation (V2-04+).

## Explicit non-actions by accept agent

- Did not edit ADR body, `tasks.json`, product code, or SQL  
- Did not commit / push / stash / reset  
- Did not run migrations or approve M1 execution  

## Evidence paths

- Accept: `docs/superpowers/evidence/2026-10-11-opening-release/v2-03-activity-compat-adr-accept.md`  
- Implement: `docs/superpowers/evidence/2026-10-11-opening-release/v2-03-activity-compat-adr-implement.md`  
- ADR: `docs/decisions/ADR-teaching-activity-context.md`
