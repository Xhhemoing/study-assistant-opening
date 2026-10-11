# V2-16 Teaching loop — Plan ACCEPT

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Reviewer:** AIstudy Data (executor / Grok Bot) — **≠** plan author (AIstudy Integrator)  
**Stage:** Plan ACCEPT only — **no product Implement · no ALTER · no migration SQL · no commit / push / hermes / stash / reset**  
**Branch:** `feat/opening-release`  
**Tip HEAD at Accept:** `74ba005b999c5d8f3c4269b9a3ed1162e6cc3071` (`74ba005`)  
**Plan tip claim:** `74ba005` — **exact match**  
**Verdict:** **ACCEPT**  
**Gates:** `docs/superpowers/plans/opening-release/review-test-gates.md` + delivery-loop stronger Plan review  
**PM locks encoded:** real materials/model path; enter→teach→ask→attempt→pause→resume→optional independent; five understandable states; `OPENING_TEACHING_LOOP` default off; tests at proposed paths; UX ≠ learning_effect; AI主讲 ≠ reader+chat; rollback flag-off; Plan ACCEPT ≠ Integrator; **DDL NO**

## Authority / inputs read

| Doc | Role |
|---|---|
| `docs/superpowers/plans/ai-led-learning-v2/v2-16-teaching-loop-plan.md` | Plan under review |
| `docs/superpowers/plans/ai-led-learning-v2/v2-16-teaching-loop-understand.md` | Understand |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-16-teaching-loop-understand.md` | Understand evidence |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-16-teaching-loop-plan-implement.md` | Plan-stage evidence |
| `docs/superpowers/plans/ai-led-learning-v2/plan.md` §V2-16 (~L645–663) | Authority |
| `docs/superpowers/plans/opening-release/review-test-gates.md` | Gates |
| PM room: Data = non-author Plan ACCEPT | Frozen |

## Tip / tree verification

```text
$ git rev-parse --short HEAD
74ba005

$ ls packages/database/src/migrations/*.sql | tail -1
0057_opening_help_exposure_kind.sql

$ test ! -f tests/integration/opening-teaching-loop.test.ts && echo LOOP_ABSENT
LOOP_ABSENT

$ test ! -f tests/e2e/opening-teaching.spec.ts && echo E2E_ABSENT
E2E_ABSENT

$ test -f apps/web/src/features/opening/teaching/teaching-workspace-flag.ts && echo FLAG_PATTERN_OK
FLAG_PATTERN_OK

$ test -f apps/web/src/features/opening/teaching/command-service.ts && test -f apps/web/src/features/opening/teaching/resume-service.ts && echo LOOP_MODULES_OK
LOOP_MODULES_OK
```

**Result:** tip `74ba005`. Migrations tip **0057**. Proposed loop integration/e2e files **absent** (correct for Plan-only). Tip modules for commands/resume/workspace flag **present**. No product code from this Plan slice.

## Stronger review vs PM / plan.md

| Check | Result |
|---|---|
| Restatement matches §V2-16 + PM locks | **pass** — compose tip V2-08…V2-15; not fork tables |
| Loop step map cites tip paths | **pass** — activity/commands/attempts/status/checkpoint/resume |
| Five states inventory with hooks | **pass** — course / model / budget / parse / withdrawn |
| Flag `OPENING_TEACHING_LOOP` mirrors workspace-flag helper | **pass** — default off; rollback = off |
| Tests NEW at fixed paths; Plan-stage all `not_run` | **pass** |
| UX ≠ learning_effect; real_model honesty | **pass** |
| Reject reader+chat / ConversationResume / DDL 0058 | **pass** |
| Ownership: Integrator tests/flag; Data/Experience sequenced if needed | **pass** — Data contracts expect **none** |
| Plan ACCEPT owner = Data ≠ Integrator | **pass** |
| No invented goals / dropped hard rules | **pass** |

## Soft notes (non-blocking)

1. Open PM defaults remain: first-trial fixture course/source; whether CI holds live model secrets; UI trial requires **both** loop+workspace flags (Plan default).  
2. Thin entry-guard may lightly touch Experience trees — Plan already sequences Experience half if polish needed.  
3. Data Implement not expected unless an unexpected contract gap appears.

## Verdict

**ACCEPT** — ready for PM / Paula to open **Integrator/QA Implement** authorization. No Implement / no DDL / no push / hermes from this Accept.


## PM open-decision locks (2026-10-11, post-ACCEPT confirm)

PM locked the three Plan §8 open items. **Verdict unchanged: ACCEPT.**

1. **Fixture:** synthetic and/or existing fixtures for first internal trial unit (no new product DDL).
2. **CI / real_model:** CI does **not** store live model API keys; `real_model` stays **`not_run`** until secrets + recorded live call outside CI green path.
3. **Flags:** UI trial requires **both** `OPENING_TEACHING_LOOP` and `OPENING_TEACHING_WORKSPACE` on; integration sets both in process env. Loop flag alone is insufficient for full UI trial.

