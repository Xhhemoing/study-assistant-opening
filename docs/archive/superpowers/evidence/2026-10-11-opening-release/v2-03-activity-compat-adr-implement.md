# V2-03 implement — Activity / content / evidence compatibility ADR

**Date:** 2026-10-11 (Asia/Shanghai)  
**Agent:** AIstudy Data (executor)  
**Baseline tip:** `1a4cf465c86da7f08b6fda3044f9b0f932b80824`  
**Branch:** `feat/opening-release`  
**Task:** V2-03 — decide activity/content/evidence compatibility boundaries  

## Files touched

| Path | Action |
|---|---|
| `docs/decisions/ADR-teaching-activity-context.md` | **Created** — decision-ready ADR |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-03-activity-compat-adr-implement.md` | **Created** — this evidence |

**Not touched:** `tasks.json`, Experience/AI/Pipeline product code, any migration SQL, package source under `apps/` / `packages/` (read-only inventory only).

## Inventory summary (read-only)

### Contracts — `courseId` required vs optional

| Schema / file | `courseId` |
|---|---|
| `observationInputSchema` (`learning.ts` ~L100) | **required** |
| `learningSessionCreateInputSchema` (`learning.ts` ~L201) | **required** |
| `retestCandidateSchema` (`learning.ts` ~L182) | **required** |
| `learningSummarySchema.courseId` (`learning.ts` ~L173) | optional (response field) |
| `learningAttemptSchema` (`learning-attempts.ts` ~L25) | **required** |
| history / summary-page inputs | **required** |
| `learning-revisions` patch fields | optional |
| Contrast: `conversations.ts`, `memory.ts`, `planning.ts` | nullable / optional (workspace-scoped already) |

### SQL — `course_id NOT NULL` (opening learning & related)

| Migration | Objects |
|---|---|
| `0019_opening_learning.sql` | `opening_learning_sessions.course_id` NOT NULL; `opening_learning_observations.course_id` NOT NULL |
| `0028_opening_learning_attempts.sql` | `opening_learning_history_revisions` PK `(workspace_id, owner_user_id, course_id)` all NOT NULL; `opening_learning_item_versions.course_id` NOT NULL; `opening_learning_attempts.course_id` NOT NULL |
| `0049_opening_skill_evidence.sql` | `course_id` NOT NULL **REFERENCES courses(id) ON DELETE CASCADE** |
| `0030_opening_retest_activities.sql` | `course_id` NOT NULL FK courses |
| `0048_opening_knowledge.sql` | knowledge nodes `course_id` NOT NULL FK |
| **Contrast** `0017_opening_conversations.sql` | `course_id uuid NULL` already |

Also noted: `0037_opening_learning_history_snapshot.sql` adds workspace-level `opening_workspace_history_revisions` PK `(workspace_id, owner_user_id)` — usable as coarse watermark, not a substitute for activity-scoped course-null facts.

### Repos / auth seams

| File | Finding |
|---|---|
| `opening-learning-facts.ts` | `nextLearningHistoryRevision` / `lockLearningHistory` keyed by `courseId`; `lockLearningSession` **JOIN courses … archived_at IS NULL** |
| `opening-learning-observations.ts` | writes `course_id`; validates session/attempt/retest `course_id` match |
| `opening-learning-summary-read.ts` | all queries filter `course_id`; joins non-archived courses |
| `opening-learning-help.ts` | locks/revises via `session.course_id` |
| `opening-learning.ts` | `createSession` requires live course; `assertOwnedCourse` |
| `apps/web/.../learning/read-service.ts` | `assertOwnedCourse` before list/summarize |

### Content assets

- `0001_library.sql`: `library_documents` / `library_blocks` (`content jsonb`) / `library_revisions` (append-only) — **chosen as sole teaching body store**.
- `0010_revision_proposals.sql`: candidate edits without forking body tables.
- Teaching metadata tables (future) may index only; no duplicate body.

### API consumers that break if `courseId` becomes optional without dual path

Grep hit surfaces (non-exhaustive but decisive):

- Contracts: `learning.ts`, `learning-attempts.ts`, `learning-history.ts`, `learning-summary-page.ts`, plus course-scoped knowledge/sources/retest.
- Web: `observation-service.ts`, `read-service.ts`, `tutor-actions.ts`, `summary-page-service.ts`, `history-service`, `learning-client.ts`, routes `api/opening/observations`, `api/opening/learning-sessions`, course-scoped history/summary URLs.
- DB: all `opening-learning-*` writers/readers above; backup table list expects course-scoped history rows.

**Conclusion recorded in ADR:** keep v1 required; add v2 activity-scoped path only after approved migration + auth rewrite.

### Backup

`OPENING_BACKUP_TABLES` (`opening-backup-records.ts`) already includes learning sessions/observations/attempts/history_revisions. Does **not** currently list `opening_skill_evidence` or eligibility — ADR D6 flags registering **new activity tables from day one** and evaluating gaps in the same migration approval.

## Commands run (read-only)

```text
git rev-parse HEAD          # 1a4cf465c86da7f08b6fda3044f9b0f932b80824
git branch --show-current   # feat/opening-release
rg / Read on contracts, migrations 0017/0019/0028/0037/0049/0001/0010,
  opening-learning-*.ts repos, read-service.ts, backup-records,
  plan.md V2-03, charter docs/plans/2026-10-11-ai-led-learning-v2.md
```

No `psql`, no migration runner, no `git commit` / `push` / `stash` / `reset`, no `ALTER`.

## Explicit non-actions

- **No migration executed**
- **No schema ALTER**
- **No commit / push / stash / reset**
- **No `tasks.json` status edit**
- **No Experience / AI / Pipeline product file edits** beyond ADR + this evidence

## Acceptance checklist vs V2-03

| Criterion | Status |
|---|---|
| Inventory of API consumers + SQL constraints | Done (summarized above; cited in ADR) |
| Old required-courseId requests keep current behavior | Decided: v1 APIs unchanged |
| Counterexamples: no-course read/auth/archive/later association | Done in ADR D5 |
| Clear compat decisions for persistence + cross-package contracts | Done D1–D7 |
| No “just make nullable and forget auth” plan | Explicitly rejected |
| Rollback: keep old APIs; no default backfill of correct/independent/migrated | Done D6 |
| Paula embedding constraints present | Done D7 |
| Charter G3/G6/G8 + facts ledger + no-course plan paragraph | Reflected throughout |
| Content authority = library Document/Block/Revision | Done D2 |
| History revision PK evolution options + recommendation | Done D3.1 (option A) |
| Out of scope: migrations, TeachingUnit, Pipeline | Done D8 |
| approval_boundary respected | Design only; migration/API execution needs separate approval |

## Open questions for PM / Paula (before M1 migrations)

1. Approve ADR recommendation **history revision option A** (activity-scoped counter table) vs B (workspace-only for no-course)?
2. M1 policy for **retest activities** without course: defer task-type retests until course associated, or approve parallel nullable FK migration in same wave?
3. Whether to fold **`opening_skill_evidence` (+ eligibility)** into `OPENING_BACKUP_TABLES` in the same approved migration batch as activity tables.
4. Confirm product entry: Today「继续学习 / 开始学习」+ activity stream only (no standalone teaching app shell).

## Decision one-liner

**Activity = workspace+owner+activityId (course optional, never ghost); body = library once; facts = single `opening_learning_*` write path with dual API (v1 course-required unchanged; v2 activity-scoped after approved nullable+auth+revision-key migration); Episode/projection never a second score; backup from day one; rollback = flag off + keep data.**
