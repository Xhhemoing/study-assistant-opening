# DL11 (domain) — day-planner earliest / not-before Accept

Verifier: Grok Bot (executor). Workspace: `/workspace/study-assistant-opening`, branch `feat/opening-release`.
Date: 2026-10-09 (Asia/Shanghai).

## Accept vs research §5.2

**ACCEPT: yes** against `docs/quality/2026-10-09-loop-review-research.md` §5.2 (P1 排程器漏掉补测的最早执行时间).

§5.2 required `start = max(slot.start, task.notBefore, planningNow)`, `end = start + duration`, `end <= min(slot.end, dueAt)`, plus keeping the empty slot prefix for other tasks. Pre-fix `planDay` only filtered `recommendedAt > dayEnd` and could place an afternoon retest at morning slot start.

Domain slice maps `notBefore` → `retest.recommendedAt` via `taskNotBeforeMs`, clamps with optional `PlanDayOptions.planningNow`, and `tryPlaceInSlot` preserves `[slot.start, start)` for later tasks.

## Diff scope (committed)

- `packages/domain/src/opening/day-planner.ts`
- `packages/domain/src/opening/day-planner.test.ts`
- this evidence file

No `apps/web`, plan-service wiring, Experience budget UI, Q03 packaging, or egg-info.

## Gates (re-run on Accept)

| Gate | Result |
|---|---|
| `npx tsc -p packages/domain --noEmit` | exit 0 |
| `npx vitest run packages/domain/src/opening/day-planner.test.ts` | **22 PASS** |
| `npx vitest run packages/domain/src/opening/daily-draft.test.ts` | **5 PASS** |

Notable tests: afternoon retest not before `recommendedAt`; prefix reusable under preferredOrder; ordinary `planningNow` clamp without mutating task status; squeezed `recommendedAt`/`dueAt` leaves unscheduled; DL3 dayEnd skip still present.

## Ledger note (DL11)

`15-research-hardening.md` exists (untracked at Accept time) and defines DL11. HEAD `tasks.json` had no DL11 row (working tree had planned RP7/DL11/BC1/TZ01 plus unrelated Q03/RP5 evidence dirt — **not** committed here).

**Do not mark DL11 verified** from domain-only Accept: plan AC also expects morning-only-slot unschedule clarity, server-side earliest re-check on retest submit, and natural consumption via P04a/web — `planningNow` is **not** yet wired to web/plan-service (domain scope OK).

Integrator: append evidence path `../../evidence/2026-10-09-opening-release/dl11-day-planner-earliest-accept.md` when landing DL11; leave **planned** or set **active** with this evidence; land `15-research-hardening.md` + ledger rows with the hardening batch.

## Out of scope / follow-ups

- Wire `planningNow` through plan-service / daily-draft callers.
- Explicit “morning free only → afternoon retest unscheduled” case if desired beyond fit failure.
- Server reject-early-retest path (frontend disable is not a guarantee per §5.2).
