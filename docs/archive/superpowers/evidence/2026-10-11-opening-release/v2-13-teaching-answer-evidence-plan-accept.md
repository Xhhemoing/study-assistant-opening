# V2-13 Teaching & answer evidence — Plan ACCEPT

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Reviewer:** AIstudy Integrator (executor / Grok Bot) — **≠** plan author (AIstudy Data)  
**Stage:** Plan ACCEPT only — **no product Implement · no ALTER · no migration SQL create · no commit / push / hermes / stash / reset**  
**Branch:** `feat/opening-release`  
**Tip HEAD at Accept:** `e85a73bff8df93de254e68c5286721860c6723e1` (`e85a73b`)  
**Data Plan tip claim:** `9a508a72d16b23b70c6aa3701ff35348ce18c3f0` (`9a508a7`) — **ancestor** of Accept tip (one later commit: `e85a73b` V2-12 teaching-commands browser-safe `node:crypto` fix; **not** V2-13 product)  
**Verdict:** **ACCEPT**  
**Gates:** `docs/superpowers/plans/opening-release/review-test-gates.md` + delivery-loop stronger Plan review  
**PM frozen defaults (steering):** DDL YES (`kind` NOT NULL + backfill `hint`; nullable `activity_id`; prefer nullable `item_version_id`); `unknown` ≡ wire `unverified`; delete default `transfer`; omit dimension → no SkillEvidence; complete activity ≠ mastery; no parallel mastery; no push/hermes

## Authority / inputs read (full)

| Doc | Role |
|---|---|
| `docs/superpowers/plans/ai-led-learning-v2/v2-13-teaching-answer-evidence-plan.md` | Plan under review |
| `docs/superpowers/plans/ai-led-learning-v2/v2-13-teaching-answer-evidence-understand.md` | Understand |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-13-teaching-answer-evidence-understand.md` | Understand-stage evidence (Data) |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-13-teaching-answer-evidence-plan-implement.md` | Plan-stage claim evidence (Data; **not** self-ACCEPT) |
| `docs/superpowers/plans/opening-release/review-test-gates.md` | Gates |
| `docs/superpowers/plans/ai-led-learning-v2/plan.md` §V2-13 (L585–603) | Authority |
| Style: `v2-12-teaching-commands-plan-accept.md` / `v2-11-intervention-prefs-plan-accept.md` | Accept sample |

## Tip / tree verification

```text
$ git rev-parse --short HEAD
e85a73b

$ git rev-parse HEAD
e85a73bff8df93de254e68c5286721860c6723e1

$ git branch --show-current
feat/opening-release

$ git log --oneline -3
e85a73b fix(domain): keep teaching-commands browser-safe (no node:crypto)
9a508a7 feat(opening): V2-12 teaching command controls UI
06b4747 feat(opening): V2-12 teaching commands (Data half)

$ git merge-base --is-ancestor 9a508a7 HEAD && echo '9a508a7 is ancestor of HEAD'
9a508a7 is ancestor of HEAD

$ ls packages/database/src/migrations/*.sql | sort | tail -3
0054_opening_teaching_content.sql
0055_opening_compile_teaching_unit_job.sql
0056_opening_intervention_settings.sql

$ ls packages/database/src/migrations/0057* 2>/dev/null || echo 'no 0057 migr'
no 0057 migr

$ test ! -f packages/domain/src/opening/teaching-exposure.ts && echo ABSENT
ABSENT

$ date '+%Y-%m-%d %H:%M %Z'
2026-10-11 13:03 CST
```

### Untracked V2-13 docs (expected; no invent commits)

```text
?? docs/superpowers/plans/ai-led-learning-v2/v2-13-teaching-answer-evidence-understand.md
?? docs/superpowers/plans/ai-led-learning-v2/v2-13-teaching-answer-evidence-plan.md
?? docs/superpowers/evidence/2026-10-11-opening-release/v2-13-teaching-answer-evidence-understand.md
?? docs/superpowers/evidence/2026-10-11-opening-release/v2-13-teaching-answer-evidence-plan-implement.md
(+ this accept file after write)
```

Other untracked evidence (`rp5-gha-…`, `p0-assistant-list-…`) **not** part of V2-13; left untouched.

**Result:** Accept tip `e85a73b` (Data wrote at `9a508a7`). No V2-13 product code / no DDL file / Data did **not** self-ACCEPT. Migrations tip ends **0056**; **no** `0057` on disk.

## Migration-number status

| Item | Value |
|---|---|
| DDL needed? | **YES** |
| Why | Persist `kind` (+ optional `activity_id` / prefer `item_version_id`) on `opening_help_exposures` so help survives sessions & eligibility rebuild; checkpoint-only rejected |
| Placeholder in Plan | `00xx_opening_help_exposure_kind.sql` — **Integrator assigns** (Plan rejects inventing `0057` inside Implement) |
| Latest numbered migr on tip | `0056_opening_intervention_settings.sql` |
| **Recommended next** | **`0057`** |
| This Accept | Does **not** create SQL; status = **pending Integrator assign after ACCEPT** |

## PM frozen defaults checklist

| Frozen default | Plan location | Match? |
|---|---|---|
| DDL YES: `kind` NOT NULL + backfill `hint` | §4, §8, open Q4 | **YES** |
| nullable `activity_id` | §4 columns; open Q4 | **YES** |
| prefer nullable `item_version_id` | §4 optional; open Q6 Plan default nullable if Integrator OK | **YES** (aligned; Integrator confirms at assign) |
| `unknown` ≡ wire `unverified` (no rename) | §1.3 r6; rejected alts; open Q1 | **YES** |
| Delete default `transfer` | §1.3 r8; retest sketch; rejected keep-default | **YES** |
| Omitting dimension → no SkillEvidence | §1.3 r8; open Q2 | **YES** |
| Completing activity ≠ mastery | §1.3 r12; T10; rejected auto-link | **YES** |
| No parallel mastery model | §4 rejects parallel table; ADR D4; nest | **YES** |
| No push/hermes | Hard rules / OOS / Implement gate | **YES** |

## Stronger review — claim-by-claim vs tip code

### 1. `opening_help_exposures` exists; no `kind` / no `activity_id`

- **0019** `CREATE TABLE opening_help_exposures` — `level` CHECK (`hinted`,`revealed`), `delivered=TRUE`, `problem_id` nullable; **no `kind`**.
- **0028** adds `attempt_id`, `delivered_at`, `history_revision` only.
- **0053** adds `activity_id` to sessions / observations / attempts / item_versions — **`rg` confirms 0053 does NOT mention `opening_help_exposures`**.
- Repo `opening-learning-help.ts` INSERT columns: id, workspace_id, session_id, problem_id, turn_id, level, delivered, attempt_id, delivered_at, history_revision — **no kind**.
- Contract `helpExposureSchema` (`learning.ts` L81–94): session/attempt/problem + level + delivered — **missing kind** (Plan correctly marks NEW).
- Backup lists already include `opening_help_exposures` (compose/apply/empty-namespace) — Plan backup note sound.

**Claim grounded. DDL extend is necessary.**

### 2. Instruction pollution vector (tutor-turn)

- `apps/worker/src/jobs/tutor-turn.ts` L206–217: mode ∈ {hint, explain} → exposure with **`problemId: null`**, level explain→revealed / hint→hinted.
- `evaluateAssistance` (`evidence-eligibility-timing.ts`): no kind filter; null problemId → `help_association_unknown`; same-attempt help elevates assisted.
- `resolveAssistance` (`assistance.ts`): elevates by exposure **levels only** — no kind.

**Plan rule instruction ≠ item help + `exposuresAffectingItemAssistance` filter + classifyTutorHelpKind — grounded; NEW domain module correctly marked ABSENT.**

### 3. Outcomes / unknown / course APIs

- `observationOutcomeSchema` = `correct` \| `incorrect` \| `unverified` — confirmed.
- `observationInputSchema.courseId` **required** — confirmed.
- `learningSummarySchema` includes `needs_check`, `unverifiedCount`, `historicalIncorrectCount` — confirmed (domain summary computes both).
- `activityObservationInputSketchSchema` exists (sketch; activityId required; courseId optional) — Plan additive adapter → same tables; course v1 unchanged — **aligned**.
- `verdictSourceSchema` keeps `self_report` / `model_suggestion` distinct — Plan T13 — **aligned**.

**No invented rename of unverified; no fork answer table.**

### 4. Remove delayed default transfer

- `RETEST_CLOSE_DEFAULT_DIMENSION = "transfer"` at `retest-close-evidence.ts` L8–9.
- `prepareRetestSkillLink` L67: `dimension: input.dimension ?? RETEST_CLOSE_DEFAULT_DIMENSION`.
- Consumer `attempt-service.ts` L92–98 calls **without** `dimension` → today silently links **transfer**.

**Exact PM target. Plan: omit dimension → return null; callers must pass explicit dimension — matches frozen default. T7/T8 force behavior.**

### 5. SkillEvidence / mastery honesty

- `opening-skill-evidence.ts`: `link` / `linkOpeningSkillEvidenceInTx` / `flagsForNode` — course-scoped projection; **no** activity-complete → link API.
- Observations insert links SkillEvidence only when nodeId+dimension together.
- Teaching activity status includes `completed` (progress) — Plan `assertActivityCompleteDoesNotUpgradeMastery` NEW guard — correct (does not invent parallel mastery table).
- `observationAllowsIndependent` / missing problemId → never independent — confirmed.

**Nest existing model; complete ≠ mastery; needs_check preserved — aligned.**

### 6. Stable identity / same-item survives session

- Eligibility keys problemId + attempt timing; prior `revealed` on same problem → `prior_answer_exposure` (L64–68 timing) — confirmed.
- Version applicability enums include `changed_needs_check` / `version_unknown` — Plan T14 — aligned.
- Plan does **not** invent “new UUID = new situation” — matches PM lock 3 / plan.md verify bullets.

### 7. Ownership / OOS / acyclic

| Surface | Plan | Tip check |
|---|---|---|
| Data: contracts / teaching-exposure / retest / eligibility / help repo | Owner | Paths exist or marked NEW |
| Worker tutor-turn | Thin field pass only; no orchestration rewrite | Pollution at L206–217 only needs kind+bind |
| Experience UI | **OOS** this slice | Correct |
| V2-06 citations / V2-12 skip | Untouched | Boundaries clear |
| Migration number | Integrator-only; rejects invent `0057` in Implement | Matches process |

Dependencies acyclic (Data → contracts/domain/repo; worker consumes; Experience later). No Experience/AI dual-edit of exclusive trees in this Plan slice.

### 8. Tests cannot pass without required behavior

| Requirement | Tests that force it |
|---|---|
| kind required / unknown kind reject | T1 |
| instruction ignored for different problem | T3 |
| prior solution survives new session | T4 |
| no problemId → not independent; unverified → needs_check path | T5 |
| incorrect stays in historicalIncorrect denominator | T6 |
| omit dimension → null (no transfer default) | T7 |
| explicit transfer still links when eligible | T8 |
| activity complete forbids mastery side effects | T10 |
| courseId still required | T11 |
| history missing kind → hint; never backfill independent/correct/transfer | T15 |
| no parallel mastery table after Implement | T18 |

Plan-stage: **T1–T18 all `not_run`** (honest). No greenwashing at Plan gate.

### 9. Rejected alternatives / invented constraints

Plan rejects parallel mastery, unverified→unknown rename, keep transfer default, infer transfer from delayed, claim read from scroll, activity→SkillEvidence, invent migr `0057`, Experience UI this slice, reopen V2-12 skip — **all match PM / charter**. No invented soft self-report mastery path.

## Soft gaps (non-blocking)

1. **Tip advanced** `9a508a7` → `e85a73b` after Data Plan write (V2-12 `node:crypto` browser-safe). V2-13 surfaces unchanged; Accept records actual tip.
2. **`item_version_id` on help** — Plan default nullable if Integrator OK; PM prefers it — Integrator should include nullable `item_version_id` when assigning **0057** unless cost blocks (then join-only + document).
3. **Tutor mapping defaults** (explain∧¬problem → instruction, etc.) — Plan open Q5; Implement must encode in `classifyTutorHelpKind` + T2/T16; worker thin only.
4. **Sketch typo** `assertNoUnavidencedIndependence` / `Read` (missing letters) — cosmetic; Implement uses clear names.
5. **course_id nullable on observations** — correctly OOS (ADR/V2-04 track); Plan keeps courseId required for same-table insert until ADR lands.
6. **Backup column registration** when `activity_id`/`kind`/`item_version_id` added — Plan notes Implement must update backup table lists; do not skip.

None contradict PM locks or force inventing APIs.

## Gate compliance

| Gate | This Accept |
|---|---|
| Stronger review vs plan/understand/PM/code | Done |
| Tip / SHA named | Accept tip `e85a73b`; Data baseline `9a508a7` ancestor |
| Product Implement / ALTER / SQL create | **None** |
| Re-run Implement tests | **N/A** — Plan stage; T1–T18 remain `not_run` |
| Self-ACCEPT of Implement | N/A (Plan ACCEPT only); Data did not self-ACCEPT |
| tasks.json verified flip | **Not done** |
| Push / hermes / commit | **Not done** |

## Verdict

**ACCEPT** Plan `v2-13-teaching-answer-evidence-plan.md`.

- **DDL:** **YES** — extend `opening_help_exposures` with `kind` NOT NULL (backfill `'hint'`), nullable `activity_id`, prefer nullable `item_version_id`.
- **recommended_migr:** **`0057`** (confirm still next after `0056`; **pending Integrator assign** — this Accept does not write SQL).
- Ready for separate Data Implement **after** Integrator assigns migr number: contracts → `teaching-exposure.ts` → remove transfer default → eligibility/assistance filters → help repo + migr → thin tutor-turn field pass → attempt-service explicit dimension → T1–T18.
- Experience UI remains deferred.
- This Accept does **not** authorize ALTER, product code, commit, push, or hermes.

## Blockers / open decisions for PM

**None blocking ACCEPT.** Plan defaults match PM frozen steering. Escalate only if Paula rejects a default (wire keep `unverified`; omit dimension → no link; tutor mapping; item_version_id column vs join-only).

## not_run (honest)

All Plan Implement tests **T1–T18**: `not_run` (Plan stage — correct). No unit/typecheck/integration re-run applicable until Implement.
