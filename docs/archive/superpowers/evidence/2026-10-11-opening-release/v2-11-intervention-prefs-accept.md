# V2-11 Intervention prefs — Implement ACCEPT

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Reviewer:** AIstudy Integrator (executor / Grok Bot) — **≠** implementer (AIstudy Data)  
**Stage:** Implement ACCEPT (Data half only; no Experience UI)  
**Branch:** `feat/opening-release`  
**Tip SHA verified:** `0436946ed1dd58aa414313bb1283e9f2e7f162c3` (`0436946`)  
**Tree:** dirty product land expected (no commit)  
**Gates:** `docs/superpowers/plans/opening-release/review-test-gates.md`  
**Authority:** Plan ACCEPT `v2-11-intervention-prefs-plan-accept.md`; migr assign `v2-11-migration-number-assigned.md` → **0056**; Plan `v2-11-intervention-prefs-plan.md`; Implement claim `v2-11-intervention-prefs-implement.md`  
**Hard rules held:** No push / hermes / stash / reset / commit · No migrate apply · No product fix (would REJECT) · No Experience UI required this slice

## Verdict

**ACCEPT**

Data half matches Plan ACCEPT + PM locks (session>course>global; help≠interrupt; none/defer/offer/respond; no hardcoded timed Q; balanced / hint_then_offer / max20 / refuse-cap2; API `/api/opening/intervention-settings`; migr **0056** additive jsonb). Independent re-runs green. Soft gaps honest (`not_run` where DB down). Tests not loosened. No preference-controls UI (expected — Experience later).

## Tip / dirty verification

```text
$ git rev-parse HEAD
0436946ed1dd58aa414313bb1283e9f2e7f162c3

$ git branch --show-current
feat/opening-release

$ git log -1 --oneline
0436946 feat(opening): V2-10 teaching workspace UI + client-init

$ git status --short
# Modified: contracts/domain/database index + schema prefs/courses + backup repos + backup-learning-state + tutor-policy
# Untracked: intervention-prefs (+test), intervention-policy (+test), 0056 SQL, opening-intervention-settings repo,
#            apps/web/.../intervention-settings/route.ts, plan/understand/evidence docs
# NO preference-controls.tsx
```

**Result:** tip OK; dirty product land matches Implement claim; no commit by Integrator.

## Stronger review

### 1. Sole migr 0056

| Check | Result |
|---|---|
| Filename = assign note `0056_opening_intervention_settings.sql` | **Pass** — sole `0056*` under `packages/database/src/migrations/` |
| Tip chain ends 0055 → 0056 next free | **Pass** |
| Additive jsonb only | **Pass** — `workspace_preferences.intervention_settings jsonb NOT NULL DEFAULT (PM default)`; `courses.intervention_settings jsonb` nullable |
| No decisions table / DROP / wrong kinds | **Pass** — comment documents checkpoint ring; no CREATE TABLE |
| Schema defaults match PM | **Pass** — balanced / hint_then_offer / teach+prompt true / lowEvidence false / quiet false |

### 2. Contracts / domain policy + thin API

| Claim | Spot-check | Result |
|---|---|---|
| Precedence session>course>global | `resolveInterventionPrefs` deep-partial apply; T2 asserts field override + no mutate | **Pass** |
| Help-ask ≠ interrupt | `user_help_ask` → respond even quiet/off; T3/T9; proactive quiet → none T4 | **Pass** |
| Decision kinds none/defer/offer/respond + reason | contracts enum + `decideIntervention` + ring append | **Pass** |
| No hardcoded timed Q | types reject dwellStuck/mustAskEvery/allowOnDwell/intervalMinutes; T1+T10 no exports | **Pass** |
| Defaults + ring/cap | `DEFAULT_*` balanced/hint_then_offer; RING_MAX=20; REJECT_LIMIT=2 | **Pass** |
| Decision recording | checkpoint `interventionDecisions[]` via `appendInterventionDecision` / repo `appendDecision` CAS | **Pass** |
| Thin API | `/api/opening/intervention-settings` GET/PUT; `?courseId=` overlay; `?activityId=` session temp (nest, no second product) | **Pass** |
| Temp ≠ permanent | `setSessionOverlay` merges checkpoint only; never writes workspace/course | **Pass** |
| No auto-expand after hint | T8/T14: hinted+worked_example → offer ≠ respond; gate helper | **Pass** |
| Backup columns | SELECT/parse + apply allowlists + JSONB_COLUMNS + backup-learning-state zod | **Pass** |
| Tutor gate comment | tutor-policy escalate-after-hint suggestion-only + decide gate | **Pass** |

### 3. No preference-controls UI

```text
$ test ! -f apps/web/src/features/opening/teaching/preference-controls.tsx && echo absent
absent
```

**Pass** — Data slice correctly omits Experience UI.

### 4. Tests not loosened; soft gaps honest

| Rule | Guard | Could hide miss? | Result |
|---|---|---|---|
| T2 precedence | field-level override + no mutate global | No | **Pass** |
| T3/T4 help≠interrupt | both ask→respond and proactive→none | No | **Pass** |
| T8 no auto-expand | `=== "offer"` **and** `!== "respond"` | No | **Pass** |
| T10 no nag | module keys assert absence | No | **Pass** |
| T1/T6/T12 constants | ring 20, reject 2, schema rejects dwell | No | **Pass** |

Implement claim soft gaps match reality; no pretended passes for DB/HTTP.

## 0056 check (one line)

**Sole** `packages/database/src/migrations/0056_opening_intervention_settings.sql` — additive jsonb on `workspace_preferences` (NOT NULL + PM DEFAULT) + `courses` (nullable); no decisions table; matches assign note; **not applied**.

## Re-runs (Integrator independent)

### Vitest (same commands as Implement claim)

```text
$ pnpm exec vitest run \
    packages/contracts/src/opening/intervention-prefs.test.ts \
    packages/domain/src/opening/intervention-policy.test.ts \
    packages/domain/src/opening/tutor-policy.test.ts
# exit 0 — Test Files 3 passed (3); Tests 29 passed (29)

$ pnpm exec vitest run \
    packages/domain/src/opening/backup-learning-state.test.ts \
    packages/domain/src/opening/learning-preferences.test.ts
# exit 0 — Test Files 2 passed (2); Tests 48 passed (48)
```

### Typecheck

```text
$ pnpm exec tsc -p packages/contracts/tsconfig.json --noEmit  # exit 0
$ pnpm exec tsc -p packages/domain/tsconfig.json --noEmit     # exit 0
$ pnpm exec tsc -p packages/database/tsconfig.json --noEmit   # exit 0
$ pnpm exec tsc -p apps/web/tsconfig.json --noEmit            # exit 0
```

### T1–T14 (Accept view)

| ID | Status | Notes |
|---|---|---|
| T1 | **pass** (re-run) | contracts vitest |
| T2–T10 | **pass** (re-run) | policy decision table + no nag exports |
| T11 | **`not_run`** | PUT global / invalid jsonb needs DB |
| T12 | **pass** unit (re-run); repo SQL write **`not_run`** | checkpoint merge unit green; live write needs DB |
| T13 | **`not_run`** | GET layers + reset via API needs HTTP/DB |
| T14 | **pass** (re-run) | gate helper + tutor-policy regression |

## not_run

| Check | Status | Reason |
|---|---|---|
| migrate apply / ALTER | **`not_run`** | postgres `ECONNREFUSED` (node client); SQL file landed only |
| Live `schema_migrations` query | **`not_run`** | DB unreachable; if live max ≥ 0056, renumber before apply |
| T11 persistence round-trip | **`not_run`** | needs DB |
| T13 API layers / reset | **`not_run`** | needs HTTP/DB |
| T12 repo SQL write path | **`not_run`** | unit merge only without DB |
| Browser / preference-controls | **`not_run`** | Experience owns; N/A Data Implement ACCEPT |
| push / hermes / commit | **`not_run`** | Forbidden |

## Soft gaps (do not overturn ACCEPT)

1. **Migrate apply `not_run`** — SQL present, unapplied; renumber if live max ≥ 0056.  
2. **T11 / T13 `not_run`** — persistence + API integration need DB/HTTP.  
3. **T12 repo write `not_run`** — pure checkpoint merge unit-tested only.  
4. **Experience UI** — deferred; Data correctly omitted `preference-controls.tsx`.  
5. **Proactive caller inventory** — domain gate + tutor-policy comment landed; `tutor-actions` / worker not wired to `decideIntervention` yet (soft attach for Experience / later thin PR).  
6. **Course overlay API** — sibling intervention-settings with `?courseId=` (not stuffed into learning-boolean PUT) — acceptable nest; document for Experience.

## Scope confirmation

- Integrator did **not** commit / push / stash / reset / hermes / apply migrate.  
- Integrator did **not** change `tasks.json` (Accept may mark verified separately if PM asks; this evidence = Implement ACCEPT only).  
- Integrator did **not** implement or fix product code (would REJECT).  
- Integrator **did** re-run claimed vitest (29+48) and tsc (4 packages) and record results.

## Handoff

1. **Implement ACCEPT** recorded for Data half.  
2. Migr **0056** SQL ready; apply when DB up (after live max check).  
3. Experience may start `preference-controls.tsx` after contracts stable / Experience Plan ACCEPT.  
4. Wire proactive callers to `decideIntervention` / gate as soft follow-up.

## One-line

ACCEPT — tip `0436946` dirty; vitest 29+48 + tsc×4 green; sole 0056 additive jsonb unapplied; T11/T13/migrate `not_run` (ECONNREFUSED); no Experience UI; soft gaps honest; no push/hermes/commit.
