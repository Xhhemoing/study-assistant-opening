# V2-04 Migration / Work-Order DRAFT — Teaching Activity Context

**Status:** **设计拍齐**（Integrator 草稿 ACCEPT + PM 设计决策已锁定）— **仍非**迁移 / ALTER / 产品代码授权  
**Date:** 2026-10-11 (Asia/Shanghai)  
**Task:** V2-04（实现可自由开始的学习活动上下文）  
**Depends on:** V2-03 ADR `docs/decisions/ADR-teaching-activity-context.md`  
**PM design approval:** 已批准（设计）; history revision-key **option A**  
**PM design decisions:** `docs/superpowers/evidence/2026-10-11-opening-release/v2-04-pm-design-decisions.md`  
**Draft ACCEPT:** `docs/superpowers/evidence/2026-10-11-opening-release/v2-04-migration-work-order-draft-accept.md`  
**Baseline tip:** `1a4cf465c86da7f08b6fda3044f9b0f932b80824`（`feat/opening-release`）  
**Owner role (plan):** 数据/服务  

> **Hard gate:** Do **not** execute this work order until (1) M0 green — V2-01 CI ACCEPT（V2-02 已合齐 ACCEPT）, and (2) PM explicitly opens the V2-04 **implement** slice. 设计拍齐 ≠ 实现门。

---

## 1. Goal / scope

Aligned to `tasks.json` V2-04 and `plan.md` §V2-04 / §6.1:

| In scope (when implement is opened) | Out of scope (this draft / V2-04) |
|---|---|
| Free-start **LearningActivity**: create from material, topic, question, or Today「继续/开始学习」entry | TeachingUnit / ActivitySpec body (V2-05) |
| Identity always `workspaceId + ownerUserId + activityId`; **owner + workspace required** | Pipeline ingest / compile job (V2-07) |
| **`courseId` optional**; no page/course prerequisite | Parallel scoring / mastery tables (forbidden D4) |
| Persist activity meta: intent/goal, path version, user progress status, clientKey idempotency | Retest-without-course schema change（**PM 已决：M1 推迟**） |
| Associate / unassociate course **without moving or copying** observation/attempt facts | Ghost / sentinel / default courses (forbidden D1/C) |
| Dual API: v1 course-required unchanged; v2 activity-scoped after approved migration | Editing `tasks.json` status as part of this draft |
| Register new tables in `OPENING_BACKUP_TABLES` from day one | DROP of user data; irreversible backfill of correct/independent/migrated |

**Acceptance (from task):** problem entry can start without a course; old course entry still works; new data exportable/restorable by user workspace+owner scope.

**Rollback (from task / ADR D6):** close new entry feature flag; keep data + read compat; **no DROP** of user tables.

---

## 2. Proposed new tables (DDL sketch — text only, not applied)

Migration filename placeholder: `00xx_opening_teaching_activities.sql` (Integrator assigns number when implement opens; do not invent collision).

### 2.1 `opening_teaching_activities`

Stable activity identity row. Metadata only — **no teaching body** (body stays `library_documents` / `library_blocks` / `library_revisions` per ADR D2).

```sql
-- SKETCH ONLY — do not apply
CREATE TABLE opening_teaching_activities (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Optional association pointer only; never part of identity PK (ADR D1)
  course_id UUID NULL REFERENCES courses(id) ON DELETE SET NULL,
  -- Learning progress (not mastery): plan §6.4
  status TEXT NOT NULL
    CHECK (status IN ('active', 'paused', 'completed', 'skipped')),
  -- Content/generation readiness is separate; do not conflate with progress
  generate_status TEXT NOT NULL DEFAULT 'ready'
    CHECK (generate_status IN (
      'queued', 'generating', 'needs_check', 'ready',
      'failed', 'unknown', 'cancelled', 'stale'
    )),
  -- Intent / goal for free-start (material, topic, question, resume, …)
  intent_kind TEXT NOT NULL
    CHECK (intent_kind IN (
      'material', 'topic', 'question', 'goal', 'resume', 'course_continue'
    )),
  intent_summary TEXT NOT NULL
    CHECK (char_length(intent_summary) BETWEEN 1 AND 2000),
  -- Optional refs; server validates accessibility; not a second body store
  source_ids UUID[] NOT NULL DEFAULT '{}',
  goal_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Path / checkpoint versions (V2-05/12/14 will deepen; keep stubs now)
  path_version INTEGER NOT NULL DEFAULT 1 CHECK (path_version > 0),
  content_version INTEGER NOT NULL DEFAULT 0 CHECK (content_version >= 0),
  checkpoint_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Idempotent create (V2-04 verification: same key + same intent → replay)
  client_key TEXT NOT NULL
    CHECK (char_length(client_key) BETWEEN 8 AND 200),
  create_intent JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, owner_user_id, client_key)
);

CREATE INDEX opening_teaching_activities_owner_status_idx
  ON opening_teaching_activities (workspace_id, owner_user_id, status, updated_at DESC);

CREATE INDEX opening_teaching_activities_course_idx
  ON opening_teaching_activities (workspace_id, course_id)
  WHERE course_id IS NOT NULL;
```

**Associate course:** `UPDATE … SET course_id = $new` (or NULL to unassociate) on **this row only**. Do **not** `UPDATE` historical `opening_learning_observations.course_id` / attempts (ADR D5 #4).

### 2.2 `opening_learning_activity_history_revisions` (option A)

PM-approved revision-key **A**. v1 course counter table `opening_learning_history_revisions` stays untouched. v2 activity-scoped writes advance this counter. Associating a course does **not** merge or replay revision numbers.

```sql
-- SKETCH ONLY — do not apply
CREATE TABLE opening_learning_activity_history_revisions (
  workspace_id UUID NOT NULL,
  owner_user_id UUID NOT NULL,
  activity_id UUID NOT NULL
    REFERENCES opening_teaching_activities(id) ON DELETE CASCADE,
  revision BIGINT NOT NULL DEFAULT 0
    CHECK (revision BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (workspace_id, owner_user_id, activity_id)
);
```

**Write-path rule (document in implement PR):**

| Scope | Counter |
|---|---|
| v1 course API / existing course-scoped facts | `opening_learning_history_revisions` (course_id) |
| v2 activity-scoped facts | `opening_learning_activity_history_revisions` (activity_id) |
| workspace snapshot watermark (0037) | `opening_workspace_history_revisions` (unchanged) |

**Forbidden:** sentinel UUID in `course_id` (option C); making PK `course_id` nullable (Postgres PK cannot be NULL).

---

## 3. ALTER checklist (existing tables)

Apply only after PM opens implement slice. Order suggestion: new tables first → add nullable columns / FKs → rewrite auth → dual contracts → backup list → tests. No irreversible fact backfill.

### 3.1 Must change for no-course activity facts (ADR D3)

| Table | Current | Proposed ALTER | Notes |
|---|---|---|---|
| `opening_learning_sessions` | `course_id UUID NOT NULL` (0019) | `ALTER … ALTER COLUMN course_id DROP NOT NULL`; `ADD COLUMN activity_id UUID NOT NULL` → FK `opening_teaching_activities(id)` | Existing rows need **backfill strategy for activity_id** before NOT NULL — see §3.3. Index: add `(workspace_id, activity_id)`. |
| `opening_learning_observations` | `course_id UUID NOT NULL` (0019) | Drop NOT NULL on `course_id`; `ADD activity_id UUID NOT NULL` FK activities | Index covering `(workspace_id, activity_id)` (and keep course idx for v1). |
| `opening_learning_attempts` | `course_id uuid NOT NULL` (0028) | Same pattern | Session/activity consistency checks in writers. |
| `opening_learning_item_versions` | `course_id uuid NOT NULL` (0028) | Drop NOT NULL **or** nullable per ADR (“同上或改为可空”); prefer nullable + `activity_id NOT NULL` for symmetry | Confirm in implement review. |
| `opening_learning_history_revisions` | PK `(workspace_id, owner_user_id, course_id)` all NOT NULL | **No change** to this table | Option A: new activity counter table instead. |

Optional companion (decide in implement PR, not blocking design):

| Table | Proposal |
|---|---|
| `opening_help_exposures` | No `course_id` today; consider `activity_id` via session join only, or add denormalized `activity_id` if activity-scoped repair needs it — **defer unless writer path requires it**. |

### 3.2 Stay course-required for M1 (deferred unless PM says otherwise)

| Table / domain | Constraint | M1 policy |
|---|---|---|
| `opening_skill_evidence` (0049) | `course_id NOT NULL` FK → `courses` | **Do not write** SkillEvidence for no-course facts; project after course association + node exists (ADR D3) |
| `opening_retest_activities` (0030) | `course_id NOT NULL` FK | **PM 已决：** M1 仅课程关联活动生成 task 型补测；无课程留观察层；**不同批** nullable FK |
| `opening_course_knowledge` (0048) | `course_id NOT NULL` FK; PK `(workspace_id, course_id)` | **Course-scoped knowledge snapshot** — stays course-required. See Integrator note §11 |

### 3.3 Existing-row `activity_id` backfill — **PM 已决：A1 内容 + A2 时序**

Historical sessions/observations/attempts have course but no activity. Locked by `v2-04-pm-design-decisions.md`:

| Piece | Decision |
|---|---|
| **A1 content** | For each distinct `(workspace, owner, course)` learning footprint, create one **user-owned** synthetic `opening_teaching_activities` row (`intent_kind='course_continue'`, `course_id` set, status derived, **not hidden**) |
| **A2 sequencing** | DDL adds **nullable** `activity_id` first → backfill → then `SET NOT NULL` |
| **Forbidden** | Ghost / sentinel / system courses; irreversible polish of correct / independent / migrated / transfer |

**No** backfill of `outcome=correct`, `assistance=independent`, or transfer dimensions.

### 3.4 Indexes / eligibility / summary

- Add activity-scoped indexes before enabling v2 writes.
- `opening_learning_eligibility` (0038): derived; repair/read paths that filter by course must gain activity-scoped repair **or** continue deriving from observation heads that now carry `activity_id` — include in auth/writer checklist; table itself may not need `course_id` ALTER.
- `opening_learning_summary-read` / course summary API: **must not** return no-course (null `course_id`) rows (ADR D5 #2).

---

## 4. Auth rewrite checklist

Stop relying solely on course ownership for no-course paths. **v1 paths unchanged.**

| Seam | Current | v2 requirement |
|---|---|---|
| `assertOwnedCourse` (`opening-learning.ts`, `read-service.ts`, `tutor-actions.ts`) | Required before list/summarize/help | Keep for **v1 course** APIs; **must not** call for no-course activity create/read/write |
| `lockLearningSession` (`opening-learning-facts.ts` L28–34) | `JOIN courses … archived_at IS NULL` | Split or branch: no-course sessions lock via **activity ownership** (`workspace + owner + activity_id`); course archive must not kill no-course activity I/O (ADR D5 #3) |
| `lockLearningHistory` / `nextLearningHistoryRevision` | Keyed by `courseId` | v1 keep; v2 add `lockLearningActivityHistory` / `nextLearningActivityHistoryRevision` against option A table |
| Observation/attempt writers | Validate session `course_id` match | Allow null course when session/activity agree; require `activity_id` match |
| Cross-owner | Workspace owner checks | Reject cross-owner activity access (V2-04 verification) |
| Course archive | JOIN fails writes | Archive affects **course association views** only; existing observations remain; activity auth is source of truth for activity APIs |

**Explicit non-goal:** do not weaken v1 course routes (`/api/opening/courses/{courseId}/…`).

---

## 5. Contracts dual path (sketch fields only)

### 5.1 v1 — keep required `courseId` (no breaking change)

Unchanged schemas in `packages/contracts/src/opening/learning.ts` (and attempts/history/summary-page siblings):

- `observationInputSchema.courseId` — **required**
- `learningSessionCreateInputSchema.courseId` — **required**
- `retestCandidateSchema.courseId` — **required**
- history / summary-page inputs — **required** where today required

Old clients keep today’s behavior (ADR D5 counterexample).

### 5.2 v2 — proposed `packages/contracts/src/opening/teaching-activity.ts` (sketch only; do not implement in this draft)

```ts
// SKETCH — field shapes only; not landed
teachingActivityCreateInputSchema = {
  clientKey: string(8..200),
  intentKind: 'material' | 'topic' | 'question' | 'goal' | 'resume' | 'course_continue',
  intentSummary: string(1..2000),
  sourceIds?: uuid[],
  courseId?: uuid | null,          // optional association at create
  goalJson?: object,
  createIntent: object,            // for same-key / different-intent → 409
}

teachingActivitySchema = {
  id, workspaceId, ownerUserId,
  courseId: uuid | null,
  status: 'active' | 'paused' | 'completed' | 'skipped',
  generateStatus: …,
  intentKind, intentSummary, sourceIds,
  pathVersion, contentVersion,
  checkpointJson?,
  clientKey, createdAt, updatedAt,
}

teachingActivityAssociateCourseInputSchema = {
  courseId: uuid | null,           // null = unassociate
  expectedUpdatedAt? / expectedVersion?,
}

// Formal facts still go through existing observation/attempt services via v2 adapters:
activityObservationInputSketch = {
  activityId: uuid,                // required
  sessionId: uuid,
  courseId?: uuid | null,          // optional; must match activity association rules
  // …same outcome/assistance/clientKey fields as v1 observation…
}
```

Proposed routes (from plan §6.3 — still proposals):  
`POST/GET …/teaching/activities`, commands, feedback, checkpoint — all activity-primary.

**Repo/service paths (proposed, not created by this draft):**  
`packages/database/src/repositories/opening-teaching-activities.ts`,  
`apps/web/src/features/opening/teaching/activity-service.ts`.

---

## 6. Backup

From day one of the approved migration batch, register in `OPENING_BACKUP_TABLES` (`opening-backup-records.ts` L7–15) — **PM 已决** (`v2-04-pm-design-decisions.md`):

| Table | Action |
|---|---|
| `opening_teaching_activities` | **Must add** |
| `opening_learning_activity_history_revisions` | **Must add** |
| `opening_skill_evidence` | **Must add**（同批；今日未在清单） |
| Existing learning sessions/observations/attempts/history_revisions/workspace_history_revisions | Already listed — keep |
| `opening_learning_eligibility` | **Skip**（可重建；除非后续 restore 测要求再议） |
| `opening_course_knowledge` | **本波不进** |

Export/restore: same opening-backup format; scope = workspace + owner; no second backup format.

---

## 7. Feature flag / rollback

| Control | Behavior |
|---|---|
| Feature flag (e.g. teaching activity entry / v2 write path) | **Off** → hide new entry; old v1 APIs serve as today |
| Data | **Retain** all new activity rows and any nullable-course facts |
| Reads | Keep read-compat for already-written activity data where safe |
| Schema | **No DROP** of user data tables on rollback |
| Backfill | **No** irreversible “correct / independent / migrated / transfer” polish |
| Course APIs | Unchanged indefinitely until explicit deprecation RFC |

---

## 8. Counterexample tests (required verification — ADR D5 + V2-04 task)

Implement must include automated cases (unit/integration on isolated test DB only):

| # | Scenario | Expect |
|---|---|---|
| 1 | No-course create activity + submit observation | Write succeeds; auth = owner+workspace+activity |
| 2 | No-course read activity facts | Activity API returns rows; **course summary API does not** |
| 3 | Course archived; read/write no-course (or still-associated) activity | Activity I/O still works; not killed by `lockLearningSession` course JOIN |
| 4 | Later associate course | Activity `course_id` updates; **historical `observation.course_id` unchanged** |
| 5 | Unassociate course | Same; observations not deleted |
| 6 | Old client still sends required `courseId` | Behavior identical to tip `1a4cf46` |
| 7 | Cross-owner activity access | Rejected |
| 8 | Duplicate `clientKey` + same create intent | Idempotent replay |
| 9 | Same `clientKey` + different intent | **409 Conflict** |
| 10 | Associate does not move/copy facts | Row counts / observation ids stable; no UPDATE on observation.course_id |
| 11 | Server validates source accessibility on create/associate | Unavailable / privacy-excluded sources rejected |

---

## 9. Explicit deferred

| Item | Why deferred |
|---|---|
| TeachingUnit / ActivitySpec body & versioned content (V2-05) | Separate task; activities table stores meta/index only |
| Pipeline / `compile-teaching-unit` (V2-07) | Worker/budget slice after activity context exists |
| Retest-without-course nullable FK | **PM 已决推迟 M1**；仅课程关联活动生成 task 型补测 |
| Sentinel UUID / ghost course (option C) | **Forbidden** forever under G3/D1 |
| Option D unified `(scope_kind, scope_id)` PK | Far-term tidy; not M1 default |
| SkillEvidence writes without course | Forbidden until course + node projection path |
| Parallel Episode score tables | Forbidden D4 |
| This draft executing ALTER / migrate / commit / push | Forbidden until PM implement gate |

---

## 10. Approval gate — design vs implement

### 设计拍齐（已锁定 — 见 `v2-04-pm-design-decisions.md`）

| # | Item | Locked decision |
|---|---|---|
| 1 | Revision-key | **Option A**（`opening_learning_activity_history_revisions`）；课程计数器不动 |
| 2 | Existing-row `activity_id` | **A1 内容 + A2 时序**（§3.3） |
| 3 | Retest-without-course | **M1 推迟**；无同批 nullable FK on `opening_retest_activities` |
| 4 | Backup batch | 新活动表 **+ `opening_skill_evidence`** 同批登记；**跳过** eligibility（可重建）；`opening_course_knowledge` 本波不进 |
| 5 | Product entry | Today「继续学习 / 开始学习」+ activity stream；**无**旁路教学 App |
| 6 | Migration number | Integrator 开实现时对照 `schema_migrations` 分配；tip 止于 **0052**；预期候选 **0053**（冲突再拆） |

### 实现门（仍未开 — 禁止 ALTER）

1. **M0 green:** V2-01 CI **ACCEPT**（V2-02 已合齐 ACCEPT）。
2. **PM 另开** V2-04 **implement** 切片（设计拍齐 ≠ 实现授权）。
3. Integrator 分配迁移号并对照 live `schema_migrations` 审 DDL。

Until then: design docs only; **no** migrate runner, **no** `psql` ALTER, **no** product file creation beyond this draft + evidence notes.

---

## 11. Integrator note — 0048 real table name

ADR background previously labeled `0048_opening_knowledge.sql` as「知识节点」. **Actual table created is `opening_course_knowledge`** (course-scoped JSON snapshot: nodes/edges live inside `snapshot jsonb`; PK `(workspace_id, course_id)`; `course_id NOT NULL` FK → `courses`).

There is **no** standalone `knowledge_nodes` relation in 0048. SkillEvidence `node_id` (0049) is a UUID column without FK to a separate nodes table.

**Implication for V2-04:** treat `opening_course_knowledge` as course-required knowledge snapshot; do not plan a nullable `course_id` on it in the activity migration wave; do not invent a parallel knowledge table for no-course activities in M1.

---

## 12. Suggested implement file touch list (when opened — not this draft)

| Path | Role |
|---|---|
| `packages/database/src/migrations/00xx_opening_teaching_activities.sql` | New tables + ALTERs |
| `packages/database/src/repositories/opening-backup-records.ts` | Register new activity tables **+ `opening_skill_evidence`**（PM 已决） |
| `packages/database/src/repositories/opening-learning-facts.ts` | Activity lock + activity history revision helpers; session lock branch |
| `packages/database/src/repositories/opening-teaching-activities.ts` | **New** repo (proposed) |
| `packages/contracts/src/opening/teaching-activity.ts` | **New** v2 contracts (proposed) |
| `apps/web/src/features/opening/teaching/activity-service.ts` | **New** service (proposed) |
| Existing `opening-learning-*.ts`, `read-service.ts` | Dual-path auth / writers |
| Tests covering §8 | Required |

**This draft must not create those product files.**

---

## 13. References

- PM design decisions: `docs/superpowers/evidence/2026-10-11-opening-release/v2-04-pm-design-decisions.md`
- Draft ACCEPT: `docs/superpowers/evidence/2026-10-11-opening-release/v2-04-migration-work-order-draft-accept.md`
- ADR: `docs/decisions/ADR-teaching-activity-context.md` (D1–D8, D3.1 A)
- V2-03 evidence: `docs/superpowers/evidence/2026-10-11-opening-release/v2-03-activity-compat-adr-implement.md`
- V2-03 accept note (0048 wording): `…/v2-03-activity-compat-adr-accept.md`
- Plan: `docs/superpowers/plans/ai-led-learning-v2/plan.md` §6.1, V2-04
- Task: `docs/superpowers/plans/ai-led-learning-v2/tasks.json` → V2-04
- Migrations: `0019`, `0028`, `0037`, `0038`, `0030`, `0048` (`opening_course_knowledge`), `0049`
- Facts/backup: `opening-learning-facts.ts`, `opening-backup-records.ts`
- Contracts: `packages/contracts/src/opening/learning.ts`
