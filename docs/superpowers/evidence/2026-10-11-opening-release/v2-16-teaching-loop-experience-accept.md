# V2-16 Teaching loop — Experience thin entry-gate Implement ACCEPT

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Reviewer:** AIstudy Integrator (executor / Grok Bot) — **≠** implementer (AIstudy Experience)  
**Stage:** Independent Implement ACCEPT (Experience UI thin entry-gate half only) — **accept evidence only**; no product edit · no commit / push / hermes / stash / reset · **no** `tasks.json` verified flip  
**Branch:** `feat/opening-release`  
**Tip HEAD (baseline; Integrator harness committed):** `72033cbc1235b00ddb745b1fd999da8b5b2d2b17` (`72033cb`) — `feat(opening): V2-16 AI teaching loop trial gate and harness`  
**Tree:** **dirty Experience UI** (uncommitted; excluded from any clean-tip push)  
**Verdict:** **ACCEPT**  
**Gates:** `docs/superpowers/plans/opening-release/review-test-gates.md`

## Authority / inputs

| Doc | Role |
|---|---|
| `docs/superpowers/plans/ai-led-learning-v2/v2-16-teaching-loop-plan.md` | Plan（thin entry / dual flags · Experience sequenced） |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-16-teaching-loop-plan-accept.md` | Data Plan ACCEPT + PM open-decision locks（UI = **both** flags） |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-16-teaching-loop-accept.md` | Integrator Implement ACCEPT context（thin Experience entry deferred → this half） |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-16-teaching-loop-experience-implement.md` | Experience Implement claim |
| `docs/superpowers/plans/opening-release/review-test-gates.md` | Gates |
| Tip flags (consume only) | `teaching-loop-flag.ts` + `teaching-workspace-flag.ts` |
| Style | `v2-15-matrix-transform-experience-accept.md` / `v2-14-learning-resume-experience-accept.md` |
| PM locks (this half) | Today/continue → TeachingWorkspace requires **both** `OPENING_TEACHING_LOOP` + `OPENING_TEACHING_WORKSPACE`；reuse `teaching-loop-flag`（no parallel env parser）；flags off → honest empty, not fake teaching workspace |

## Tip / dirty tree (read-only; no stash / reset / push)

```text
$ git rev-parse HEAD
72033cbc1235b00ddb745b1fd999da8b5b2d2b17

$ git log -1 --oneline
72033cb feat(opening): V2-16 AI teaching loop trial gate and harness

$ git branch --show-current
feat/opening-release

$ git status --short  (product Experience only)
 M apps/web/src/features/opening/planning/today-dashboard-activity.test.ts
 M apps/web/src/features/opening/planning/today-dashboard.tsx
?? apps/web/src/features/opening/teaching/teaching-loop-trial-empty.tsx
?? apps/web/src/features/opening/teaching/teaching-loop-trial.test.ts
?? apps/web/src/features/opening/teaching/teaching-loop-trial.ts
?? docs/superpowers/evidence/2026-10-11-opening-release/v2-16-teaching-loop-experience-implement.md
# (+ this accept evidence)

$ git status --short -- \
  apps/web/src/features/opening/teaching/teaching-loop-flag.ts \
  apps/web/src/features/opening/teaching/teaching-loop-flag.test.ts \
  apps/web/src/features/opening/teaching/teaching-workspace-flag.ts \
  tests/integration/opening-teaching-loop.test.ts \
  tests/e2e/opening-teaching.spec.ts
# (empty — Integrator flag/harness/e2e untouched)

$ ls packages/database/src/migrations/*.sql | tail -1
packages/database/src/migrations/0057_opening_help_exposure_kind.sql

$ ls packages/database/src/migrations/0058* 2>/dev/null || echo NO_0058
NO_0058

$ date '+%Y-%m-%d %H:%M %Z'
2026-10-11 14:11 CST
```

**Also dirty (outside Experience product):** untracked `docs/superpowers/evidence/2026-10-09-opening-release/rp5-gha-91b1c73-typecheck-fail.md`、`docs/superpowers/evidence/2026-10-11-opening-release/p0-assistant-list-preview-failsoft-implement.md` — unrelated; not part of this ACCEPT.

**Confirmed:** tip remains `72033cb`. Dirty product tree is Experience thin entry only (`teaching-loop-trial*` + today-dashboard(+test) + evidence). **No stash, reset, checkout, commit, push, or hermes** performed this Accept. `tasks.json` left alone.

## Migration / DDL

| Check | Result |
|---|---|
| Tip migrations end | **0057** `opening_help_exposure_kind.sql` |
| New `0058*` | **Absent** |
| Parallel loop tables / invent DDL | **None** |

**DDL: NO** — holds.

## Stronger review (dirty vs PM locks)

### 1. Diff scope — Experience only

| Path | Role | OK? |
|---|---|---|
| `teaching-loop-trial.ts` (+test) | `resolveTeachingLoopTrialGate` / `isOpeningTeachingLoopTrialEnabled` = **loop && workspace**; calls existing helpers only | YES |
| `teaching-loop-trial-empty.tsx` (+ covered in trial.test) | Honest empty：需双旗；列出缺少旗；不进入主讲工作台；自由对话次要 | YES |
| `today-dashboard.tsx` | Today/continue mounts `TeachingContinueEntry` **only** when dual trial on；else `TeachingLoopTrialEmpty`；resume/clientInit fetch gated by trial | YES |
| `today-dashboard-activity.test.ts` | V2-16 dual-gate describe：both on / loop off / workspace off / both off + empty SSR honesty | YES |
| Integrator `teaching-loop-flag*` / integration / e2e | **Untouched** (`git status` empty) | YES |
| Data contracts/domain / AI compiler / migrations | **Untouched** | YES |
| Migration `0058` | **Absent** | YES |

### 2. PM locks vs UI behavior

| Lock | Finding |
|---|---|
| Today/continue → TeachingWorkspace requires **both** LOOP + WORKSPACE | `isOpeningTeachingLoopTrialEnabled` = `isOpeningTeachingLoopEnabled` && `isOpeningTeachingWorkspaceEnabled`；Today gates mount + resume/clientInit fetch on `teachingLoopTrialEnabled` | **Hold** |
| Reuse `teaching-loop-flag`（do not invent parallel helper） | `teaching-loop-trial.ts` imports and calls `isOpeningTeachingLoopEnabled` / `isOpeningTeachingWorkspaceEnabled`；passes `env` through — **no** third raw env parser of `OPENING_*` / `NEXT_PUBLIC_*` | **Hold** |
| Flags off → honest empty, not fake teaching workspace | Branch → `TeachingLoopTrialEmpty` with `data-teaching-loop-trial-empty`；copy names both flags + missing list；asserts「不会进入主讲工作台」「也不会把自由对话当成主讲试运行」；free chat = quiet secondary link；**no** `data-teaching-workspace` | **Hold** |
| Compose, do not fork Integrator harness | Flag/integration/e2e files untouched | **Hold** |
| DDL NO | Tip **0057**；no `0058` | **Hold** |

### 3. Tests not loosened

- `teaching-loop-trial.test.ts`: both-on entry；loop-off / workspace-off / both-off empty；NEXT_PUBLIC compose；empty SSR honesty + both-missing list（**7**）.
- `today-dashboard-activity.test.ts`: retained CT-03/V2-10 + new V2-16 dual-gate five cases（**13** total file）.
- No `it.skip` / `.only` in claimed files.
- Suite strength matches claim（pure gate matrix + SSR empty markup；full TodayDashboard jsdom click **not** claimed）.

### Soft gaps (honest; non-blocking)

1. **Browser / user_browser:** `not_run` / pending_user — this half covered by vitest SSR + dual-flag unit matrix only（Plan/gates allow when not acceptance criteria for this thin gate）.
2. **TodayDashboard full mount / click:** not exercised under jsdom；gate decision + empty markup covered.
3. **TeachingActivityPanel** no longer mounted from Today when trial-off（replaced by honest `TeachingLoopTrialEmpty`）；component + CT-03 tests remain elsewhere — intentional per dual-gate honesty.
4. Integrator integration / e2e / `real_model` status unchanged this half（not re-run DB / Playwright）.

**Blockers:** **None**.

## Independent re-runs (Integrator)

### Targeted vitest (Experience dual-gate — claimed 20)

```text
$ PATH="./node_modules/.bin:$PATH" bash scripts/run-heavy.sh vitest run --project unit \
    apps/web/src/features/opening/teaching/teaching-loop-trial.test.ts \
    apps/web/src/features/opening/planning/today-dashboard-activity.test.ts

 Test Files  2 passed (2)
      Tests  20 passed (20)
   Duration  2.53s

UNIT_EXIT=0
```

（`teaching-loop-trial.test.ts` **7**；`today-dashboard-activity.test.ts` **13**。）

### Typecheck

```text
$ PATH="./node_modules/.bin:$PATH" bash scripts/run-heavy.sh npx tsc -p apps/web/tsconfig.json --noEmit
TSC_EXIT=0
```

### not_run (honest)

| Check | Status | Reason |
|---|---|---|
| Browser / Playwright visual | **not_run** | No live browser script this Accept；Plan/implement claim pending_user |
| Integrator integration `opening-teaching-loop.test.ts` | **not_run** | Outside Experience half；already ACCEPTed on Integrator gate |
| E2E `opening-teaching.spec.ts` live | **not_run** | Outside this half；`pending_user` / env gated |
| `real_model` | **not_run** | No secrets / live model；honesty unchanged |
| `learning_effect` | **unknown** | UX gate ≠ score proof |

## Verdict

**ACCEPT** — Experience thin entry-gate half matches Plan + PM dual-flag locks; independent re-run vitest **20/20** + web `tsc` **0**; browser/integration/real_model listed `not_run` honestly; tip `72033cb` unchanged; dirty Experience-only; DDL NO; `tasks.json` not flipped.

**Next (not this Accept):** PM / Paula may authorize commit of Experience dirty product + evidence when ready. Only Accept may later move related `tasks.json` → `verified` if that task exists — **this slice left tasks.json alone**.

## 中文房间摘要

- **结论：ACCEPT**（Integrator ≠ Experience 作者）。
- Tip 仍为 **`72033cb`**；脏树仅 Experience：`today-dashboard(+test)`、`teaching-loop-trial*`、本证据；无关 `rp5-gha` / `p0-assistant` 未动。
- **双旗锁定成立：** Today/continue 挂 `TeachingContinueEntry` 仅当 `LOOP && WORKSPACE`；任一关 → `TeachingLoopTrialEmpty` 诚实 empty（不静默进主讲、不把自由对话当试运行）。
- **复用**既有 `teaching-loop-flag` / `teaching-workspace-flag`，未发明第三套 env 解析；Integrator harness/flag 文件未改。
- 独立重跑：vitest unit 上述 2 文件 **20 passed**；`tsc -p apps/web` **exit 0**。
- Browser / integration / e2e live / `real_model`：**not_run**（诚实）。
- 软缺口：无全量 Today jsdom 点选；trial-off 不再挂 `TeachingActivityPanel`（改诚实 empty）。
- **DDL 仍 NO**（0057；无 0058）；**未** commit/push/hermes/stash/reset；**未**动 `tasks.json`。
