# V2-11 Intervention prefs — Experience UI Implement Evidence

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Experience (executor / Grok Bot)  
**Branch:** `feat/opening-release`  
**Tip HEAD (baseline; Data half ACCEPT merged):** `c134d66` — `feat(opening): V2-11 intervention prefs + policy (Data half)`  
**Status:** **implemented, awaiting Integrator Experience ACCEPT** — do **not** self-ACCEPT; `tasks.json` not marked verified  
**Hard rules held:** No commit / push / hermes / stash / reset · No Data rewrite (migration 0056 / policy / contracts untouched) · Exclusive Experience UI tree

## Authority followed

- Plan: `docs/superpowers/plans/ai-led-learning-v2/v2-11-intervention-prefs-plan.md`
- Understand: `docs/superpowers/plans/ai-led-learning-v2/v2-11-intervention-prefs-understand.md`
- Data Implement + ACCEPT:
  - `docs/superpowers/evidence/2026-10-11-opening-release/v2-11-intervention-prefs-implement.md`
  - `docs/superpowers/evidence/2026-10-11-opening-release/v2-11-intervention-prefs-accept.md`
- PM gate: nest into existing settings / teaching chrome; session>course>global; help≠interrupt; quiet still answers help; session temp ≠ permanent visible; view/reset; no dwell-stuck / auto-expand-after-hint / N-minute nag UI

## Diff scope (Experience only)

### New

| Path | Role |
|---|---|
| `apps/web/src/features/opening/teaching/preference-controls.tsx` | PreferenceControls + PreferenceControlsView; effective/layer summary; global vs session scopes; quiet/proactivity/depth/nodes; reset; typing/reject local decision feed; no nag/dwell controls |
| `apps/web/src/features/opening/teaching/preference-controls.test.ts` | Layer precedence labels; SSR view honesty; session≠permanent; decision helpers; container session-missing |
| `apps/web/src/features/opening/teaching/intervention-decision-context.ts` | Client typing / consecutive-reject context helpers (+ soft-gap constant for appendDecision HTTP) |

### Updated

| Path | Change |
|---|---|
| `apps/web/src/features/opening/client/api.ts` | `getInterventionSettings` / `putInterventionSettings` → GET/PUT `/api/opening/intervention-settings` (+ courseId / activityId / expectedUpdatedAt) |
| `apps/web/src/features/opening/client/api.test.ts` | Client GET/PUT/reset/session overlay tests |
| `apps/web/src/features/settings/settings-view.tsx` | Nest `#intervention` section with `<PreferenceControls scope="global" />` (no new settings product) |
| `apps/web/src/features/settings/settings-view.nav.test.ts` | Assert `#intervention` anchor + mock mount |
| `apps/web/src/features/opening/teaching/teaching-workspace.tsx` | ExpandSection「本课介入偏好（临时）」→ session-scope PreferenceControls |
| `apps/web/src/features/opening/teaching/teaching-workspace.test.ts` | Assert expand chrome; mock PreferenceControls |

### Explicitly not touched

- Data: migration **0056**, contracts, domain `intervention-policy`, repo, API route body (reuse only)
- No commit / push / hermes / stash / reset
- No self-ACCEPT / `tasks.json` verified
- Unrelated untracked evidence left as-is

## Mount choice (smallest honest)

1. **Global / permanent:** main Settings (`/settings`) new nest section `#intervention` beside learning preferences — same chrome pattern as planning / preferences.  
2. **Session temp:** TeachingWorkspace expandable「本课介入偏好（临时 · 按需展开）」with `scope="session"` + `activityId` + `expectedUpdatedAt` — labels state temp ≠ write-through.

## UX summary

- View **effective** prefs + **winning layer** (session > course > global).  
- Edit global durable prefs; session overlay clearly labeled temporary / non-permanent.  
- Quiet mode copy: still answers explicit help; not an interrupt.  
- Reset: global → defaults (`PUT null`); session → clear overlay.  
- Typing / reject feed updates **local** decision context for callers.  
- **No** N-minute nag control, **no** dwell-stuck control, **no** auto-expand-after-hint UI.

## Soft gaps (honest)

1. **Decision ring persist:** Data `appendDecision` exists on repo but **no HTTP** on `/api/opening/intervention-settings`. Client wires typing/reject **locally** (`intervention-decision-context.ts` + UI feed) and documents `INTERVENTION_DECISION_PERSIST_SOFT_GAP`. Prefer thin append route later; do not invent a second store.  
2. **Browser:** `not_run` / pending_user (no interactive browser pass this slice).  
3. **Proactive offer surface** in workspace still thin — reject/typing controls are available in preference chrome for gate callers; full offer-card wiring remains soft attach.

## Commands run + results

### Tip

```text
$ git log -1 --oneline
c134d66 feat(opening): V2-11 intervention prefs + policy (Data half)

$ git branch --show-current
feat/opening-release
```

### Targeted vitest

```text
$ pnpm exec vitest run \
    apps/web/src/features/opening/teaching/preference-controls.test.ts \
    apps/web/src/features/opening/client/api.test.ts \
    apps/web/src/features/settings/settings-view.nav.test.ts \
    apps/web/src/features/opening/teaching/teaching-workspace.test.ts

 Test Files  4 passed (4)
      Tests  55 passed (55)
   Duration  ~2.3s
# exit 0
```

### Typecheck

```text
$ cd apps/web && npx tsc -p tsconfig.json --noEmit
# exit 0 (no diagnostics)
```

### Browser

```text
not_run / pending_user
```

## Accept ask (Integrator)

Please **ACCEPT** Experience UI half of V2-11 if:

1. Tip still `c134d66` (+ dirty Experience files only; no Data rewrite).  
2. `preference-controls.tsx` nests into existing settings + teaching chrome (no parallel product).  
3. GET/PUT client matches Data `/api/opening/intervention-settings`; session temp ≠ permanent visible; view/reset present.  
4. Align copy/controls: help≠interrupt; quiet answers help; no dwell / nag / auto-expand-after-hint UI.  
5. Targeted vitest 55 green + `apps/web` tsc clean; browser honesty `not_run`.  
6. Soft gap on `appendDecision` HTTP acknowledged (local typing/reject context only).

**Do not** mark `tasks.json` verified until Integrator ACCEPT.
