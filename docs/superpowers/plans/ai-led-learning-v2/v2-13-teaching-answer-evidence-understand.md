# V2-13 Understand — 修正教学与作答证据语义

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Data (executor)  
**Branch tip:** `9a508a72d16b23b70c6aa3701ff35348ce18c3f0` (`feat/opening-release`) — Experience may show dirty UI on tree (tip ~`9a508a7`); this slice writes docs only  
**Delivery-loop stage:** Understand → Plan only (**no Implement, no ALTER, no push / hermes / stash / reset / commit**)  
**Authority:** Charter `docs/plans/2026-10-11-ai-led-learning-v2.md`; `plan.md` §V2-13 (~L585+); `tasks.json` V2-13; gates `docs/superpowers/plans/opening-release/review-test-gates.md`; ADR `docs/decisions/ADR-teaching-activity-context.md`; style refs `v2-12-teaching-commands-*.md`  
**Do not conflate:** V2-06 = AI claim/citation pack ≠ V2-13 learner attempt/help/mastery semantics. V2-03 ADR bounds. V2-04 activities. V2-12 skip ≠ wrong-answer (attach; do not reopen).

## Restated outcome

Correct **teaching vs answering evidence semantics** so help, correctness, dimension, and mastery claims stay honest and nest into the **existing** Observation / Attempt / Exposure / eligibility ledger — without a parallel scoring product, without breaking **old course APIs**, and without inventing migration numbers.

Concretely (PM design locks → restatement):

1. **Distinguish instruction vs item/attempt hint/solution**; persist **real delivery** only (`delivered === true`); **never** claim the learner “read” material or worked with “fully no external help” without server-backed exposure/attempt evidence.
2. **Same fact path** stores **correct / incorrect / unknown** (wire today: `unverified` = unknown correctness — see stronger-review); **v2 activity-scoped** reads/writes; **old course interface unchanged**.
3. **Remove delayed default `transfer`**; keep **stable node / item / version** identity; **do not** infer a new learning situation from new IDs or renames alone.
4. **Help attribution must be evidenced**; **completing an activity does not upgrade mastery**; when formal proof cannot be verified, keep **`needs_check`** (summary / knowledge / generateStatus senses as already used — do not invent a second mastery flag).
5. **Nest into existing evidence model** — no parallel product; migration number **only if Integrator assigns**.
6. **No push / hermes**.

## Why this exists (gap after V2-03 / V2-04 / eligibility / retest)

| Layer | Landed | Missing / wrong for V2-13 |
|---|---|---|
| Help delivery | `helpExposureSchema` + `opening_help_exposures` + `insertOpeningDeliveredHelp`; tutor-turn L01 writes on `hint`/`explain` | **No `kind`** — instruction vs hint vs solution indistinguishable; tutor often sets `problemId: null` → eligibility `help_association_unknown` / cross-item pollution risk |
| Assistance resolve | `resolveAssistance` / `qualifyObservationAssistance` / eligibility `evaluateAssistance` | Treats all delivered exposures with level hinted/revealed as item help; **concept instruction can contaminate later items** |
| Outcomes | `observationOutcomeSchema`: `correct` \| `incorrect` \| `unverified` | Same path exists; PM “unknown” = semantic slot → **keep wire `unverified`** (do not break course clients). Summary already separates `historicalIncorrectCount` vs `unverifiedCount` |
| Activity scope | V2-04 `activity_id` NOT NULL on sessions / observations / attempts / item_versions (`0053`); ADR D3 dual-track | **Course v1 contracts still require `courseId`**; `activityObservationInputSketchSchema` is sketch only; **`opening_help_exposures` has no `activity_id`** |
| Delayed dimension | `RETEST_CLOSE_DEFAULT_DIMENSION = "transfer"` in `retest-close-evidence.ts`; `prepareRetestSkillLink` defaults when omitted | **PM lock: remove delayed default transfer** — delayed retest ≠ automatic transfer dimension |
| Identity | `problemId` + `itemVersionId` + eligibility version applicability (`exact` / `equivalent_confirmed` / `changed_needs_check` / …) | Callers must **not** treat rename/new UUID as new situation without equivalence confirmation |
| Mastery honesty | `evidence_verdict` default `MASTERY_NOT_ESTABLISHED`; `canBecomeObservedIndependent` / missing `problemId` → no independent; SkillEvidence is projection link | **No explicit domain guard** that activity `status=completed` must not link SkillEvidence / upgrade summary to independent; formal unverified → stay `needs_check` |
| Proposed module | — | `packages/domain/src/opening/teaching-exposure.ts` **ABSENT** |

## PM locks map (must encode in Plan)

| # | PM lock | Inventory anchor | Plan must |
|---|---|---|---|
| 1 | instruction ≠ item/attempt hint/solution; real delivery; no “read” / “fully no external help” without evidence | `helpExposureSchema` (`learning.ts` L80–94); `insertOpeningDeliveredHelp`; tutor-turn help block L206–217; eligibility `evaluateAssistance` | Add exposure **kind**; instruction ignored for item assistance; forbid read/independent claims without facts |
| 2 | correct/incorrect/unknown same path; v2 activity-scoped; old course unchanged | `observationOutcomeSchema`; ADR D3; `observationInputSchema.courseId` required; DB `activity_id` on observations | Keep course APIs; add v2 activity adapters; unknown ≡ wire `unverified` |
| 3 | Remove delayed default transfer; stable node/item/version; no infer from new IDs/renames | `RETEST_CLOSE_DEFAULT_DIMENSION`; `prepareRetestSkillLink`; eligibility version rules | Drop transfer default; require explicit dimension or no SkillEvidence link; identity via itemVersion/problemId + equivalence |
| 4 | Help evidenced; complete activity ≠ mastery upgrade; unverifiable formal → `needs_check` | teaching activity `completed`; SkillEvidence link path; `learningSummarySchema.status` includes `needs_check` | Domain asserts; no auto-link on complete; keep needs_check |
| 5 | Nest existing model; Integrator assigns migration # | ADR D4 no parallel scoring; migrations tip **0056** | Extend help/eligibility/retest; placeholder `00xx` if DDL |
| 6 | No push/hermes | gates | Docs only this slice |

## Inventory (paths cited)

### 1. Authority / task

- `docs/superpowers/plans/ai-led-learning-v2/plan.md` §V2-13 (~L585–603): reuse `learning.ts`, `retest-close-evidence.ts`, `opening-skill-evidence.ts`, `tutor-turn.ts`; proposed `teaching-exposure.ts`; verify concept teaching ≠ pollute later items; same-item answer exposure survives new session; no problem id → unknown; delayed original ≠ transfer; new ID same item ≠ new item; self vs model suggestion separate; incorrect stays in denominator; accept: help attributed; complete ≠ mastery; unverifiable → needs_check; rollback: keep new fields + old readers; do **not** backfill history as independent/correct/transfer.
- `tasks.json` V2-13 — depends_on V2-03, V2-04; goals G2/G6/G8; status `proposed`; evidence_status all `not_run` / pending_user / unknown.
- Charter G6 evidence honesty; Facts ledger — Observation/Attempt/Exposure only; no “AI said mastered” fork.
- ADR D3/D4 — dual-track API; no parallel scoring; SkillEvidence stays projection.

### 2. Contracts — `packages/contracts/src/opening/learning.ts`

| Symbol | Role for V2-13 |
|---|---|
| `observationOutcomeSchema` | `correct` \| `incorrect` \| `unverified` — **unknown correctness = `unverified`** on wire |
| `assistanceLevelSchema` | `independent` \| `hinted` \| `revealed` \| `unknown` |
| `verdictSourceSchema` | `self_report` \| `reference_checked` \| `model_suggestion` \| `unknown` — self vs model must stay distinguishable in summaries |
| `helpExposureSchema` | session/attempt/problem + `level` hinted\|revealed + `delivered: true` only — **missing kind** |
| `observationInputSchema` | **requires `courseId`**; optional `problemId` / `retestId` / `nodeId` / `dimension` |
| `canBecomeObservedIndependent` / `observationAllowsIndependent` | hinted/revealed block; missing `problemId` → never independent |
| `learningSummarySchema.status` | includes `needs_check` / `observed_independent` / …; `unverifiedCount` separate from incorrect |

Related: `learning-evidence.ts` eligibility shape; `teaching-activity.ts` `activityObservationInputSketchSchema` (activityId required sketch); `knowledge.ts` `skillEvidenceSchema.dimension` includes `transfer`.

### 3. Domain — retest / eligibility / assistance

- `packages/domain/src/opening/retest-close-evidence.ts`: **`RETEST_CLOSE_DEFAULT_DIMENSION = "transfer"`** (L8–9); `shouldAppendRetestEvidence` only independent+correct; `prepareRetestSkillLink` defaults dimension to transfer when omitted (L67).
- `packages/domain/src/opening/evidence-eligibility.ts` + `evidence-eligibility-timing.ts`: incomplete identity → all unknown; assistance uses help history; **prior revealed on same problem** marks prior-answer; cross-problem without same attempt skipped; null problemId on help → `help_association_unknown`.
- `packages/domain/src/opening/assistance.ts`: `resolveAssistance` elevates declared by any session exposure levels — **no kind filter** (instruction would look like hint if recorded as hinted).
- Proposed **`packages/domain/src/opening/teaching-exposure.ts` — ABSENT**.

### 4. Repositories

- `packages/database/src/repositories/opening-skill-evidence.ts`: `link` / `linkOpeningSkillEvidenceInTx`; `flagsForNode` derives `hasCheckedIndependent` / `hasAssistance` from eligibility + assistance; **course-scoped**; no activity complete hook.
- `packages/database/src/repositories/opening-learning-help.ts`: `insertOpeningDeliveredHelp` — requires completed assistant turn; invalidates eligibility for matching attempt/problem/session; **no kind column write**.
- `packages/database/src/repositories/opening-learning-observations.ts`: inserts with `activity_id` from session; links SkillEvidence when nodeId+dimension present; does not upgrade mastery from activity status.
- Migrations: help table `0019` + attempt columns `0028`; activity_id on learning facts `0053` (**not** on `opening_help_exposures`); tip migrations end **`0056_opening_intervention_settings.sql`**.

### 5. Worker — `apps/worker/src/jobs/tutor-turn.ts` (ownership)

| Concern | Owner |
|---|---|
| When to call provider / budget / citations / completeTurn | **AI / worker** (do **not** rewrite orchestration in V2-13 Data Implement) |
| HelpExposure contract shape (`kind`, item binding rules) + domain classifiers | **Data** |
| Passing `kind` + problem/item ids into `insertHelpExposure` once contracts land | Data proposes deps signature; worker thin adapt at Implement (still not a tutor rewrite) |
| Concept instruction turns must not be stored as item `hinted`/`revealed` without kind | Data domain + contract; worker must stop conflating mode=`explain` with item solution unless attempt/problem bound |

Current L206–217: if `learningSessionId` and mode ∈ {hint, explain} → exposure with `problemId: null`, `level` from mode — **primary pollution vector** for lock 1.

### 6. Course / Experience touch (do not edit UI this slice)

- `apps/web/src/features/opening/learning/attempt-service.ts` calls `prepareRetestSkillLink` → inherits transfer default — **Data domain change** cascades; Experience UI files **out of scope** for this slice (dirty tree note).
- Course summary / history routes remain v1 `courseId`-keyed (ADR).

### 7. Related slices (boundaries)

| Slice | Relation |
|---|---|
| V2-06 teaching-evidence | AI **claim/citation** honesty — not learner attempt/help/mastery |
| V2-03 ADR | Dual-track + no parallel scoring — **bounds** V2-13 |
| V2-04 | `activity_id` already on core learning rows |
| V2-12 | skip ≠ incorrect observation — already planned/landed commands; V2-13 does not reopen skip |

## Out of scope (OOS) for V2-13 Understand+Plan

- **No product Implement** / no Experience UI edits / no ALTER / migrate / commit / push / hermes / stash / reset.
- Inventing migration numbers (keep `00xx`; tip ends **0056**).
- Parallel mastery / “AI said mastered” product; Episode-as-truth.
- Changing old course HTTP contracts / requiring course clients to send `activityId`.
- Full V2-14 resume package; V2-06 citation pack; tutor orchestration rewrite.
- Backfilling historical rows as independent / correct / transfer.
- Flipping `tasks.json` → verified / in_progress.

## Open decisions for PM / Paula

Only items that change product meaning (Plan defaults below; escalate if Paula disagrees):

1. **Wire name for unknown correctness:** keep enum value **`unverified`** (semantic = PM “unknown”) vs breaking rename to `unknown`. **Plan default = keep `unverified`.**
2. **After removing transfer default:** omit dimension → **no SkillEvidence link** vs require caller always pass explicit dimension. **Plan default = no link when dimension omitted.**
3. **Instruction persistence:** extend `opening_help_exposures` with **`kind`** (`instruction` \| `hint` \| `solution`) vs separate table. **Plan default = extend existing table (nest model).**
4. **DDL on help_exposures:** `kind` only vs `kind` + optional `activity_id` / `item_version_id`. **Plan default = `kind` NOT NULL with backfill `hint` for historical hinted/revealed rows; add nullable `activity_id` for v2 scoping; Integrator assigns `00xx`.**
5. **Tutor mode mapping:** `explain` without attempt/problem → **`instruction`**; with attempt + solution intent → **`solution`**; `hint` with attempt → **`hint`**. Confirm.

If PM ACCEPTS Plan with these defaults, no further PM gate beyond ordinary Plan ACCEPT before Implement.

## Stronger-review notes (restatement vs PM words)

| Check | Result |
|---|---|
| PM “unknown” vs code `unverified` | Restatement must **not** pretend the wire already says `unknown`; Plan encodes semantic alias + keeps course wire stable |
| “Remove delayed default transfer” | Exact target is `RETEST_CLOSE_DEFAULT_DIMENSION` / `prepareRetestSkillLink` default — not deleting the `transfer` dimension enum value |
| “Complete activity does not upgrade mastery” | Activity `status=completed` is progress, not SkillEvidence / `observed_independent` |
| “Never claim read / fully no external help” | No client-only flags; independent requires evidence path (`observationAllowsIndependent` + eligibility) |
| V2-06 ≠ V2-13 | Citation packs ≠ help/attempt semantics — Plan files must not merge scopes |
| Course APIs unchanged | v1 `observationInputSchema.courseId` required stays; v2 adapters additive |
| Data vs tutor-turn | Document hooks only; no worker rewrite in Data Plan Implement scope |

## Ready for Plan?

**Yes.** Inventory closed; PM locks mapped to real symbols; stop here until Plan is written and Plan ACCEPT granted before any Implement.
