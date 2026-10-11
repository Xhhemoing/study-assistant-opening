# V2-16 Teaching loop — Implement ACCEPT

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Reviewer:** AIstudy Data (executor / Grok Bot) — **≠** implementer (AIstudy Integrator / QA)  
**Stage:** Independent Implement ACCEPT — **accept evidence only**; no product edit · no commit / push / hermes / stash / reset · **no** `tasks.json` verified flip  
**Branch:** `feat/opening-release`  
**Baseline tip (assignment / Plan ACCEPT / Implement):** `74ba005b999c5d8f3c4269b9a3ed1162e6cc3071` (`74ba005`)  
**Tip HEAD at Accept (dirty; Integrator uncommitted V2-16 files):** `74ba005b999c5d8f3c4269b9a3ed1162e6cc3071` (`74ba005`) — **exact match**  
**Verdict:** **ACCEPT**  
**Gates:** `docs/superpowers/plans/opening-release/review-test-gates.md`  
**PM locks checked:** synthetic/existing fixture; CI no live model key (`real_model=not_run`); UI needs **both** `OPENING_TEACHING_LOOP` + `OPENING_TEACHING_WORKSPACE`; **DDL NO**; L1–L6; five states; UX ≠ `learning_effect`

## Authority / inputs read

| Doc | Role |
|---|---|
| `docs/superpowers/plans/ai-led-learning-v2/v2-16-teaching-loop-plan.md` | Plan |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-16-teaching-loop-plan-accept.md` | Plan ACCEPT (+ PM open-decision locks) |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-16-teaching-loop-implement.md` | Integrator Implement claim |
| `docs/superpowers/plans/opening-release/review-test-gates.md` | Gates |
| Style: `v2-16-teaching-loop-plan-accept.md` / prior Data accept docs | Evidence pattern |

## Tip / dirty tree

```text
$ git rev-parse HEAD
74ba005b999c5d8f3c4269b9a3ed1162e6cc3071

$ git branch --show-current
feat/opening-release

$ git log -1 --oneline
74ba005 feat(opening): V2-15 matrix_transform UI (Experience half)

$ git status --short -- \
  apps/web/src/features/opening/teaching/teaching-loop-flag.ts \
  apps/web/src/features/opening/teaching/teaching-loop-flag.test.ts \
  tests/integration/opening-teaching-loop.test.ts \
  tests/e2e/opening-teaching.spec.ts \
  docs/superpowers/evidence/2026-10-11-opening-release/v2-16-teaching-loop-implement.md
?? apps/web/src/features/opening/teaching/teaching-loop-flag.test.ts
?? apps/web/src/features/opening/teaching/teaching-loop-flag.ts
?? docs/superpowers/evidence/2026-10-11-opening-release/v2-16-teaching-loop-implement.md
?? tests/e2e/opening-teaching.spec.ts
?? tests/integration/opening-teaching-loop.test.ts

$ date '+%Y-%m-%d %H:%M %Z'
2026-10-11 14:06 CST
```

**No** stash / reset / commit / push / hermes on this Accept. Worked dirty tree as-is. Product behavior **not** edited by Data.

## Migration / DDL

```text
$ ls packages/database/src/migrations/*.sql | tail -1
packages/database/src/migrations/0057_opening_help_exposure_kind.sql

$ test ! -e packages/database/src/migrations/0058_*.sql && echo NO_0058
NO_0058
```

| Check | Result |
|---|---|
| Tip migrations end | **0057** `opening_help_exposure_kind.sql` |
| New `0058*` | **Absent** |
| Parallel loop tables / invent DDL | **None** in V2-16 new files |

**DDL: NO** — holds.

## Stronger review (NEW files vs Plan / PM locks)

### Files reviewed

| Path | Role |
|---|---|
| `apps/web/src/features/opening/teaching/teaching-loop-flag.ts` | Flag helper |
| `apps/web/src/features/opening/teaching/teaching-loop-flag.test.ts` | Unit |
| `tests/integration/opening-teaching-loop.test.ts` | L1–L6 + five states |
| `tests/e2e/opening-teaching.spec.ts` | Playwright skeleton |

### Checklist

| Check | Result |
|---|---|
| Flag default off; truthy only `1\|true\|yes` | **pass** — mirrors `teaching-workspace-flag.ts`; unit covers default / truthy / OPENING_* preferred over NEXT_PUBLIC_* |
| Dual flag injection (loop + workspace) | **pass** — integration `injectDualTeachingFlags` in `beforeAll`/`beforeEach`; e2e notes both required for UI trial |
| L1–L6 composed on tip services | **pass** — activity create/associate → synthetic ready teach → skip CAS + stale conflict → attempt+obs → pause/checkpoint (prefs+commandLog preserved) → `learningResumeSchema` |
| LearningResume ≠ ConversationResume | **pass** — `conversationResumeSchema.safeParse(parsed).success === false` |
| Five understandable states | **pass** — no-course; model/budget via ai-readiness helpers; parse VALIDATION; withdrawn materials unavailable/partial |
| Synthetic fixture; no live-model fake green | **pass** — `seedReadyTeachingContent`; comments + e2e annotate `real_model=not_run` |
| UX ≠ `learning_effect` | **pass** — e2e `pending_user` annotation; learning_effect kept unknown |
| No DDL / no 0058 | **pass** |
| Deferred thin Experience entry guard | **OK soft** — Plan ownership: prefer export flag; Experience half sequenced if polish needed |
| Tests not loosened | **pass** — no `it.skip` / `.only` in claimed product files; e2e uses env `OPENING_E2E` gate + documented `pending_user` (Plan-allowed) |
| Rejected alts avoided | **pass** — no reader+chat trial; no ConversationResume reuse; no invented loop tables |

**Blockers:** **None**.

## Independent re-runs (Data)

### Unit (flag)

```text
$ npx vitest run --project unit apps/web/src/features/opening/teaching/teaching-loop-flag.test.ts

 Test Files  1 passed (1)
      Tests  3 passed (3)
   Duration  248ms

UNIT_EXIT=0
```

### Typecheck

```text
$ npx tsc -p apps/web/tsconfig.json --noEmit
TSC_EXIT=0
```

### Integration (attempted)

```text
$ OPENING_TEST_DB=1 OPENING_TEST_DATABASE_URL=postgres://aistudy:aistudy@127.0.0.1:5432/aistudy_opening_test \
    npm run test:integration -- tests/integration/opening-teaching-loop.test.ts

# → Error: connect ECONNREFUSED 127.0.0.1:5432 (globalSetup)
# INT_EXIT=1 — integration **not_run** (agent postgres unavailable)
```

File is present under `tests/integration/**/*.test.ts` (CI pickup path). L1–L6 + state asserts are coded; not executed live this gate.

### E2E presence

```text
$ test -f tests/e2e/opening-teaching.spec.ts && echo E2E_OK
E2E_OK
```

Playwright / browser **not** executed — do **not** claim browser pass. Full visual remains **`pending_user`**.

## not_run (honest)

| Item | Reason |
|---|---|
| Integration L1–L6 + DB state tests | `ECONNREFUSED 127.0.0.1:5432` — no live `OPENING_TEST_DB` postgres on Accept box |
| Playwright live e2e | `OPENING_E2E` / browser not provisioned; skeleton only |
| user_browser full visual script | **pending_user** (Plan T13) |
| real_model | PM lock: CI does not store live model keys; never fake green |
| learning_effect | **unknown** (not claimed; UX ≠ effect) |
| Thin Experience entry guard dual-edit | Deferred by Integrator — non-blocking soft gap |

## Soft gaps (non-blocking)

1. **Agent DB unavailable** — integration coded but **not_run**; same honest skip as Implement evidence.  
2. **Thin Experience entry guard** deferred — flag exported; Plan allows sequenced Experience half.  
3. **Browser visual `pending_user`** — e2e file presence satisfies T12; T13 remains user script.  
4. **Model/budget state asserts** use ai-readiness helpers (in-process) rather than live readiness HTTP — matches Plan §4 hook table for those two states.

**Blockers:** **None**.

## Hygiene

- **No** commit / push / hermes / stash / reset  
- **No** DDL / no invent `0058`  
- **No** product code edits by Data Accept  
- **No** `tasks.json` → verified (left alone; prior Data Accept pattern — Integrator/PM may flip after room ACCEPT)

## Verdict

**ACCEPT** — runnable checks re-run green (flag unit 3/3; `tsc` exit 0); skips listed honestly (`not_run` / `pending_user`); Plan behavior present in NEW files; no false greens; soft gaps non-blocking.
