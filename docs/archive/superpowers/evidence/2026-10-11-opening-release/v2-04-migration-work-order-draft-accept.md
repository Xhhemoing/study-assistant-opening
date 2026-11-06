# V2-04 accept — Migration work-order DRAFT readiness

**Date:** 2026-10-11 (Asia/Shanghai / CST)  
**Agent:** Integrator ACCEPT (executor)  
**Baseline tip:** `1a4cf465c86da7f08b6fda3044f9b0f932b80824`  
**Branch:** `feat/opening-release`  
**Task:** V2-04 — migration / work-order **DRAFT only** (teaching activity context)  
**Verdict:** **ACCEPT** (draft readiness)

## Scope of this accept

Accept of `docs/superpowers/plans/ai-led-learning-v2/v2-04-migration-work-order-draft.md` as a **complete migration work-order draft** against ADR D1–D8, Paula embed constraints, and plan/tasks V2-04.

**This ACCEPT is draft readiness only.** It is **not** authorization to run ALTER, migrate, land product/contracts code, or open the V2-04 implement slice. Execute remains blocked until M0 green + explicit PM implement approval (§10 of the draft).

## Inputs reviewed

| Artifact | Role |
|---|---|
| `docs/superpowers/plans/ai-led-learning-v2/v2-04-migration-work-order-draft.md` | Draft under review |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-04-migration-work-order-draft.md` | Implement prep evidence |
| `docs/decisions/ADR-teaching-activity-context.md` | D1–D8; PM design-approved; option A |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-03-activity-compat-adr-accept.md` | Prior ADR accept + 0048 wording |
| `docs/superpowers/plans/ai-led-learning-v2/plan.md` §6.1 / §6.3 / §6.4 / V2-04 | Scope, dual-track, status split, APIs |
| `docs/superpowers/plans/ai-led-learning-v2/tasks.json` V2-04 | Acceptance / verification / rollback |
| `docs/plans/2026-10-11-ai-led-learning-v2.md` | G3/G6/G8 + Paula embed |
| Migrations / facts / backup / contracts (read-only spot-check) | Schema + auth reality at tip |

## ADR D1–D8 + Paula embed mapping

| Decision | Draft coverage | Accept |
|---|---|---|
| **D1** identity = workspace+owner+activityId; course optional; no ghosts; associate pointer only | §1, §2.1 `course_id` NULL + ON DELETE SET NULL; associate UPDATE activity only; forbidden sentinel | Pass |
| **D2** body stays library; activities = meta/index | §2.1 “no teaching body”; V2-05 deferred §9 | Pass |
| **D3** single facts path; v1 course required; v2 nullable + `activity_id`; skill_evidence/retest M1 policy | §3.1–3.2, §5 dual contracts | Pass |
| **D3.1 A** activity history revisions PK; course counter untouched | §2.2 `opening_learning_activity_history_revisions`; write-path table | Pass |
| **D4** no parallel scoring / Episode as fact | Out of scope §1; deferred §9 | Pass |
| **D5** counterexamples (auth, summary, archive, associate, old client) | §8 cases 1–6, 10 (+ V2-04 clientKey/source/cross-owner) | Pass |
| **D6** backup day one; flag rollback keep data; no DROP; no irreversible correct/independent backfill | §6, §7 | Pass |
| **D7** Paula embed: Today 继续/开始学习; not standalone shell | §1 goal; §10.7 approval gate | Pass |
| **D8** no ALTER in this slice | Hard gate §0/§10/§12; tree check below | Pass |

## Stronger review (completeness / contradictions / no ALTER)

### ALTER list vs ADR D3 + live schema

| Claim | Spot-check | Result |
|---|---|---|
| sessions/observations `course_id NOT NULL` (0019) → DROP NOT NULL + `activity_id` | 0019 L9, L53 | Match; draft §3.1 |
| attempts + item_versions `course_id NOT NULL` (0028) → same pattern | 0028 L8, L17 | Match |
| history_revisions PK includes `course_id` → **no change** (option A) | 0028 L1–4 | Match; new table instead |
| skill_evidence / retest stay course-required M1 | 0049 / 0030 NOT NULL FK | Match §3.2 |
| 0048 = `opening_course_knowledge` course-scoped; not nullable in this wave | 0048 CREATE `opening_course_knowledge`; PK `(workspace_id, course_id)` | Match §11 |
| help_exposures optional companion | 0019 has no `course_id` on help_exposures | Match deferral |
| Indexes `(workspace, activity)` + eligibility repair callout | ADR D3/D5 #6 | Present §3.1 / §3.4 |

**Sequencing note (non-blocking for draft, required at implement):** §3.1 end-state wording `ADD activity_id UUID NOT NULL` is only safe after §3.3 backfill (A1 synthetic activities, or A2 phased nullable → SET NOT NULL). Draft already flags this; implement DDL must not apply blind NOT NULL on populated tables.

### Auth rewrite vs code seams

| Seam | Code | Draft |
|---|---|---|
| `assertOwnedCourse` | `opening-learning.ts` L35; `read-service.ts` L17/21; `tutor-actions.ts` L326 | Keep v1; ban on no-course paths §4 |
| `lockLearningSession` JOIN courses + `archived_at IS NULL` | `opening-learning-facts.ts` L28–32 | Branch to activity ownership §4 |
| `nextLearningHistoryRevision` course conflict key | facts L43+ | v2 activity helpers against option A §4 |
| Cross-owner reject + archive must not kill activity I/O | ADR D5 #3 | §4 + tests 3, 7 |

### Revision table A

DDL sketch PK `(workspace_id, owner_user_id, activity_id)`; v1 course counter untouched; associate does not merge/replay revisions; sentinel / nullable PK course_id forbidden. Aligns with ADR D3.1 **A** and PM design approval.

### Backup / rollback / dual contracts

| Item | Check | Result |
|---|---|---|
| New tables must join `OPENING_BACKUP_TABLES` day one | Current list L7–15 has sessions/observations/attempts/history/workspace_history; **no** skill_evidence / eligibility / course_knowledge | Draft §6 correct; open Q carried |
| Rollback: flag off, retain data, no DROP, no irreversible polish | Task rollback + ADR D6 | §7 Pass |
| v1 contracts keep required `courseId` | `learning.ts` observation/session/retest required (V2-03 accept) | §5.1 Pass |
| v2 field sketch only; product files not created | `teaching-activity.ts` / repos / activity-service **absent** | Pass |

### Anti-examples / verification vs tasks.json

Draft §8 covers ADR D5 (1–6) plus V2-04 verification: clientKey replay/409, cross-owner, associate no move/copy, source accessibility. Matches tasks.json verification + acceptance (free-start, old course entry, export/restore via backup scope).

**Minor non-blocking gap:** task verification says「无课程创建/**恢复**」; draft has `intent_kind=resume` + checkpoint stub and create tests, but no numbered case titled “resume existing no-course activity.” Acceptable for draft; implement should add an explicit resume/restore case.

### Paula embed

Charter + ADR D7 require Today「继续学习 / 开始学习」entry, not a bypass app. Draft §1 + §10.7 require PM confirm of that embed. Live UI still has「继续学习」in `today-resume-view.tsx`. Pass for draft.

### No ALTER / no product land in tree

| Check | Result |
|---|---|
| New migration files `*teaching*activity*` under `packages/database/src/migrations/` | **None** (latest numbered 0052) |
| Product paths from plan (contracts / repo / activity-service) | **Do not exist** |
| `git status` `packages/database/src/migrations/` | Clean |
| `packages/` / `apps/` dirty unrelated to this draft | `material-library.tsx` / `use-material-library.ts` modified — **out of scope**; not migration SQL |
| Untracked for this slice | Draft + evidence docs under `docs/…` (plus pre-existing plan/ADR docs) |
| `psql` / migrate runner / applied ALTER | Not indicated; draft text-only sketches |

**Confirmed: no ALTER executed in this slice.**

## ADR subsequent #2 checklist (work-order must attach)

| Required attachment | Present in draft |
|---|---|
| Full ALTER list | §3 |
| Auth rewrite scope | §4 |
| History option A DDL | §2.2 |
| Backup table registration | §6 |
| Rollback flags | §7 |
| Counterexample tests | §8 |

All present → draft satisfies ADR follow-up #2 as a **checklist document**, not as execute auth.

## Open gaps for PM (do not block draft ACCEPT; block execute)

1. **Backfill A1 vs A2** for existing-row `activity_id` (§3.3) before any NOT NULL land.  
2. **Retest-without-course:** defer task-type retests (M1 default) vs same-wave nullable FK on `opening_retest_activities`.  
3. **`opening_skill_evidence` (+ optional eligibility)** fold into `OPENING_BACKUP_TABLES` in the same approved batch?  
4. **Open V2-04 implement slice** only after **M0 green** (V2-01 CI + V2-02 AI fixtures). V2-02 accept evidence exists in this dir; **V2-01 CI evidence not present here** — treat M0 as still an implement gate, not a draft defect.  
5. Confirm Paula product entry remains Today continue/start + activity stream (§10.7).  
6. Assign migration number(s) against live `schema_migrations` (placeholder `00xx` correct; tip migrations end at 0052).

## Verdict rationale

The work-order draft is complete and consistent with the PM-approved ADR (D1–D8, revision-key A), plan §6.1/V2-04, and Paula embed constraints. ALTER/auth/revision-A/backup/rollback/anti-example attachments required by ADR后续 #2 are present. Schema claims match tip migrations and backup list; dual-track and no-ghost-course rules are explicit; open PM decisions are correctly left open rather than invented. No migration or product schema was landed.

**ACCEPT** as **draft readiness**.

**NOT** migration execute authorization. **NOT** approval to ALTER, migrate, commit product code, or treat design approval as implement open.

## Explicit non-actions by accept agent

- Did not edit the draft body, ADR, `tasks.json`, product code, or SQL  
- Did not commit / push / stash / reset  
- Did not run migrations, `psql`, or approve V2-04 implement execution  

## Evidence paths

- Accept (this file): `docs/superpowers/evidence/2026-10-11-opening-release/v2-04-migration-work-order-draft-accept.md`  
- Draft: `docs/superpowers/plans/ai-led-learning-v2/v2-04-migration-work-order-draft.md`  
- Prep evidence: `docs/superpowers/evidence/2026-10-11-opening-release/v2-04-migration-work-order-draft.md`  
- ADR: `docs/decisions/ADR-teaching-activity-context.md`
