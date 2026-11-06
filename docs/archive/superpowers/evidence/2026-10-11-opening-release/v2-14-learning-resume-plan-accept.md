# V2-14 Learning resume — Plan ACCEPT

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Reviewer:** AIstudy Integrator (executor / Grok Bot) — **≠** plan author (AIstudy Data)  
**Stage:** Plan ACCEPT only — **no product Implement · no ALTER · no migration SQL create · no commit / push / hermes / stash / reset**  
**Branch:** `feat/opening-release`  
**Tip HEAD at Accept:** `a8eb1937abd901691c4a926fa95f0832fe0aa584` (`a8eb193`)  
**Data Plan tip claim:** `a8eb193` — **exact match** (no tip drift)  
**Verdict:** **ACCEPT**  
**Gates:** `docs/superpowers/plans/opening-release/review-test-gates.md` + delivery-loop stronger Plan review  
**Data handoff / PM locks encoded:** tip `a8eb193`; no product / no DDL / Data does not self-ACCEPT; **DDL: NO** (nest `checkpoint_json`; derive open problems); Data slice = LearningResume contracts/domain + resume-service + GET resume / POST checkpoint; Experience resume-card OOS until after Plan ACCEPT then UI half; summary does not block resume; server authoritative; permission / materials / unknown-job gates

## Authority / inputs read (full)

| Doc | Role |
|---|---|
| `docs/superpowers/plans/ai-led-learning-v2/v2-14-learning-resume-plan.md` | Plan under review |
| `docs/superpowers/plans/ai-led-learning-v2/v2-14-learning-resume-understand.md` | Understand |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-14-learning-resume-understand.md` | Understand-stage evidence (Data) |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-14-learning-resume-plan-implement.md` | Plan-stage claim evidence (Data; **not** self-ACCEPT) |
| `docs/superpowers/plans/opening-release/review-test-gates.md` | Gates |
| `docs/superpowers/plans/ai-led-learning-v2/plan.md` §V2-14 (L605–623) + §6.3 checkpoint | Authority |
| Style: `v2-13-teaching-answer-evidence-plan-accept.md` | Accept sample |

## Tip / tree verification

```text
$ git rev-parse HEAD
a8eb1937abd901691c4a926fa95f0832fe0aa584

$ git rev-parse --short HEAD
a8eb193

$ git branch --show-current
feat/opening-release

$ git log -1 --oneline
a8eb193 feat(opening): V2-13 teaching/answer evidence semantics (0057)

$ ls packages/database/src/migrations/*.sql | sort | tail -3
0055_opening_compile_teaching_unit_job.sql
0056_opening_intervention_settings.sql
0057_opening_help_exposure_kind.sql

$ ls packages/database/src/migrations/0058* 2>/dev/null || echo 'no 0058 migr'
no 0058 migr

$ test ! -f apps/web/src/features/opening/teaching/resume-service.ts && echo RESUME_SERVICE_ABSENT
RESUME_SERVICE_ABSENT

$ test ! -f apps/web/src/features/opening/teaching/resume-card.tsx && echo RESUME_CARD_ABSENT
RESUME_CARD_ABSENT

$ test ! -f packages/contracts/src/opening/teaching-resume.ts && echo CONTRACT_RESUME_ABSENT
CONTRACT_RESUME_ABSENT

$ test ! -f packages/domain/src/opening/teaching-resume.ts && echo DOMAIN_RESUME_ABSENT
DOMAIN_RESUME_ABSENT

$ date '+%Y-%m-%d %H:%M %Z'
2026-10-11 13:22 CST
```

### Untracked V2-14 docs (expected; no invent commits)

```text
?? docs/superpowers/plans/ai-led-learning-v2/v2-14-learning-resume-understand.md
?? docs/superpowers/plans/ai-led-learning-v2/v2-14-learning-resume-plan.md
?? docs/superpowers/evidence/2026-10-11-opening-release/v2-14-learning-resume-understand.md
?? docs/superpowers/evidence/2026-10-11-opening-release/v2-14-learning-resume-plan-implement.md
(+ this accept file after write)
```

Other untracked evidence (`rp5-gha-…`, `p0-assistant-list-…`) **not** part of V2-14; left untouched.

**Result:** Accept tip `a8eb193` equals Data baseline. No V2-14 product code / no DDL file / Data did **not** self-ACCEPT. Migrations tip ends **0057**; **no** `0058` on disk.

## DDL decision

| Item | Value |
|---|---|
| DDL needed? | **NO** |
| Why | Official breakpoint nests in existing `opening_teaching_activities.checkpoint_json` (JSONB, 0053); `status` already includes `paused`; `content_version` / `path_version` / `generate_status` (incl. `unknown`) already present; attempts/observations/help already carry `activity_id` (0053 / 0057); open problems **derive** from fact heads — no new table required |
| Rejected | Parallel `opening_learning_resume` table; new columns per field; invent migr `0058` |
| Placeholder if later | `00xx_…` only if Integrator later demands indexed open-problems table — **not** assigned this Accept |
| Latest numbered migr on tip | `0057_opening_help_exposure_kind.sql` |
| This Accept | Does **not** create SQL; does **not** assign a migration number |

## PM / authority locks checklist

| Lock / handoff | Plan location | Match? |
|---|---|---|
| Breakpoint = content version + block/params + drafts + attempts + help + open problems | §1.3 r2; LearningResume sketch | **YES** |
| Summary may fail; resume + draft save independent | §1.3 r4; T6; rejected require-summary | **YES** |
| Server authority; local = unsent drafts only | §1.3 r5; no teaching localStorage inventory | **YES** |
| Permission / materials / unknown jobs | §1.3 r6; gates on DTO; T2/T10–T12 | **YES** |
| Not chat window (`ConversationResume`) | §1.3 r7; T16; rejected chat-only | **YES** |
| Nest activity/checkpoint; no parallel product | §1.3 r1; §4 DDL NO; rejected parallel table | **YES** |
| No push/hermes | Hard rules / OOS / Implement gate | **YES** |
| Experience resume-card OOS for Data Implement | §1.4; §6; files preview | **YES** |
| `read-service.ts` pattern ref only; new teaching resume-service | §1.3 r13; §5; files preview | **YES** |
| plan.md §6.3 `POST .../checkpoint` | Routes table | **YES** |

## Stronger review — claim-by-claim vs tip code

### 1. `checkpoint_json` nest works; no new table required

- Migration **0053**: `checkpoint_json JSONB NOT NULL DEFAULT '{}'`; `status` CHECK includes `paused`; `generate_status` includes `unknown` / `queued` / `generating` / `stale`; `content_version` / `path_version` present.
- Backup paths already list activity `checkpoint_json` — Plan backup note sound (no new table registration for M1).
- Existing checkpoint keys in use: `drafts` (V2-05), `branchStack` / `commandLog` / `currentBlockId` / `skippedBlockIds` (V2-12), `interventionPrefs` / `interventionDecisions` (V2-11). Nesting `interactionParams` / optional `openProblemIds` is JSONB-only — **DDL NO justified**.

### 2. Existing attach points named accurately; NEW marked NEW

| Claim | Tip check |
|---|---|
| `assertOwnedActivity` | **EXISTS** — `opening-teaching-activities.ts` L37–50; other owner → NOT_FOUND |
| `getClientInit` + `sanitizeCheckpointForRestore` | **EXISTS** — content repo; strips answerKeys/solutions/unrevealedAnswers; nulls answer_key content |
| `saveDraftAnchors` CAS + `draft_anchor_lost` | **EXISTS** — expectedVersion CAS; lost blockIds keep prior drafts |
| `mergeCheckpointPreservingPrefs` / `TEACHING_COMMAND_CHECKPOINT_KEYS` | **EXISTS** — domain teaching-commands; preserves prefs via `{...prev}` + selective patch |
| `admitLearningSources` (privacy / chunks) | **EXISTS** — throws VALIDATION “source unavailable or privacy-excluded” |
| `helpExposureKindSchema` + help `activity_id` write | **EXISTS** (V2-13 / 0057); insert includes kind/activity_id/item_version_id |
| Activity-scoped help/attempt **list** helpers | **ABSENT** — correctly Plan NEW |
| `setStatus` / pause API | **ABSENT** — repo has `setGenerateStatus` only; activity-service create/get/list/associate only — correctly NEW |
| HTTP GET resume / POST checkpoint / draft-anchors | **ABSENT** — only `teaching-activities/[id]/client-init` + `teaching/activities/[id]/commands` (+ chat `conversations/[id]/resume`) |
| OpeningApi resume/checkpoint helpers | **ABSENT** — has `getTeachingClientInit` + `postTeachingCommand` + `resumeConversation` (chat) only |
| `teaching-resume` contracts/domain | **ABSENT** — correctly NEW |
| `resume-service.ts` / `resume-card.tsx` | **ABSENT** — service Data NEW; card Experience OOS |
| Teaching `localStorage` for drafts | **NONE** — inventory matches lock 3 |
| `buildConversationResume` | **EXISTS** as tutor chat only — Plan correctly forbids reuse as teaching resume |
| `summarizeLearning` on `read-service.ts` | **EXISTS** course-scoped — Plan leaves unchanged; resume must not call it |

**No invented “already exists” APIs.** Gaps (list helpers, setStatus, HTTP, resume DTO/service) accurately marked NEW.

### 3. Disjoint checkpoint keys / CAS / sanitize

- V2-11 prefs and V2-12 command keys must survive resume patch — Plan §1.3 r8 + T9; proposes `mergeCheckpointResumePatch` (NEW) in same spirit as `mergeCheckpointPreservingPrefs`.
- Writes require `expectedVersion` (= content_version) — reuses V2-05/V2-12 CAS pattern; T7 forces CONFLICT no LWW.
- Read path always `sanitizeCheckpointForRestore` — T5.

### 4. Resume gates / summary independence / not chat

- Permission → `assertOwnedActivity` (T2).
- Materials → soft probe of `sourceIds` → `available|partial|unavailable` (Plan correctly does **not** reuse throwing `admitLearningSources` as the sole UX path; assemble must fail-soft — Implement detail; soft gap below).
- Job gate maps `generateStatus` queued/generating → `in_flight`, unknown → `unknown`, stale → `stale` (T10/T11); drafts preserved.
- Summary optional / skipped; assemble must not call summarize (T6).
- Continuable actions mirror teaching commands + wait_job / resolve_material — not “open last chat” (T14/T16).

### 5. Ownership / OOS / acyclic deps

| Surface | Plan | Tip check |
|---|---|---|
| Data: contracts / domain teaching-resume / repos setStatus+list / resume-service / routes / OpeningApi | Owner | Paths NEW or extend existing Data trees |
| Experience: `resume-card.tsx` + Workspace continue | **OOS** until after Plan ACCEPT | Correctly deferred |
| `read-service.ts` / tutor conversation resume | Untouched | Boundaries clear |
| V2-15 matrix / interactionParams semantics | Reserve key only | Correct |
| Migration number | None needed; rejects invent `0058` | Matches process |

Dependencies acyclic (contracts → domain → database → web service/routes → OpeningApi helpers; Experience consumes later). No Experience/AI dual-edit of exclusive trees in this Plan slice.

### 6. Tests cannot pass without required behavior

| Requirement | Tests that force it |
|---|---|
| LearningResume parse / required fields | T1 |
| Ownership NOT_FOUND | T2 |
| Assemble includes versions + drafts + attempts + help + openProblems | T3 |
| Thought train restored | T4 |
| Sanitize hides answer keys | T5 |
| Summary independence | T6 |
| Draft CAS stale → CONFLICT | T7 |
| draft_anchor_lost retains prior drafts | T8 |
| interactionParams patch preserves prefs + commandLog | T9 |
| jobGate in_flight / unknown | T10 / T11 |
| materials unavailable | T12 |
| Open problems derived | T13 |
| command_return iff branchStack non-empty | T14 |
| setStatus paused↔active; complete ≠ mastery | T15 |
| Resume ≠ ConversationResume | T16 |
| Route auth + zod | T17 |
| No spurious migration when DDL=NO | T18 |

Plan-stage: **T1–T18 all `not_run`** (honest). No greenwashing at Plan gate.

### 7. Rejected alternatives

Plan rejects chat-only resume, parallel resume table, require-summary, local official state, silent LWW, stuffing into intervention ring, overloading course summarize, Data implementing resume-card, inventing migr `0058`, inferring mastery from resume, blocking resume entirely when job unknown — **all match plan.md §V2-14 / PM locks**.

## Soft gaps (non-blocking)

1. **Dual route prefixes** — tip already has `teaching-activities/...` (client-init) and `teaching/activities/...` (commands). Plan proposes GET/POST under `teaching/activities/{id}/…` and optionally PATCH under `teaching-activities/{id}/status`. Implement should **pick one consistent prefix** (prefer `teaching/activities/{id}/…` to match commands) and document aliases if needed — not a Plan REJECT.
2. **Materials probe vs throwing admit** — `admitLearningSources` throws on any missing/excluded id. Resume assemble needs a **non-throwing** availability probe for `partial`/`unavailable` gates (T12). Plan intent clear; Implement must add soft probe helper (domain/repo) without inventing a second admission product.
3. **Open-problem derive rules** — Plan default derive from incorrect/unverified/open attempts; exact “head” semantics left to Implement + T13. Optional `openProblemIds` cache non-authoritative — do not silently drop facts.
4. **`mergeCheckpointResumePatch` vs reuse** — may extend `mergeCheckpointPreservingPrefs` or add sibling; must preserve V2-11 + V2-12 keys when writing `interactionParams`/`drafts`/`openProblemIds`.
5. **Status PATCH path naming** — thin active↔paused in same Data slice is correct (column exists); confirm OpeningApi + route land with CAS/`expectedUpdatedAt` as sketched.
6. **Command log truncate** — Plan says last 32 (= `TEACHING_COMMAND_LOG_MAX`); already the ring max — fine.

None contradict PM locks or force inventing APIs / DDL.

## Gate compliance

| Gate | This Accept |
|---|---|
| Stronger review vs plan/understand/PM/code | Done |
| Tip / SHA named | `a8eb193` (exact Data baseline) |
| Product Implement / ALTER / SQL create | **None** |
| Migr number assign | **None** (DDL NO) |
| Re-run Implement tests | **N/A** — Plan stage; T1–T18 remain `not_run` |
| Self-ACCEPT of Implement | N/A (Plan ACCEPT only); Data did not self-ACCEPT |
| tasks.json verified flip | **Not done** |
| Push / hermes / commit | **Not done** |

## Verdict

**ACCEPT** Plan `v2-14-learning-resume-plan.md`.

- **DDL:** **NO** — nest `interactionParams` (+ optional non-authoritative `openProblemIds`) in existing `checkpoint_json`; derive open problems from activity-scoped attempts/observations/help; thin `setStatus` is code-only on existing `status` column.
- **recommended_migr:** **none** (tip remains **0057**; do not invent `0058`).
- Ready for separate **Data Implement** after this Accept: contracts `teaching-resume` → domain helpers (derive/gates/merge/summary-independence) → repo `setStatus` + activity-scoped list helpers → `resume-service.ts` → GET resume / POST checkpoint (+ status) → OpeningApi helpers → T1–T18 → Implement evidence per gates.
- **Experience** `resume-card.tsx` / Workspace continue remains deferred (UI half after contracts stable).
- This Accept does **not** authorize ALTER, product code, migration create, commit, push, or hermes.

## Blockers / open decisions for PM

**None blocking ACCEPT.** Plan defaults match Data handoff + plan.md §V2-14. Escalate only if Paula rejects a default (derive-only open problems; include pause in Data slice; optional summary field on DTO; route prefix preference).

## not_run (honest)

All Plan Implement tests **T1–T18**: `not_run` (Plan stage — correct). No unit/typecheck/integration re-run applicable until Implement.
