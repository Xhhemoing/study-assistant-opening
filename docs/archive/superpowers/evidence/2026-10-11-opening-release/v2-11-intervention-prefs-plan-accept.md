# V2-11 Intervention prefs — Plan ACCEPT

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Reviewer:** AIstudy Integrator (executor / Grok Bot) — **≠** plan author (AIstudy Data)  
**Stage:** Plan ACCEPT only (no product Implement, no ALTER, no SQL file create, no push / hermes / stash / reset / commit)  
**Branch:** `feat/opening-release`  
**Tip SHA verified:** `0436946ed1dd58aa414313bb1283e9f2e7f162c3` (`0436946`)  
**Baseline:** V2-10 merged at tip; dirty tree = V2-11 plan docs + claim evidence + this accept (+ migr assign note) + unrelated untracked evidence only  
**Gates:** `docs/superpowers/plans/opening-release/review-test-gates.md` + delivery-loop Plan gate (stronger review of design claims vs tip APIs/schema)  
**Docs reviewed:**
- `docs/superpowers/plans/ai-led-learning-v2/v2-11-intervention-prefs-understand.md`
- `docs/superpowers/plans/ai-led-learning-v2/v2-11-intervention-prefs-plan.md`
- `docs/superpowers/evidence/2026-10-11-opening-release/v2-11-intervention-prefs-plan-implement.md` (Plan-stage claim evidence)
- Authority: `plan.md` §V2-11 (L545–563); `tasks.json` V2-11; ADR teaching-activity-context; UX_AND_AI_POLICY modes

## Verdict

**ACCEPT**

Plan matches PM locks (session > course > global; help-ask ≠ interrupt; `none|defer|offer|respond` + reason; no dwell stuck; no auto-expand after hint; no N-minute nag; nest settings — no parallel product), tip `0436946` surfaces, Data vs Experience split, and honest DDL with placeholder → Integrator-assigned **0056**. Soft gaps listed for Implement (do not overturn ACCEPT).

## Tip / tree verification

```text
$ git rev-parse HEAD
0436946ed1dd58aa414313bb1283e9f2e7f162c3

$ git branch --show-current
feat/opening-release

$ git log -1 --oneline
0436946 feat(opening): V2-10 teaching workspace UI + client-init

$ test ! -f packages/domain/src/opening/intervention-policy.ts \
  && test ! -f packages/contracts/src/opening/intervention-prefs.ts \
  && test ! -f apps/web/src/features/opening/teaching/preference-controls.tsx \
  && echo absent
absent

$ ls packages/database/src/migrations/*.sql | tail -3
…/0053_opening_teaching_activities.sql
…/0054_opening_teaching_content.sql
…/0055_opening_compile_teaching_unit_job.sql
# no 0056* at Plan ACCEPT start; assign note only (no SQL created)
```

**Result:** tip OK. Proposed product files **absent** (Plan-only honored). Migrations tip ends **0055**.

## Claimed PM alignment (verify)

| Claim | Plan / Understand coverage | Spot-check | Result |
|---|---|---|---|
| Preference stack: session > course > global | Plan §1.2–1.3; `resolveInterventionPrefs`; T2 | Link graph + deepPartial patches; session in `checkpoint_json.interventionPrefs` does not write-through | **Pass** |
| Help-seeking ≠ interruption | Plan §1.3 #3–4; decision table; T3/T4/T9 | `user_help_ask` → `respond` even when quiet/off; proactive quiet → `none` | **Pass** |
| Record none/defer/offer/respond | Plan §1.1, §1.4, contracts sketch; ring in checkpoint | Decision ≠ `opening_help_exposures`; ring max 20 for consecutive-reject | **Pass** |
| No hardcoded timed questioning | Plan §1.3 #7; rejected alts; T10 | No `intervalMinutes` / `mustAskEvery` in types; tests assert absence | **Pass** |
| Experience owns UI half | Plan §5, §11; Understand §6 | `preference-controls.tsx` Experience; Data delivers contracts/domain/API | **Pass** |
| Nest settings (no parallel product) | Plan §3, §7 | Sibling jsonb like `ai_settings` / `planning_settings`; not inside `ai_settings`; not reminder `quietHours` | **Pass** |
| Plan-only (no product Implement) | Plan hard rules; claim evidence | Product tree unchanged; docs + evidence only | **Pass** |

## Stronger-review table (claims vs tip `0436946`)

| Claim | File / API on tip | Result |
|---|---|---|
| jsonb-on-`workspace_preferences` nest pattern | `preferences.ts` `aiSettings` / `planningSettings`; migr `0036` / `0047`; repos `opening-ai-settings.ts` / `opening-planning-settings.ts`; APIs `/api/opening/ai-settings`, `/api/opening/planning-settings`; `DEFAULT_*` + `invalidStoredSettings` | **Pass** |
| Course prefs resolve pattern exists | `learning-preferences.ts` `resolveLearningPreferences`; courses boolean columns via `0031`; API `courses/[id]/preferences` | **Pass** (pattern exists; see soft gap — booleans ≠ jsonb) |
| Activity checkpoint session home | `0053` `checkpoint_json JSONB NOT NULL DEFAULT '{}'`; contracts `checkpointJson` opaque; repo CAS via `expectedUpdatedAt` / draft merge in teaching-content | **Pass** |
| Help exposures remain facts | `opening_help_exposures` in `opening-learning.ts`; Plan keeps decision ring separate | **Pass** |
| Thin tutor escalate after hint | `tutor-policy.ts` L205–211: `hinted` → `kind: "worked_example"` (“offer full example if still stuck”) | **Pass** (Plan gates via decide → max `offer`) |
| Adaptive keeps worked_example request-driven | `tutor-policy-adaptive.ts` comment + order | **Pass** (aligns with depth_blocks_auto_expand) |
| Reminder quiet ≠ teaching quiet | `reminder-policy.ts` `quietHours`; Plan rejects overload | **Pass** |
| Proposed paths match plan.md / tasks.json | `intervention-policy.ts`; `preference-controls.tsx` | **Pass** (absent = proposed) |
| plan.md §V2-11 acceptance | L545–563: set/view/reset; no N-minute; temp≠permanent; quiet+user-ask; consecutive reject; low evidence; no focus steal while typing | **Pass** (T2–T7, T12–T13 cover) |
| No invented silent APIs claimed as landed | Sibling `/api/opening/intervention-settings` + course nest → **proposed** | **Pass** (honest sketches) |
| Migration placeholder honesty | Plan `00xx`; tip ends 0055; reject inventing 0056 in Plan body | **Pass** → Integrator assigns **0056** at ACCEPT (see migr note) |
| Backup awareness | Plan §3.3 / §8: verify jsonb round-trip on existing prefs/courses backup paths | **Pass** design; Implement must extend allowlists (soft gap) |

### Invented / soft-named pieces (not REJECT)

| Sketch | Reality on tip | Integrator note |
|---|---|---|
| `courses.intervention_settings` jsonb | Courses have **boolean** learning prefs only (`assessment_enabled`, etc.); jsonb settings live on `workspace_preferences` today | Soft gap #1 — additive jsonb on courses is OK Plan default; do not confuse with boolean learning-prefs merge |
| Course PATCH seam | `courses/[id]/preferences` updates **learning** booleans only | Soft gap #2 — Implement must nest intervention without a second settings product page (extend route or nested field; document in implement evidence) |
| `resolveInterventionPrefs` deepPartial | `resolveLearningPreferences` is boolean AND, not deep merge | Soft gap #3 — correctly **do not** copy learning-preferences semantics; mirror settings jsonb patch spirit |
| Backup column lists | `opening-backup-course-records.ts` SELECT + parse lists `ai_settings`/`planning_settings` explicitly; apply column allowlists same | Soft gap #4 — Implement **must** add `intervention_settings` to read/parse/apply + contracts schema parse |
| Checkpoint ring helper | checkpoint merge exists for drafts; no intervention keys yet | Soft gap #5 — merge must not clobber `drafts`/anchors; CAS/`expectedUpdatedAt` where available |
| Callers of proactive recommend | `recommendTutorAction` is candidate only; Plan requires callers to `decideIntervention` before surface/auto-act | Soft gap #6 — Implement inventory proactive consumers (worker/tutor-turn/UI); gate escalate-after-hint |
| `/api/opening/intervention-settings` | Absent (sibling of planning/ai-settings proposed) | Soft gap #7 — thin route at Implement; mirror invalidStoredSettings |
| `preference-controls.tsx` | Absent | Soft gap #8 — Experience owns; await Experience Plan/Implement after contracts stable |
| Live `schema_migrations` | Not queried | Soft gap #9 — renumber if live max ≥ 0056 before apply |

None drop a PM constraint or invent silent DDL as already applied.

## DDL / migration stance

| Item | Decision |
|---|---|
| New DDL for V2-11? | **Yes** — additive jsonb columns only |
| Decisions table M1? | **No** (checkpoint ring) |
| Plan placeholder | `00xx_opening_intervention_settings.sql` (correct at Plan-author stage) |
| Integrator assignment at Plan ACCEPT | **0056** — next free after tip `0055`; see `v2-11-migration-number-assigned.md` |
| SQL file created now? | **No** — assign note only; Data creates `0056_…sql` at Implement |
| ALTER / migrate applied? | **No** |

## Ownership split

| Role | V2-11 Plan | Integrator check |
|---|---|---|
| Data | contracts, migr 0056, schema, repo, `intervention-policy` + T1–T14, thin API, checkpoint overlay/ring helper, backup column checks | Matches Understand/Plan; domain policy owner |
| Experience | `preference-controls.tsx` + workspace typing/reject wire; nest into existing settings chrome | **Await** Experience Plan ACCEPT + PM; Data must not implement UI |
| Integrator | Plan/Implement ACCEPT; migr number assign | This document = Plan ACCEPT + **0056** assign |

## Acceptance-test strength (Plan gate)

| Rule | Guard in Plan | Could tests pass by hiding it? |
|---|---|---|
| session > course > global | T2 resolve + inherit; T12 session write ≠ mutate durable | **No** if T2 asserts field-level override and T12 uses fakes/integration |
| Help-ask ≠ interrupt | T3 quiet+ask→respond; T4 quiet+proactive→none; T9 explain ask→respond | **No** if both triggers asserted (cannot collapse to one quiet check) |
| No auto-expand after hint | T8 hinted+worked_example → **offer** not respond; T14 gate helper | **No** if T8 asserts `decision === "offer"` **and** `!== "respond"` |
| No N-minute nag | T10 no `N_MINUTES`/`mustAskEvery` export; types reject dwellStuck | **No** if static/API surface test runs |
| Consecutive reject / typing / low evidence | T5–T7 | **No** if reasons asserted |

**Implement Accept must** re-run named vitest (contract + `intervention-policy` + tutor regression) and confirm T2/T3/T4/T8/T10 cannot be skipped or loosened.

## Soft gaps / honesty (do not overturn ACCEPT)

1. **courses jsonb** is new vs boolean learning prefs — keep overlay semantics explicit.  
2. **Course PATCH seam** underspecified — nest without second product page.  
3. **deepPartial ≠** `resolveLearningPreferences` boolean AND — implement merge correctly.  
4. **Backup allowlists** must gain `intervention_settings` + zod parse.  
5. **Checkpoint merge** must preserve drafts/anchors + CAS.  
6. **Proactive caller inventory** + gate thin escalate before surface/auto-act.  
7. **API route** sibling thin wire at Implement.  
8. **Experience UI** separate half — not Data Implement.  
9. **Live schema_migrations** unverified — renumber if needed before apply.  
10. Plan-stage product checks T1–T14 / vitest / tsc — honestly **`not_run`**.

## Open decisions for PM

**None that block Plan ACCEPT.** If Plan-ACCEPTed without comment, treat Plan §9 defaults as confirmed:

1. Default proactivity **`balanced`**.  
2. Decision store = **checkpoint ring (20)**; no new table M1.  
3. Course override = **nullable jsonb partial** on `courses`.  
4. Hint escalate: recommend may propose; **decision forbids auto `respond`**; UI may `offer`.  
5. Consecutive proactive reject limit = **2** (not time-based).  
6. API path = sibling `/api/opening/intervention-settings`.

## not_run (Plan ACCEPT)

| Check | Status | Reason |
|---|---|---|
| vitest intervention-policy / contracts / repo / API | **`not_run`** | Modules not landed |
| tutor-policy regression | **`not_run`** | Plan stage; no product change this slice |
| tsc / typecheck | **`not_run`** | Docs-only |
| Browser / Experience preference-controls | **`not_run`** | Experience owns UI; N/A Plan |
| migrate apply / ALTER | **`not_run`** | Assign number only; no SQL yet |
| Live `schema_migrations` query | **`not_run`** | Box may lack hermes DB |
| push / hermes / commit | **`not_run`** | Forbidden |

Per gates: Plan Accept does not require re-running product tests never claimed as run.

## Scope confirmation

- Integrator did **not** implement product code.  
- Integrator did **not** create `0056_*.sql`.  
- Integrator did **not** commit / push / stash / reset / hermes / apply migrate.  
- Integrator did **not** change `tasks.json` status.  
- Integrator **did** assign migr **0056** via `v2-11-migration-number-assigned.md`.

## Handoff

1. **Plan ACCEPT** recorded.  
2. Migr **0056** assigned (note file); Data Implement replaces `00xx` → `0056_opening_intervention_settings.sql` when Implement opens.  
3. Separate slices: Data (contracts → migr → repo → policy + T1–T14 → thin API → backup columns) + Experience UI (after contracts stable / Experience Plan ACCEPT).  
4. Independent **Implement ACCEPT** required after product work (implementer ≠ accepter).

## One-line soft gaps

courses jsonb vs boolean prefs + course PATCH nest TBD; backup column lists must extend; checkpoint merge must not clobber drafts; proactive caller gate inventory; Experience UI separate; live schema_migrations unchecked; T1–T14/vitest `not_run`.
