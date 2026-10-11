# V2-11 Intervention prefs — Experience UI Implement ACCEPT

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Reviewer:** AIstudy Integrator (executor / Grok Bot) — **≠** implementer (AIstudy Experience)  
**Stage:** Implement ACCEPT (Experience UI half only; no Data migr/API rewrite)  
**Branch:** `feat/opening-release`  
**Tip SHA verified:** `c134d66aea3b65871083070709a9629bfca4afdc` (`c134d66`) — Data half merged  
**Tree:** dirty Experience UI land (no commit)  
**Gates:** `docs/superpowers/plans/opening-release/review-test-gates.md`  
**Authority:** Plan ACCEPT `v2-11-intervention-prefs-plan-accept.md`; Data ACCEPT `v2-11-intervention-prefs-accept.md`; Experience Implement claim `v2-11-intervention-prefs-experience-implement.md`  
**Hard rules held:** No push / hermes / stash / reset / commit · No product fix (would REJECT) · No Data rewrite

## Verdict

**ACCEPT**

Experience UI half matches Plan/Data ACCEPT + PM locks: preference-controls nest into existing settings + teaching chrome; session > course > global display/edit; help≠interrupt / quiet still answers help; session temp ≠ permanent visible; view/reset; no dwell-stuck / N-minute nag / auto-expand-after-hint UI. Client wires Data `/api/opening/intervention-settings`. Soft gap on `appendDecision` HTTP honest (`not_run`/soft). Independent re-runs green (55 vitest + apps/web tsc). Browser honestly `not_run` (PM/plan soft-deferred). Tests not loosened.

## Tip / dirty verification

```text
$ git rev-parse HEAD
c134d66aea3b65871083070709a9629bfca4afdc

$ git branch --show-current
feat/opening-release

$ git log -1 --oneline
c134d66 feat(opening): V2-11 intervention prefs + policy (Data half)

$ git status --short  # Experience UI only (product)
 M apps/web/src/features/opening/client/api.test.ts
 M apps/web/src/features/opening/client/api.ts
 M apps/web/src/features/opening/teaching/teaching-workspace.test.ts
 M apps/web/src/features/opening/teaching/teaching-workspace.tsx
 M apps/web/src/features/settings/settings-view.nav.test.ts
 M apps/web/src/features/settings/settings-view.tsx
?? apps/web/src/features/opening/teaching/intervention-decision-context.ts
?? apps/web/src/features/opening/teaching/preference-controls.test.ts
?? apps/web/src/features/opening/teaching/preference-controls.tsx
# (+ unrelated untracked evidence + this accept; claim implement.md already present)

$ git diff --name-only HEAD -- packages/database packages/domain packages/contracts
# (empty — Data half untouched this slice)
```

**Result:** tip `c134d66` OK; dirty Experience UI land matches Implement claim; no Data migr/contracts/policy rewrite; Integrator did not commit.

## Stronger review

### 1. preference-controls present; session > course > global; help ≠ interrupt; no timed nag

| Claim | Spot-check | Result |
|---|---|---|
| `preference-controls.tsx` landed | New file + `PreferenceControls` / `PreferenceControlsView` | **Pass** |
| Display winning layer session > course > global | `winningLayer` / `winningLayerLabel`; EffectiveSummary `data-winning-layer` + order copy | **Pass** |
| Edit scopes | `scope="global"` → durable settings; `scope="session"` → checkpoint overlay + CAS `expectedUpdatedAt`; session missing activityId guarded | **Pass** |
| Session ≠ permanent visible | Session banner `data-session-temp-banner`; save/clear labels「本课临时」; description「不会写回」 | **Pass** |
| Help ≠ interrupt UX | Quiet copy: 抑制主动但仍回答求助; description「求助不等于打断」; clear-rejects「我要求助」 | **Pass** |
| No hardcoded timed nag / dwell UI | No `mustAskEvery` / `intervalMinutes` / `dwellStuck` controls; `data-no-nag-interval` + `data-no-dwell-stuck`; test asserts absence | **Pass** |
| View / reset | Effective summary + reload; global PUT null → defaults; session PUT null → clear overlay | **Pass** |

### 2. Soft gap: appendDecision no HTTP — honest

| Claim | Spot-check | Result |
|---|---|---|
| No invented append HTTP | Client only GET/PUT prefs on `/api/opening/intervention-settings` | **Pass** |
| Local typing/reject only | `intervention-decision-context.ts` + UI decision feed; `INTERVENTION_DECISION_PERSIST_SOFT_GAP` surfaces in markup | **Pass** |
| Documented soft | Claim + UI copy name appendDecision not exposed | **Pass** (soft gap; does not overturn ACCEPT) |

### 3. Does not break teaching-workspace / settings nav

| Mount | Spot-check | Result |
|---|---|---|
| Settings nest `#intervention` | Sibling section beside `#preferences`; nav link「介入偏好」; `<PreferenceControls scope="global" />`; copy says not a second product | **Pass** |
| TeachingWorkspace session | `ExpandSection id="intervention-prefs"`「本课介入偏好（临时 · 按需展开）」+ session-scope controls with activityId/courseId/expectedUpdatedAt | **Pass** |
| Nav / workspace tests | `settings-view.nav.test.ts` asserts `#intervention` + mock mount; `teaching-workspace.test.ts` asserts expand chrome | **Pass** (re-run green) |

### 4. Client wiring matches Data API; no Data rewrite

| Claim | Spot-check | Result |
|---|---|---|
| GET/PUT client | `getInterventionSettings` / `putInterventionSettings` → `/api/opening/intervention-settings` + courseId/activityId/expectedUpdatedAt; zod parse | **Pass** |
| api.test coverage | GET query; PUT prefs + null reset; session overlay + CAS | **Pass** |
| packages/database\|domain\|contracts dirty | `git diff --name-only` empty | **Pass** |

### 5. Tests not loosened

| Guard | Could hide miss? | Result |
|---|---|---|
| winningLayer session>course>global field asserts | No | **Pass** |
| SSR view: session banner, help≠interrupt copy, no-nag markers, forbid mustAskEvery/intervalMinutes/dwellStuck | No | **Pass** |
| Session scope distinct save/clear labels | No | **Pass** |
| Settings `#intervention` anchor + mount | No | **Pass** |
| Teaching expand chrome | No | **Pass** |
| Client GET/PUT/reset/session CAS | No | **Pass** |

No expect weakenings observed; suite strength matches claim.

## Re-runs (Integrator independent)

### Vitest (exact command from task)

```text
$ PATH="./node_modules/.bin:$PATH" npx vitest run \
    apps/web/src/features/opening/teaching/preference-controls.test.ts \
    apps/web/src/features/opening/client/api.test.ts \
    apps/web/src/features/settings/settings-view.nav.test.ts \
    apps/web/src/features/opening/teaching/teaching-workspace.test.ts

 Test Files  4 passed (4)
      Tests  55 passed (55)
# exit 0
```

### Typecheck

```text
$ cd apps/web && npx tsc -p tsconfig.json --noEmit
# exit 0 (no diagnostics)
```

## not_run

| Check | Status | Reason |
|---|---|---|
| Browser / interactive preference-controls | **`not_run`** | PM/plan soft-deferred; no interactive browser pass this slice |
| appendDecision HTTP round-trip | **`not_run`** | Soft gap — Data repo exists, no client HTTP; local context only |
| Live DB migrate / T11–T13 Data paths | **`not_run`** | Out of Experience UI scope (Data ACCEPT already recorded) |
| push / hermes / commit | **`not_run`** | Forbidden |

Browser `not_run` does **not** block ACCEPT for this half (PM confirms soft-deferred).

## Soft gaps (do not overturn ACCEPT)

1. **appendDecision HTTP** — client typing/reject local only; thin append route later.  
2. **Browser** — `not_run` / pending_user.  
3. **Proactive offer surface** in workspace still thin — reject/typing controls available for gate callers; full offer-card wiring soft attach.

## Scope confirmation

- Integrator did **not** commit / push / stash / reset / hermes.  
- Integrator did **not** implement or fix product code (would REJECT).  
- Integrator did **not** rewrite Data migr/API/policy/contracts.  
- Integrator **did** stronger-review + re-run claimed vitest (55) and apps/web tsc.

## Handoff

1. **Experience UI Implement ACCEPT** recorded.  
2. Tip remains `c134d66` + dirty Experience land until PM/commit authority.  
3. Soft follow-ups: appendDecision thin HTTP; browser pass; offer-card wire.

## One-line

ACCEPT — tip `c134d66` dirty UI; vitest 55 + tsc green; nest settings+workspace; session>course>global; help≠interrupt; no nag UI; appendDecision soft; browser `not_run`; no push/hermes/commit.
