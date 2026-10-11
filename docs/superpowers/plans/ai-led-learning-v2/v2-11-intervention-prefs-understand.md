# V2-11 Understand — 显式介入偏好与低打扰决策

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Data (executor)  
**Branch tip:** `0436946ed1dd58aa414313bb1283e9f2e7f162c3` (`feat/opening-release`) — matches required tip (V2-10 merged)  
**Delivery-loop stage:** Understand → Plan only (**no Implement, no ALTER, no push / hermes / stash / reset / commit**)  
**Authority:** `plan.md` §V2-11 (~L545+); `tasks.json` V2-11; ADR `docs/decisions/ADR-teaching-activity-context.md`; gates `docs/superpowers/plans/opening-release/review-test-gates.md`; style refs `v2-05-teaching-content-understand.md` / `v2-05-teaching-content-plan.md`

## Restated outcome

Ship **explicit intervention preferences** + a **low-interrupt decision function** so proactive teaching help respects user control without inventing a second settings product.

Concretely:

1. **Precedence:** session overlay > course > global. Set **proactivity**, **nodes** (where proactive may fire), and **depth** separately; user can turn proactive suggestions off anytime.
2. **Explicit user help ask ≠ system interrupt.** Quiet mode still answers user requests; it only suppresses *system-initiated* offers/nags.
3. **Decision record:** every policy call returns `none` | `defer` | `offer` | `respond` + `reason`. **Do not** infer “stuck” from dwell time. **Do not** auto-expand / auto-reveal answers solely because a hint was already shown.
4. **Forbid** hardcoded “must ask every N minutes” teaching rules.
5. **Nest** into the existing Opening settings model (`workspace_preferences` jsonb columns + course overrides + activity `checkpoint_json` session overlay) — **no parallel product**.
6. Data owns domain policy + contracts/schema/settings persistence seams; Experience owns UI (`preference-controls.tsx`) — Plan may preview that file; this slice does **not** implement UI.

## Why this exists (gap after V2-04 / tutor-policy / settings)

| Layer | Landed | Missing for V2-11 |
|---|---|---|
| Tutor recommend | `tutor-policy.ts` / `tutor-policy-adaptive.ts` — thin + adaptive action kinds; hint/explain exposure mapping | No explicit user prefs; thin path can escalate `hinted` → `worked_example` (“offer full example if still stuck”) without a low-interrupt gate |
| UX policy | `UX_AND_AI_POLICY.md` §3 modes (manual / copilot default / coach); §5 anti-代学 | No machine-readable intervention prefs or decision enum wired to teaching activity |
| Settings nesting | `ai_settings` / `planning_settings` jsonb on `workspace_preferences`; learning prefs account×course resolve | No `intervention_settings`; no session>course>global resolve for intervention |
| Activity / session | V2-04 `opening_teaching_activities` + `checkpoint_json`; learning sessions + `opening_help_exposures` | No decision log seam; no session-temp prefs that must not overwrite permanent |
| UI | V2-10 workspace landed; `ui.quiet` secondary patterns | `preference-controls.tsx` **absent** (Experience) |

## Inventory (paths cited)

### 1. Authority / task

- `docs/superpowers/plans/ai-led-learning-v2/plan.md` §V2-11 — reuse `tutor-policy.ts`, `UX_AND_AI_POLICY.md`; proposed `intervention-policy.ts` + `preference-controls.tsx`; verify temp≠permanent, quiet+user-ask, consecutive reject, low evidence, no focus steal while typing; accept: settings immediate + view/reset; no universal N-minute ask.
- `tasks.json` V2-11 — depends_on V2-04; goals G3/G4; status `proposed`; evidence_status all `not_run` / pending_user.
- Plan test hint (Implement later): `packages/domain/src/opening/intervention-policy.test.ts` (cited in plan.md verification block ~L276).

### 2. Tutor / help surfaces (attach points)

| Path | Role for V2-11 |
|---|---|
| `packages/domain/src/opening/tutor-policy.ts` | Existing recommend + exposure helpers; **must be gated** by new decision fn (especially thin `hinted`→`worked_example` escalate) |
| `packages/domain/src/opening/tutor-policy-adaptive.ts` | Adaptive order already keeps `worked_example` / `guided` **request-driven** — align intervention prefs with that stance |
| `packages/contracts/src/opening/tutor.ts` | `TutorMode` listen/hint/explain/think_together |
| `packages/database/src/schema/opening-learning.ts` | `opening_help_exposures` (`hinted`/`revealed`, delivered); sessions with `activity_id` |
| `apps/worker` / tutor-turn (existing) | Consumer of recommend — read-only note: call `decideIntervention` before proactive surface |

### 3. Settings nesting patterns (reuse, do not fork product)

| Pattern | Path | V2-11 use |
|---|---|---|
| AI settings jsonb | `packages/contracts/src/opening/ai-settings.ts` + migration `0036` + repo `opening-ai-settings.ts` + API `/api/opening/ai-settings` | Template for contract + DEFAULT_* + GET/PUT + invalidStoredSettings |
| Planning settings jsonb | `planning-settings.ts` + `0047` + `DEFAULT_OPENING_PLANNING_SETTINGS` | Same jsonb-on-`workspace_preferences` nesting |
| Learning prefs resolve | `packages/domain/src/opening/learning-preferences.ts` + `workspace-preferences.ts` + courses columns | **Precedence pattern** (account × course); extend mentally to session > course > global for intervention |
| Reminder quiet hours | `reminder-policy.ts` | Analogue of “quiet suppresses outbound”; **not** teaching interrupt prefs — do not overload reminder quietHours |

**Explicit:** Nesting means a new `intervention_settings` jsonb **column family** on the existing preferences tables (like `ai_settings` / `planning_settings`), **not** stuffing fields into `ai_settings.routes`, and **not** a separate settings app / parallel product.

### 4. V2-04 teaching activity / checkpoint

- Migration tip for teaching: `0053_opening_teaching_activities.sql` — `checkpoint_json JSONB NOT NULL DEFAULT '{}'`
- Contracts: `teaching-activity.ts` — `checkpointJson` opaque record
- **Session overlay home (Plan default):** `checkpoint_json.interventionPrefs` (temp) + `checkpoint_json.interventionDecisions[]` (ring) — survives mid-lesson; must not write through to permanent global/course on temp set
- Activity is primary teaching identity (ADR); learning session remains facts path for help exposures

### 5. Migrations tip

Live migrations under `packages/database/src/migrations/` end at **`0055_opening_compile_teaching_unit_job.sql`**. Any new DDL uses placeholder **`00xx`**; Integrator assigns.

### 6. Proposed / absent product files

- `packages/domain/src/opening/intervention-policy.ts` — **absent** (Data Implement)
- `apps/web/src/features/opening/teaching/preference-controls.tsx` — **absent** (Experience Implement)
- No existing V2-11 understand/plan docs before this slice

## Out of scope (OOS) for V2-11 Understand+Plan

- **No product Implement** / no UI / no ALTER / no migrate / no commit / push / hermes / stash / reset.
- Inventing migration numbers (keep `00xx`; tip ends **0055**).
- Dwell-time stuck detection; auto-reveal after hint; fixed N-minute nag timers.
- Parallel settings product or second preference store outside `workspace_preferences` / courses / activity checkpoint.
- Changing mastery / observation evidence semantics (V2-13); local commands (V2-12); resume package (V2-14).
- Moving `tasks.json` → verified / in_progress.

## Open decisions for PM / Paula

Only items that change product meaning (Plan defaults below; escalate if Paula disagrees):

1. **Default proactivity** when unset: **`balanced`** (aligns with UX copilot default) vs `minimal`. Plan default = **`balanced`**, with one-click quiet / proactivity `off`.
2. **Decision durability:** checkpoint ring on activity vs new decisions table. Plan default = **checkpoint ring only** for M1 (enough for consecutive-reject / typing); no new audit table unless PM requires exportable history.
3. **Course override shape:** nullable `intervention_settings` jsonb on `courses` (partial overlay) vs boolean-only flags. Plan default = **jsonb partial overlay** (mirrors learning-prefs partial update spirit).
4. **Thin tutor escalate after hint:** gate via `decideIntervention` → at most `offer` (never auto `respond` with full answer) vs delete escalate from `recommendTutorAction`. Plan default = **keep recommend suggestion, but consumers must run decision; decision forbids auto-respond escalate from hint alone**.

If PM ACCEPTS Plan with these defaults, no further PM gate beyond ordinary Plan ACCEPT before Implement.

## Ready for Plan?

**Yes.** Inventory closed; settings nesting + activity checkpoint attach clear; tutor escalate conflict identified; stop here until Plan is written and Plan ACCEPT granted before any Implement.
