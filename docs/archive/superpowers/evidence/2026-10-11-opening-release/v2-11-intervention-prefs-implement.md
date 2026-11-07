# V2-11 Intervention prefs — Implement Evidence

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Data implementer (executor / Grok Bot)  
**Branch:** `feat/opening-release`  
**Tip HEAD (baseline; dirty tree, no commit):** `0436946ed1dd58aa414313bb1283e9f2e7f162c3` (`0436946`)  
**Status:** **implemented, awaiting Integrator Implement ACCEPT** — do **not** self-ACCEPT; `tasks.json` not marked verified  
**Hard rules held:** No push / hermes / stash / reset / commit · No Experience UI (`preference-controls.tsx`) · Exclusive tree (unrelated untracked evidence / plan docs left as-is)

## Authority followed

- Plan ACCEPT: `docs/superpowers/evidence/2026-10-11-opening-release/v2-11-intervention-prefs-plan-accept.md`
- Plan: `docs/superpowers/plans/ai-led-learning-v2/v2-11-intervention-prefs-plan.md`
- Understand: `docs/superpowers/plans/ai-led-learning-v2/v2-11-intervention-prefs-understand.md`
- Migr assign: **0056** → `packages/database/src/migrations/0056_opening_intervention_settings.sql`
- Gates: `docs/superpowers/plans/opening-release/review-test-gates.md`
- PM locks: proactivity=`balanced`; depth=`hint_then_offer`; ring max 20; course overlay nullable partial; consecutive proactive reject limit **2**; API `/api/opening/intervention-settings`

## Diff scope

### New

| Path | Role |
|---|---|
| `packages/contracts/src/opening/intervention-prefs.ts` | Prefs / patch / decision / response schemas; `DEFAULT_OPENING_INTERVENTION_PREFS`; ring max 20; reject limit 2 |
| `packages/contracts/src/opening/intervention-prefs.test.ts` | T1 contract tests |
| `packages/database/src/migrations/0056_opening_intervention_settings.sql` | ADD `intervention_settings` jsonb NOT NULL DEFAULT (PM default) on `workspace_preferences`; nullable on `courses`; no decisions table |
| `packages/database/src/repositories/opening-intervention-settings.ts` | Global get/set; course overlay get/set; resolve (session>course>global); session checkpoint overlay; decision ring append (CAS via `expectedUpdatedAt`) |
| `packages/domain/src/opening/intervention-policy.ts` | `resolveInterventionPrefs`, `decideIntervention`, ring helpers, gate helper |
| `packages/domain/src/opening/intervention-policy.test.ts` | T2–T10, T12, T14 (+ node/minimal) |
| `apps/web/src/app/api/opening/intervention-settings/route.ts` | Thin GET/PUT (global; `?courseId=` overlay; `?activityId=` session temp) |

### Updated

| Path | Change |
|---|---|
| `packages/contracts/src/opening/index.ts` | Export intervention-prefs |
| `packages/domain/src/index.ts` | Export intervention-policy API |
| `packages/database/src/index.ts` | Export intervention settings repo |
| `packages/database/src/schema/preferences.ts` | `interventionSettings` jsonb NOT NULL default |
| `packages/database/src/schema/courses.ts` | `interventionSettings` jsonb nullable |
| `packages/database/src/repositories/opening-backup-course-records.ts` | SELECT + zod parse for new columns |
| `packages/database/src/repositories/opening-backup-apply.ts` | Restore column allowlists + JSONB_COLUMNS |
| `packages/domain/src/opening/backup-learning-state.ts` | Validate intervention_settings on prefs + courses |
| `packages/domain/src/opening/tutor-policy.ts` | Comment: escalate-after-hint is suggestion-only; gate via decide |

### Explicitly not touched

- **No** `apps/web/src/features/opening/teaching/preference-controls.tsx` (Experience owns; awaits Implement ACCEPT)
- No learning evidence / help exposure rewrite
- No new decisions table
- No `tasks.json` → verified; no push / commit / hermes / stash / reset
- No self-ACCEPT
- Unrelated untracked evidence / plan docs left as-is

## Behavior landed

| Item | Detail |
|---|---|
| Precedence | session (`checkpoint_json.interventionPrefs`) > course jsonb partial > global |
| Temp ≠ permanent | `setSessionOverlay` merges checkpoint only; never writes workspace/course prefs |
| Decision ring | `checkpoint_json.interventionDecisions[]` max **20**; consecutive proactive reject limit **2** |
| Help-ask ≠ interrupt | quiet / proactivity off still `respond` on `user_help_ask` |
| No dwell stuck | types reject `allowOnDwell` / `dwellStuck`; module exports no `N_MINUTES` / `mustAskEvery` |
| No auto-expand after hint | hinted + worked_example → **`offer`** not `respond` (`depth_blocks_auto_expand`) |
| Tutor gate | `gateTutorRecommendAfterDecision` / `mayAutoRespondProactive`; recommend path documented suggestion-only |
| API | Sibling `/api/opening/intervention-settings` GET/PUT; course via `?courseId=`; session via `?activityId=` (nest, no second settings product) |
| Defaults | `balanced` / `hint_then_offer` / nodes teach+prompt true / lowEvidence false / quiet false |

## Soft gaps (honest)

1. **Migrate apply `not_run`** — local DB `ECONNREFUSED`; SQL file landed only. Live `schema_migrations` could not be queried; if live max ≥ 0056, Integrator must renumber before apply.
2. **T11 / T13 persistence + API round-trip `not_run`** — need DB / HTTP integration env.
3. **T12 repo write path** — pure checkpoint merge unit-tested; SQL write path untested without DB.
4. **Experience UI** — deferred; Data does not implement `preference-controls.tsx`.
5. **Proactive caller inventory** — domain gate helper + tutor-policy comment landed; `tutor-actions.ts` / worker not wired to `decideIntervention` yet (soft attach for Experience / later thin PR).
6. **Course prefs boolean route** — intervention overlay exposed on sibling intervention-settings API with `courseId` (not stuffed into learning-boolean PUT) to avoid second product page and avoid clashing boolean semantics.

## Commands run + results

### Tip

```text
$ git rev-parse HEAD
0436946ed1dd58aa414313bb1283e9f2e7f162c3

$ git branch --show-current
feat/opening-release
```

### Live schema_migrations / migrate

```text
$ # DATABASE_URL present in .env but postgres ECONNREFUSED
DB_UNAVAILABLE: ECONNREFUSED
# migrate apply → not_run (honest)
# schema_migrations live max → not_run (cannot query)
```

### Unit (focused)

```text
$ pnpm exec vitest run \
    packages/contracts/src/opening/intervention-prefs.test.ts \
    packages/domain/src/opening/intervention-policy.test.ts \
    packages/domain/src/opening/tutor-policy.test.ts
# exit 0 — 3 files, 29 tests passed
#   contracts T1: 5
#   intervention-policy T2–T10,T12,T14 (+node/minimal): 14
#   tutor-policy regression: 10

$ pnpm exec vitest run \
    packages/domain/src/opening/backup-learning-state.test.ts \
    packages/domain/src/opening/learning-preferences.test.ts
# exit 0 — 2 files, 48 tests passed
```

### Typecheck

```text
$ pnpm exec tsc -p packages/contracts/tsconfig.json --noEmit  # exit 0
$ pnpm exec tsc -p packages/domain/tsconfig.json --noEmit     # exit 0
$ pnpm exec tsc -p packages/database/tsconfig.json --noEmit   # exit 0
$ pnpm exec tsc -p apps/web/tsconfig.json --noEmit            # exit 0
```

## T1–T14 status

| ID | Status | Notes |
|---|---|---|
| T1 | **pass** | contracts vitest |
| T2 | **pass** | resolve session>course>global; no mutate |
| T3 | **pass** | quiet/off + help_ask → respond |
| T4 | **pass** | quiet/off + proactive → none |
| T5 | **pass** | typing → none `user_typing` |
| T6 | **pass** | consecutive ≥2 → none; ring helper |
| T7 | **pass** | low evidence → defer |
| T8 | **pass** | hinted+worked_example → offer ≠ respond |
| T9 | **pass** | explain ask → respond even hinted/quiet |
| T10 | **pass** | no N_MINUTES / mustAskEvery / dwellStuck exports |
| T11 | **`not_run`** | PUT global round-trip / invalid jsonb needs DB |
| T12 | **pass** (unit) | session merge ≠ durable; ring max 20; repo SQL write `not_run` |
| T13 | **`not_run`** | GET layers + reset via API needs HTTP/DB |
| T14 | **pass** | gate helper; tutor-policy regression green |

## Handoff

1. Product Implement landed on dirty tree at tip `0436946` (no commit).  
2. Migr **0056** SQL file present; **not applied**.  
3. Experience may start `preference-controls.tsx` after Integrator Implement ACCEPT + contracts stable.  
4. Independent **Implement ACCEPT** required (implementer ≠ accepter).

## One-line

Contracts+domain T1–T10/T12/T14 green; 0056 SQL landed unapplied (DB down); thin API ready; no Experience UI; awaiting Integrator Accept.
