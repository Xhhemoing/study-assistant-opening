# V2-11 Plan — Intervention preferences + low-interrupt decision

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Data (executor)  
**Branch tip:** `0436946ed1dd58aa414313bb1283e9f2e7f162c3` (`feat/opening-release`)  
**Stage:** Plan only — **Plan ACCEPT required before Implement**  
**Hard rules:** No product Implement · no ALTER · no push / hermes / stash / reset / commit · migration number placeholder **`00xx`** (Integrator assigns; tip migrations end at **0055**)  
**Align:** `plan.md` §V2-11; Understand `v2-11-intervention-prefs-understand.md`; PM design locks (session>course>global; user-ask≠interrupt; decision enum; no dwell stuck; no auto-expand after hint; no N-minute nag; nest settings)

## 1. Smallest design

### 1.1 Concepts

| Concept | Responsibility | Does not own |
|---|---|---|
| **InterventionPrefs** | Explicit user controls: proactivity, nodes, depth, quietMode | Tutor action *content*; mastery scores |
| **ResolvedInterventionPrefs** | session > course > global merge | Persistence |
| **decideIntervention** | Pure domain policy → `none`\|`defer`\|`offer`\|`respond` + `reason` | Side effects / UI / writing exposures |
| **InterventionDecisionRecord** | Append-only ring of recent decisions (why we stayed quiet or offered) | Formal help exposure ledger (`opening_help_exposures`) |
| **preference-controls.tsx** | Experience UI half (preview only in this Plan) | Domain policy |

### 1.2 Link graph

```
workspace_preferences.intervention_settings   ←── global durable
        │
courses.intervention_settings (nullable jsonb)←── course overlay (partial)
        │
opening_teaching_activities.checkpoint_json
  .interventionPrefs                          ←── session temp (does NOT write-through)
  .interventionDecisions[]                    ←── decision ring (M1)
        │
        ▼
resolveInterventionPrefs(global, course, session)
        │
        ▼
decideIntervention({ prefs, trigger, context })
        │
        ├── user_help_ask  → respond (even quiet) | defer only if hard block (budget/auth)
        └── system_proactive / tutor_recommend → none|defer|offer|respond per rules
                │
                ▼
tutor-policy recommend* (suggestion only) ──► gated by decision before surface / auto-act
```

### 1.3 Core rules (encoded in domain)

1. **Precedence:** session overlay fields override course; course overrides global; missing keys inherit.
2. **Temp ≠ permanent:** writing `checkpoint_json.interventionPrefs` must not mutate `workspace_preferences` / `courses` rows.
3. **User help ask ≠ interrupt:** `trigger: "user_help_ask"` is never classified as a system interrupt; quietMode / proactivity `off` still allow `respond` (or honest failure reason, not “quiet”).
4. **Quiet / off:** suppress *proactive* `offer`/`respond`; still answer explicit asks.
5. **No dwell-time stuck:** context must not include “msIdle” / dwell as a stuck signal; reject such inputs in types.
6. **No auto-expand after hint:** `sessionExposures` containing `hinted` alone must **not** yield `respond` with full answer / worked example. Max = `offer` (user confirms) unless `trigger: "user_help_ask"` asks for explain/reveal.
7. **No N-minute nag:** policy API has **no** `intervalMinutes` / `mustAskEvery` parameter; tests assert absence.
8. **Typing / low evidence / consecutive reject:** proactive → `none` or `defer` with reason (`user_typing` | `low_evidence` | `consecutive_reject`).

### 1.4 Decision vs exposure

| Layer | Store | Meaning |
|---|---|---|
| Decision record | activity `checkpoint_json.interventionDecisions[]` | Policy *chose* none/defer/offer/respond |
| Help exposure | `opening_help_exposures` | Server-confirmed delivered hint/reveal (existing) |
| Tutor recommend | pure function output | Candidate action — **not** authorization to auto-act |

## 2. Contract sketches

**Proposed file:** `packages/contracts/src/opening/intervention-prefs.ts`  
(Export via `packages/contracts/src/opening/index.ts` at Implement. Mirror style of `planning-settings.ts` / `ai-settings.ts`.)

```ts
// sketches — not implemented this slice

interventionProactivitySchema = enum["off", "minimal", "balanced", "high"]

interventionDepthSchema = enum[
  "hint_only",           // proactive max = hint offer; full answer only on explicit ask
  "hint_then_offer",     // after hint delivered, may offer deeper (never auto-respond)
  "full_ok_on_request"   // same as hint_then_offer for proactive; explicit ask may respond full
]

interventionNodesSchema = {
  allowOnTeach: boolean,    // during teach blocks
  allowOnPrompt: boolean,   // during prompt / attempt
  // NO allowOnDwell — forbidden
  allowOnLowEvidence: boolean, // default false: low evidence → defer/none
}

interventionPrefsSchema = {
  proactivity: interventionProactivitySchema,
  nodes: interventionNodesSchema,
  depth: interventionDepthSchema,
  quietMode: boolean,       // true ⇒ treat proactive as proactivity "off"
}.strict()

DEFAULT_OPENING_INTERVENTION_PREFS: InterventionPrefs = {
  proactivity: "balanced",
  nodes: { allowOnTeach: true, allowOnPrompt: true, allowOnLowEvidence: false },
  depth: "hint_then_offer",
  quietMode: false,
}

// Partial overlays for course + session
interventionPrefsPatchSchema = interventionPrefsSchema.deepPartial().strict()

interventionDecisionKindSchema = enum["none", "defer", "offer", "respond"]

interventionTriggerSchema = enum[
  "user_help_ask",
  "system_proactive",
  "tutor_recommend"
]

interventionDecisionReasonSchema = z.string().min(1).max(500)
// Suggested machine tokens (also human-readable OK): 
 // quiet_mode | proactivity_off | user_typing | consecutive_reject |
 // low_evidence | node_disallowed | depth_blocks_auto_expand |
 // user_request | offer_deeper_after_hint | budget_or_auth_block | ...

interventionDecisionRecordSchema = {
  id: uuid,                    // or client-generated uuid
  at: isoDateTime,
  activityId: uuid,
  sessionId?: uuid | null,
  trigger: interventionTriggerSchema,
  decision: interventionDecisionKindSchema,
  reason: interventionDecisionReasonSchema,
  proposedKind?: string | null, // e.g. worked_example | guided | clarify
  prefsSnapshot?: {            // small effective summary, optional
    proactivity, quietMode, depth
  },
}.strict()

interventionSettingsResponseSchema = {
  settings: interventionPrefsSchema,          // effective global stored or default
  courseOverride: interventionPrefsPatchSchema.nullable(),
  sessionOverride: interventionPrefsPatchSchema.nullable(),
  effective: interventionPrefsSchema,         // resolved
  saved: boolean,
  invalidStoredSettings: boolean,
}.strict()
```

**Domain (proposed):** `packages/domain/src/opening/intervention-policy.ts`

```ts
// sketches

resolveInterventionPrefs(
  global: InterventionPrefs,
  coursePatch: InterventionPrefsPatch | null,
  sessionPatch: InterventionPrefsPatch | null,
): InterventionPrefs

type DecideInterventionInput = {
  prefs: InterventionPrefs,              // already resolved
  trigger: InterventionTrigger,
  context: {
    userIsTyping: boolean,
    consecutiveProactiveRejects: number, // from decision ring; not wall-clock
    evidenceStrength: "low" | "ok",
    nodeKind: "teach" | "prompt" | "other",
    sessionExposures: ReadonlyArray<"hinted" | "revealed">,
    proposedKind?: string | null,
    userRequestedDepth?: "hint" | "explain" | null, // from explicit ask
  },
}

type DecideInterventionResult = {
  decision: "none" | "defer" | "offer" | "respond",
  reason: string,
}

decideIntervention(input: DecideInterventionInput): DecideInterventionResult
```

**Decision table (normative for Implement tests):**

| Trigger | Condition | Decision |
|---|---|---|
| `user_help_ask` | quietMode or proactivity off | `respond` (reason `user_request`) |
| `user_help_ask` | userRequestedDepth explain | `respond` |
| `system_proactive` / `tutor_recommend` | quietMode or proactivity `off` | `none` |
| proactive | `userIsTyping` | `none` or `defer` (`user_typing`) |
| proactive | `consecutiveProactiveRejects >= 2` | `none` (`consecutive_reject`) |
| proactive | evidenceStrength `low` && !nodes.allowOnLowEvidence | `defer` (`low_evidence`) |
| proactive | nodeKind teach/prompt disallowed by nodes | `none` (`node_disallowed`) |
| proactive | exposures include `hinted`, proposedKind full/worked_example, depth ≠ allow auto | **`offer`** not `respond` (`depth_blocks_auto_expand`) |
| proactive | proactivity `minimal` | prefer `offer` over `respond`; never invent schedule |
| — | any `intervalMinutes` / dwellStuck | **type reject / test fail** |

Constants: `CONSECUTIVE_PROACTIVE_REJECT_LIMIT = 2` (Plan default; not a time nag).

## 3. Settings nesting + persistence seams

### 3.1 Global + course (durable)

| Scope | Storage | API seam (Implement) |
|---|---|---|
| Global | `workspace_preferences.intervention_settings jsonb` | GET/PUT `/api/opening/intervention-settings` (mirror planning/ai-settings) |
| Course | `courses.intervention_settings jsonb NULL` | PATCH course learning/prefs route extension **or** dedicated nested field on existing course prefs update — **reuse course prefs API if one exists**; do not add a second course-settings product page |
| Session temp | `opening_teaching_activities.checkpoint_json.interventionPrefs` | teaching activity checkpoint patch (existing CAS patterns if any; else expectedUpdatedAt / contentVersion-aware write) |

Repo pattern: clone `opening-planning-settings.ts` / `opening-ai-settings.ts` → `opening-intervention-settings.ts` (get + upsert jsonb; DEFAULT on null/invalid; `invalidStoredSettings` flag).

Resolve: domain `resolveInterventionPrefs` (same spirit as `resolveLearningPreferences`, but deep-merge patch objects).

### 3.2 Decision log (prefer existing — explicit)

| Option | Plan choice |
|---|---|
| New `opening_intervention_decisions` table | **Rejected for M1** |
| Append to `opening_help_exposures` | **Rejected** — wrong semantics (exposure ≠ policy choice) |
| Activity `checkpoint_json.interventionDecisions` ring (max **20**) | **Accepted** — enough for consecutive reject + UI honesty |
| Learning session row column | Not needed; activity checkpoint is teaching-primary (V2-04) |

Ring append is best-effort on decision; failure to persist must not block answering an explicit user ask (fail-soft log).

### 3.3 Migration

**Migration needed: YES** (additive jsonb columns only).  
**File (Implement):** `packages/database/src/migrations/00xx_opening_intervention_settings.sql`  
**Numbering:** Integrator assigns vs live `schema_migrations`. Tip currently ends at **`0055_opening_compile_teaching_unit_job.sql`**. Keep **`00xx`** until assigned.

```sql
-- 00xx_opening_intervention_settings.sql  (SKETCH ONLY — do not apply in this slice)

-- Additive only: retain existing preferences.
ALTER TABLE workspace_preferences
  ADD COLUMN intervention_settings jsonb;

ALTER TABLE courses
  ADD COLUMN intervention_settings jsonb;

-- No decisions table in M1.
-- Rollback: stop reading column; leave jsonb in place (no DROP of user data).
```

**Backup:** On Implement, ensure backup/restore allowlists treat new jsonb columns like `ai_settings` / `planning_settings` (preferences row + courses row already in learning-state backup paths — verify column round-trip; no new table registration if no new table).

## 4. Attach point inventory (read-only)

| Surface | How V2-11 attaches |
|---|---|
| V2-04 activity | Session overlay + decision ring in `checkpoint_json`; activityId on decision records |
| Learning session / help | Exposures remain facts; decision consults `sessionExposures` but does not rewrite exposures |
| `recommendTutorAction` / adaptive | Remains candidate generator; **callers** of proactive path must `decideIntervention` before UI offer or auto-act |
| Thin path `hinted`→`worked_example` | Treat proposedKind as escalate candidate → decision max `offer` unless user_help_ask |
| V2-10 TeachingWorkspace | Experience: mount preference-controls; pass `userIsTyping` / reject clicks into decision context |
| Tutor offer / ephemeral reply | Explicit user message → `user_help_ask`; system nudge card → `system_proactive` |
| UX modes (manual/copilot/coach) | Map: quiet/off ≈ manual proactive; balanced ≈ copilot; high may offer more — **does not** replace UX mode enum; intervention prefs are teaching-interrupt controls nested in settings |

## 5. Experience preview (Data does not implement UI)

| Path | Owner | Note |
|---|---|---|
| `apps/web/src/features/opening/teaching/preference-controls.tsx` | Experience | View / edit effective prefs; quiet toggle; reset to default; show that session temp ≠ permanent; wire typing/reject events |
| Settings entry | Experience | Nest control into existing Opening settings / teaching chrome — **no parallel settings product** |

Data Implement delivers contracts + domain + persistence APIs so Experience can bind without inventing policy.

## 6. Tests list (Implement; all `not_run` at Plan stage)

| ID | Check |
|---|---|
| T1 | Contract: prefs / patch / decision parse; reject unknown keys; reject dwellStuck / mustAskEvery fields if present in fixtures |
| T2 | `resolveInterventionPrefs`: session > course > global; missing keys inherit; temp patch does not mutate global object identity unexpectedly |
| T3 | Quiet / proactivity off + `user_help_ask` → `respond` |
| T4 | Quiet / off + `system_proactive` → `none` |
| T5 | `userIsTyping` + proactive → `none`\|`defer` (`user_typing`) |
| T6 | `consecutiveProactiveRejects >= 2` → `none` (`consecutive_reject`); counter from decision ring helper |
| T7 | Low evidence + `allowOnLowEvidence: false` → `defer` |
| T8 | `hinted` in exposures + proposed worked_example/explain → **`offer`**, never `respond` (`depth_blocks_auto_expand`) |
| T9 | Explicit ask for explain/`userRequestedDepth: explain` → `respond` even if hinted |
| T10 | No hardcoded interval: grep/static or API surface test — policy module exports no `N_MINUTES` / `mustAskEvery` |
| T11 | Persistence: PUT global settings round-trip; invalid jsonb → defaults + `invalidStoredSettings` |
| T12 | Session overlay write does not change workspace/course stored prefs (repo integration or unit with fakes) |
| T13 | Reset / view: GET returns effective + layers; reset clears session overlay and/or restores DEFAULT (per API design) |
| T14 | Regression: `tutor-policy` unit still green; add gate helper test that escalate-after-hint cannot auto-respond |

**Plan-stage:** all above **`not_run`**.

## 7. Rejected alternatives

| Alt | Why rejected |
|---|---|
| Parallel settings product / separate prefs app | PM lock: nest into existing settings model |
| Dwell-time → stuck inference | PM lock; false positives; not in types |
| Auto-reveal / auto-respond full answer after hint | PM lock; conflicts anti-代学 + adaptive “request-driven” |
| Hardcoded must-ask every N minutes | PM lock; acceptance forbids |
| New `opening_intervention_decisions` table in M1 | Prefer checkpoint ring; Integrator can add later if audit required |
| Stuff fields into `ai_settings` | Wrong concern (routing/budget); pollutes Zod strict object |
| Overload reminder `quietHours` | Different product (external channel quiet); keep teaching quietMode separate |
| Invent migration `0056` as assigned | Integrator-only; keep `00xx` |
| Infer prefs from UX mode alone without explicit controls | Acceptance requires user-visible set/view/reset |

## 8. Migration + rollback

| Item | Plan decision |
|---|---|
| Migration needed? | **Yes** — `00xx_opening_intervention_settings.sql` (two ADD COLUMN jsonb) |
| Decisions DDL? | **No** (M1) |
| Number | Placeholder **`00xx`**; tip ends **0055** |
| Backup | Verify jsonb columns on existing preferences/courses backup paths |
| Rollback | Feature-flag / stop calling decide for proactive; retain columns; keep answering user asks; **do not** rewrite historical help exposures or learning evidence |

## 9. Open questions (Plan defaults)

1. **Default proactivity:** **`balanced`**.  
2. **Decision store:** **checkpoint ring (20)**; no new table.  
3. **Course override:** **nullable jsonb partial** on `courses`.  
4. **Hint escalate:** recommend may still *propose* worked_example; **decision forbids auto `respond`**; UI may `offer`.  
5. **Consecutive reject limit:** **2** proactive rejects in ring (not time-based).  
6. **API path name:** `/api/opening/intervention-settings` (Plan default) vs nest under ai-settings route — prefer **sibling** of planning/ai-settings for clear Zod boundary.

Escalate to Paula only if a default is rejected.

## 10. Implement gate (after Plan ACCEPT)

1. Integrator / designated Reviewer **ACCEPT** this Plan.  
2. Integrator assigns migration number replacing `00xx`.  
3. Separate Implement slices:  
   - **Data:** contracts → migration → repo → `intervention-policy` + tests T1–T14 → thin API routes → evidence per `review-test-gates.md`.  
   - **Experience:** `preference-controls.tsx` + workspace wiring (typing/reject) — after or parallel once contracts stable.  
4. **This document does not authorize ALTER or product code.**

## 11. Files to add/change at Implement (preview)

| Path | Action | Owner |
|---|---|---|
| `packages/contracts/src/opening/intervention-prefs.ts` (+ test) | New | Data |
| `packages/contracts/src/opening/index.ts` | Export | Data |
| `packages/domain/src/opening/intervention-policy.ts` (+ test) | New | Data |
| `packages/domain/src/opening/tutor-policy.ts` | Optional: document/gate helper; do not silently auto-act | Data |
| `packages/database/src/migrations/00xx_opening_intervention_settings.sql` | New (Integrator renumbers) | Data |
| `packages/database/src/schema/preferences.ts` + `courses.ts` | Add jsonb columns | Data |
| `packages/database/src/repositories/opening-intervention-settings.ts` | New | Data |
| `apps/web/src/app/api/opening/intervention-settings/route.ts` | New | Data/Service |
| Checkpoint write helper on teaching activity | Session overlay + decision ring | Data |
| `apps/web/src/features/opening/teaching/preference-controls.tsx` | New | **Experience** |
| Backup allowlists / learning-state column checks | Verify jsonb round-trip | Data |

**Not touching in V2-11 Data Implement:** V2-12 commands; V2-13 evidence semantics; Experience layout beyond API readiness; push/hermes.
