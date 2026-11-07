# RP5 — Browser e2e closed-loop Accept (guidance-modes + today-plan)

**Date:** 2026-10-09 ~23:30 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release`  
**Repo:** `/workspace/study-assistant-opening`  
**Base tip:** `8a22308666701bbc2ebfac01bc6aa4a2f81d4aa1`  
**Verdict:** **ACCEPT**  
**RP5 status:** remains **active** (not verified) until full quality green on tip after this push.

## PM constraint

| Check | Result |
|---|---|
| Spec-only; no `apps/web` product changes | **PASS** — `git diff` touches only the two specs (+ this evidence / fix md / tasks.json) |
| Does not re-expose hidden main-nav entries | **PASS** — no production UI in diff |
| Does not revert CI to old `/learn` wizard | **PASS** — today-plan drops `选择今天的安排` / conflict wizard; asserts `/opening/today` closed-loop |
| Aligns to new defaults: settings/advanced + `/opening/today` | **PASS** — guidance → `/settings/advanced` + scoped `[aria-labelledby="protected-exploration-heading"]`; today → `/opening/today` (+ OPENING_RELEASE redirect asserts) |

## Diff reviewed

- `tests/e2e/guidance-modes.spec.ts` — both tests `goto("/settings/advanced")`; exploration start/end/add/remove scoped under protected-exploration section.
- `tests/e2e/today-plan.spec.ts` — closed-loop smoke on `/opening/today`; legacy `/learn` path asserts redirect when `OPENING_RELEASE`; never requires wizard heading.
- Experience evidence: `rp5-browser-e2e-closed-loop-fix.md` (4 passed claim).

## Local re-run (Integrator Accept)

```bash
OPENING_RELEASE=0 \
  E2E_DATABASE_URL=postgres://postgres@127.0.0.1:5433/aistudy_opening_e2e \
  npm run test:browser -- tests/e2e/guidance-modes.spec.ts tests/e2e/today-plan.spec.ts
```

**Result: 4 passed (2.0m)**

```
✓ guidance-modes › switches guidance autonomy mode between free, advisory, and coach
✓ guidance-modes › reserves and removes protected exploration time
✓ today-plan › opening today shows closed-loop workbench after register
✓ today-plan › legacy learn paths yield to opening today under closed-loop
```

## Excluded from this Accept commit

- `docs/superpowers/evidence/2026-10-09-opening-release/rp5-gha-8a22308.md` (prior GHA watch note; optional)
- `services/parser/opening_parser.egg-info/`
- Any Q03 leftovers / `apps/web`

## Follow-up

Push tip; watch GHA Browser on `feat/opening-release`. Do **not** mark RP5 verified until full quality job is green.
