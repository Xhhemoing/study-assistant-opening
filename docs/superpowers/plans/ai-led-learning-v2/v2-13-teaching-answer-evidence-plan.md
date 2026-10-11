# V2-13 Plan — Teaching & answer evidence semantics

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Data (executor)  
**Branch tip:** `9a508a72d16b23b70c6aa3701ff35348ce18c3f0` (`feat/opening-release`)  
**Stage:** Plan only — **Plan ACCEPT required before Implement**  
**Hard rules:** No product Implement · no ALTER · no push / hermes / stash / reset / commit · migration number placeholder **`00xx`** if needed (Integrator assigns; tip migrations end at **0056**)  
**Align:** `plan.md` §V2-13; Understand `v2-13-teaching-answer-evidence-understand.md`; PM locks 1–6; ADR D3/D4; charter G6/G8

## 1. Smallest design

### 1.1 Concepts

| Concept | Responsibility | Does not own |
|---|---|---|
| **ExposureKind** | `instruction` \| `hint` \| `solution` on delivered help rows | Tutor prose / UI chrome |
| **TeachingExposure (domain)** | Classify kind; filter which exposures affect item assistance; forbid read / “fully independent” claims without evidence; activity-complete ≠ mastery | Worker orchestration rewrite |
| **Outcome path** | Same observation ledger: `correct` \| `incorrect` \| `unverified` (**unverified = PM “unknown”**) | Renaming wire enum in course clients |
| **Activity-scoped v2 adapter** | Optional/additive observation inputs keyed by `activityId`; course v1 unchanged | Parallel observation tables |
| **Dimension honesty** | No default `transfer` on delayed retest link; stable node/item/version identity | Deleting `transfer` from dimension enum |
| **SkillEvidence link** | Still projection from eligible independent+correct observations only | Mastery scores / Episode truth |

### 1.2 Link graph

```
Tutor / teaching delivery (worker or teaching commands later)
        │
        │ insertOpeningDeliveredHelp(+ kind, optional activityId, problem/attempt/itemVersion)
        ▼
opening_help_exposures  (existing table + kind [+ nullable activity_id])
        │
        ├── kind=instruction → recorded delivery; DOES NOT elevate item assistance
        ├── kind=hint|solution → existing eligibility / resolveAssistance paths
        └── delivered=true only; never claim "read" from undelivered UI state
        │
Formal attempt submit (course v1 OR v2 activity adapter)
        │
        ▼
opening_learning_observations (same path; outcome correct|incorrect|unverified)
        │
        ├── eligibility evaluateEvidenceEligibility (ignore instruction kind in helpHistory)
        ├── SkillEvidence link only via prepareRetestSkillLink / explicit nodeId+dimension
        │     └── dimension REQUIRED when linking; NO default transfer
        └── activity status completed → FORBIDDEN as mastery upgrade trigger
```

### 1.3 Core rules (encoded in domain + contracts)

1. **ExposureKind:** every new delivered help row carries `kind`. Historical rows without kind → read-adapter default **`hint`** (not instruction, not independent). Rollback: old readers ignore unknown columns.
2. **Instruction ≠ item help:** `evaluateAssistance` / `resolveAssistance` **ignore** `kind=instruction` when computing item assistance / independent credit. Concept teaching must not pollute later different items.
3. **Hint / solution:** `hint` → level typically `hinted`; `solution` → level `revealed` (or hinted if partial). Still require `delivered === true` and completed assistant turn (existing `insertOpeningDeliveredHelp` gate).
4. **No “read” / “fully no external help” without evidence:** domain helpers refuse to emit claims `read` or `independent` unless (a) delivered exposures / attempts support it and (b) `observationAllowsIndependent` + eligibility would agree. Client-declared independent erased by server-known hint/solution on same item/attempt.
5. **Same fact path:** all formal correctness still writes `opening_learning_observations.outcome` ∈ {correct, incorrect, unverified}. **Do not** fork a second answer table. Incorrect rows remain in statistical denominators (`historicalIncorrectCount` path unchanged).
6. **Unknown:** PM “unknown” correctness ≡ wire **`unverified`**. Do not rename enum in M1 (course API stability). Summaries keep `unverifiedCount` separate from incorrect.
7. **Course APIs unchanged:** `observationInputSchema`, session create, course summary/history routes keep required `courseId`. v2 adds **additive** activity-scoped helpers/adapters (`activityObservationInputSketchSchema` → real schema) that still insert the **same** tables.
8. **Remove delayed default transfer:** delete / stop using `RETEST_CLOSE_DEFAULT_DIMENSION = "transfer"`. `prepareRetestSkillLink` returns null (no link) when dimension omitted — even if independent+correct+node resolved. Callers (`attempt-service`) must pass explicit dimension when product intends transfer/recall/….
9. **Stable identity:** eligibility continues to key on `problemId` + `itemVersionId` (+ source versions). New UUID / label rename alone ⇒ `changed_needs_check` / `version_unknown` / no “new situation” inference without `equivalent_confirmed`.
10. **Same-item answer exposure survives new session:** help/eligibility association is by problem/attempt/itemVersion (+ history revision), **not** “current session only erases prior reveal”. Prior `solution`/`revealed` on same problem still yields `prior_answer_exposure` (existing timing rules).
11. **Help attribution evidenced:** UI may show self-report vs model suggestion via `verdictSource`; help chips only from delivered exposures with kind.
12. **Complete activity ≠ mastery:** domain `assertActivityCompleteDoesNotUpgradeMastery` — transitioning teaching activity to `completed` must **not** call SkillEvidence link, must **not** rewrite observations to correct/independent, must **not** set summary to `observed_independent`. Progress status only.
13. **Unverifiable formal proof → needs_check:** if reference check incomplete / verdict not `reference_checked` / identity incomplete → eligibility stays unknown; learning summary / knowledge node status remain **`needs_check`** where those statuses already apply — do not invent “soft mastered”.
14. **Nest / no parallel product:** extend help + domain + eligibility filters; **no** new mastery table; Episode stays read-only projection (ADR D4).
15. **Tutor-turn ownership:** Data owns contract/domain/repo hooks; worker passes new fields only — **no** rewrite of claim/budget/citation orchestration (≠ V2-06).
16. **History backfill policy:** missing kind/dimension/assistance **must not** be backfilled as independent / correct / transfer (plan.md rollback).

### 1.4 Data vs AI / worker touch points

| Path | Data Implement | AI/worker |
|---|---|---|
| `packages/contracts/.../learning.ts` (+ tests) | Extend `helpExposureSchema` with `kind`; optional activity fields on v2 sketches | Consume |
| `packages/domain/.../teaching-exposure.ts` (**new**) | Classifiers + mastery/complete guards + kind filters | — |
| `packages/domain/.../retest-close-evidence.ts` | Remove transfer default; require explicit dimension | — |
| `packages/domain/.../evidence-eligibility-timing.ts` | Filter instruction kind out of item assistance loop | — |
| `packages/domain/.../assistance.ts` | Accept kind-aware exposure list (or pre-filter) | — |
| `packages/database/.../opening-learning-help.ts` | Persist kind (+ activity_id if migrated) | — |
| `packages/database/.../opening-skill-evidence.ts` | No link API from activity-complete; keep course projection | — |
| `apps/worker/.../tutor-turn.ts` | **Document only in Plan;** Implement = thin field pass | Set `kind` per mapping; keep orchestration |
| Experience UI | **OOS** this slice | — |

## 2. Contract sketches

**Extend** `packages/contracts/src/opening/learning.ts` (not a parallel file for core outcomes):

```ts
// sketches — not implemented this slice

helpExposureKindSchema = enum["instruction", "hint", "solution"]

helpExposureSchema = {
  id, sessionId,
  attemptId?: uuid | null,
  problemId: uuid | null,
  itemVersionId?: uuid | null,   // optional strengthen identity
  activityId?: uuid | null,      // v2; nullable for legacy
  turnId,
  kind: helpExposureKindSchema,  // NEW required on write; readers default legacy→hint
  level: enum["hinted", "revealed"],
  delivered: literal(true),
  deliveredAt?, historyRevision?, createdAt,
}.strict()

// v2 additive — does not replace observationInputSchema
activityScopedObservationInputSchema = observationInputSchema
  .extend({ activityId: uuidSchema })
  // courseId remains required on v1; v2 adapter layer may resolve courseId from activity association
  // when ADR nullable course lands — until then courseId still required for same-table insert
```

**Proposed domain:** `packages/domain/src/opening/teaching-exposure.ts`

```ts
// sketches
classifyTutorHelpKind(input: {
  mode: "hint" | "explain" | ...;
  attemptId?: string | null;
  problemId?: string | null;
  intent?: "instruction" | "item_help" | "solution";
}): "instruction" | "hint" | "solution"

exposuresAffectingItemAssistance(exposures): HelpExposure[]
// filters kind !== "instruction"

assertNoUnavidencedIndependence(claim, evidence): void
assertNoUnavidencedRead(claim, evidence): void

assertActivityCompleteDoesNotUpgradeMastery(sideEffects): void
// forbids skillEvidenceLink / observationOutcomeRewrite / summaryForceIndependent

mapPmUnknownOutcome(): "unverified"  // documentation helper / test alias only
```

**Retest:**

```ts
// prepareRetestSkillLink — change
// dimension: input.dimension ?? RETEST_CLOSE_DEFAULT_DIMENSION  → REMOVE default
// if !input.dimension → return null (no SkillEvidence link)
// RETEST_CLOSE_DEFAULT_DIMENSION constant: delete or mark deprecated unused
```

## 3. Eligibility / assistance behavior changes

| Case | Expected |
|---|---|
| Instruction delivered, later different problem attempt independent | Assistance not forced hinted by instruction; eligibility may still be unknown for other reasons |
| Solution revealed on problem P, new session same P | `prior_answer_exposure` / not independent credit for delayed check per existing delayed rules |
| Hint on attempt A before submit | `help_before_submission` → not independent |
| No problemId on observation | Never `observed_independent` (`observationAllowsIndependent`) |
| Self-report correct vs reference_checked | verdictSource remains distinct in summary `evidenceSources` |
| Model suggestion alone | Does not become reference_checked mastery |

## 4. DDL decision

| Option | Plan choice |
|---|---|
| Parallel `opening_teaching_mastery` / second answer ledger | **Rejected** (PM lock 5 / ADR D4) |
| Checkpoint-only kind (no DDL) | **Rejected** — help must survive sessions & eligibility rebuild |
| Extend `opening_help_exposures` | **Accepted** |
| Columns | `kind TEXT NOT NULL` with CHECK (`instruction`,`hint`,`solution`); backfill existing → `'hint'`; optional `activity_id UUID NULL` FK teaching activities; optional `item_version_id` if cheap |
| Migration number | **YES needed** — placeholder **`00xx_opening_help_exposure_kind.sql`**; **Integrator assigns**; tip today ends **`0056`** |
| course_id nullable on observations | **Out of V2-13 default** — already ADR/V2-04 track; do not invent here |

**Migration needed: YES** (Integrator assigns number).  
This Plan does **not** write the SQL file.

**Backup:** if `activity_id` added to help_exposures, register in backup table lists (existing pattern in `backup-compose` / learning-state tests) at Implement.

## 5. Attach point inventory

| Surface | How V2-13 attaches |
|---|---|
| Course observation / attempt APIs | Unchanged request shapes; server may persist richer help kinds transparently |
| v2 teaching activity | Activity-scoped adapter + optional activityId on exposures; complete ≠ mastery guard near activity status updates |
| Retest close (`attempt-service`) | Must pass explicit `dimension` when SkillEvidence desired; domain no longer defaults transfer |
| Eligibility rebuild | Instruction kind excluded from item assistance; invalidation paths unchanged |
| tutor-turn L01 | Thin: set `kind` via `classifyTutorHelpKind`; prefer binding attempt/problem when item help |
| V2-06 | Untouched (citations/coverage) |
| V2-12 skip | Untouched (still no incorrect on skip) |
| SkillEvidence repo | No new “complete → link” API |

## 6. Tests list (Implement; all `not_run` at Plan stage)

| ID | Check |
|---|---|
| T1 | Contract: helpExposure requires `kind`; rejects unknown kind; legacy parse default/read path documented |
| T2 | `classifyTutorHelpKind`: explain+no problem → instruction; hint+attempt → hint; solution intent → solution |
| T3 | Instruction exposure does **not** change `resolveAssistance` / eligibility independent for a **different** problem |
| T4 | Same-problem prior solution survives new session (prior_answer / not wiped) |
| T5 | Observation without problemId → not independent; outcome unverified stays needs_check path |
| T6 | Outcome path still accepts correct/incorrect/unverified; incorrect counted in historicalIncorrect denominator fixture |
| T7 | `prepareRetestSkillLink` with omitted dimension → **null** (no transfer default) |
| T8 | Explicit `dimension: "transfer"` still links when independent+correct+node |
| T9 | Assisted / incorrect / unverified retest → no SkillEvidence (existing) + still no transfer default side door |
| T10 | Activity complete helper forbids SkillEvidence / outcome rewrite / force independent |
| T11 | Course `observationInputSchema` still requires courseId (unchanged) |
| T12 | insertOpeningDeliveredHelp persists kind; idempotent id conflict rules unchanged |
| T13 | verdictSource self_report vs model_suggestion remain distinguishable in summary projection test |
| T14 | New ID / rename without equivalence → not treated as confirmed new distinct situation (eligibility version_* reasons) |
| T15 | History missing kind read-as-hint; **never** backfilled independent/correct/transfer in migrate script assertions |
| T16 | tutor-turn unit: mode explain without attempt → kind instruction in helpExposure payload (mock deps) |
| T17 | Repo flagsForNode unchanged honesty (independent only with eligibility yes) |
| T18 | No new parallel mastery table in migrations tip after Implement |

**Plan-stage:** all above **`not_run`**.

## 7. Rejected alternatives

| Alt | Why rejected |
|---|---|
| Parallel mastery / AI-score product | PM lock 5; ADR D4; charter Facts ledger |
| Rename outcome `unverified` → `unknown` in M1 | Breaks course clients; PM unknown is semantic |
| Keep `RETEST_CLOSE_DEFAULT_DIMENSION = transfer` | PM lock 3 explicit |
| Infer transfer from “delayed” alone | Same lock; delayed original ≠ migration/transfer |
| Treat new problem UUID as new situation automatically | PM lock 3; need equivalence / version applicability |
| Claim read from scroll / dwell / checkpoint only | PM lock 1 — no evidence |
| Activity completed → append SkillEvidence | PM lock 4 |
| Instruction stored as hinted without kind | Pollutes later items (verification bullet) |
| Data rewrites tutor-turn orchestration | Ownership boundary; ≠ V2-06 |
| Invent migration `0057` as assigned | Integrator-only |
| Experience UI polish in this slice | Dirty tree; OOS |
| Skip writes incorrect (reopen V2-12) | Out of scope |

## 8. Migration + rollback

| Item | Plan decision |
|---|---|
| Migration needed? | **YES** (`kind` [+ optional `activity_id`]) |
| Number | **`00xx`** — Integrator assigns |
| Tip today | Ends **`0056_opening_intervention_settings.sql`** |
| Backfill | Existing exposures → `kind='hint'` only — **not** independent/correct/transfer |
| Rollback | Keep columns; old readers ignore `kind` / treat missing as hint; disable new classifiers via flag if needed; **do not** DELETE help rows |
| Data destruction | Never DROP help/observation history on rollback |

## 9. Open questions (Plan defaults)

1. **Unknown wire:** keep **`unverified`**.  
2. **Omitted dimension after removing transfer default:** **no SkillEvidence link**.  
3. **Instruction storage:** **same** `opening_help_exposures` + `kind`.  
4. **DDL:** **YES** — `kind` NOT NULL + backfill hint; nullable `activity_id`; Integrator assigns `00xx`.  
5. **Tutor mapping:** explain∧¬problem → instruction; hint∧attempt → hint; solution intent → solution.  
6. **item_version_id on help:** optional in M1 if cheap; else rely on attempt join (Plan default: **nullable column if Integrator OK**, else join-only).  
7. **course_id nullable:** not in V2-13 default (ADR track).  

Escalate to Paula only if a default is rejected.

## 10. Implement gate (after Plan ACCEPT)

1. Integrator / designated Reviewer **ACCEPT** this Plan.  
2. Integrator assigns migration **`00xx`** (confirm YES).  
3. Separate Implement slices:  
   - **Data:** contracts → `teaching-exposure.ts` → retest default removal → eligibility/assistance filters → help repo → thin tutor-turn field pass → tests T1–T18 → evidence per gates.  
   - **Experience:** display kind / needs_check copy only after contracts stable (**not** this Understand/Plan slice).  
4. **This document does not authorize ALTER or product code.**

## 11. Files to add/change at Implement (preview)

| Path | Action | Owner |
|---|---|---|
| `packages/contracts/src/opening/learning.ts` (+ tests) | Extend helpExposure + exports | Data |
| `packages/domain/src/opening/teaching-exposure.ts` (+ test) | **New** | Data |
| `packages/domain/src/opening/retest-close-evidence.ts` (+ test) | Remove transfer default | Data |
| `packages/domain/src/opening/evidence-eligibility-timing.ts` (+ tests) | Ignore instruction kind | Data |
| `packages/domain/src/opening/assistance.ts` (+ test) | Kind-aware filter | Data |
| `packages/database/src/repositories/opening-learning-help.ts` (+ tests) | Persist kind / activity_id | Data |
| `packages/database/src/migrations/00xx_….sql` | Integrator number | Data after assign |
| `apps/worker/src/jobs/tutor-turn.ts` | Thin kind (+ problem bind when known) | Data+worker (no orchestration rewrite) |
| `apps/web/.../attempt-service.ts` | Pass explicit dimension when linking | Data (service) — **not** Experience UI files |
| Experience teaching chrome | OOS | Experience later |

**Not touching in V2-13 Data Implement:** V2-06 citation packs; V2-12 command CAS; Experience preference/command UI; push/hermes; inventing migration numbers; `tasks.json` verified flip.
