# V2-16 Teaching loop — Plan-stage evidence (Understand + Plan only)

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Integrator / QA (executor / Grok Bot) — **plan author**  
**Branch:** `feat/opening-release`  
**Tip HEAD:** `74ba005b999c5d8f3c4269b9a3ed1162e6cc3071` (`74ba005`) — matches PM tip baseline after V2-15 Experience half (`74ba005`); working tree may have unrelated untracked docs — **not edited by this slice beyond listed paths**  
**Stage:** Understand → Plan only. **No product Implement. No ALTER. No push / hermes / stash / reset / commit.**  
**Status:** **Plan only — not ACCEPT** (await **AIstudy Data** Plan ACCEPT; Experience backup; **Integrator must not self-ACCEPT**)  
**Gates:** `docs/superpowers/plans/opening-release/review-test-gates.md` (list what was read / run; do **not** self-ACCEPT)

## Diff scope (this slice)

### Written (docs only)

| Path | Role |
|---|---|
| `docs/superpowers/plans/ai-led-learning-v2/v2-16-teaching-loop-understand.md` | Understand |
| `docs/superpowers/plans/ai-led-learning-v2/v2-16-teaching-loop-plan.md` | Plan (await Data ACCEPT) |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-16-teaching-loop-understand.md` | Understand-stage evidence |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-16-teaching-loop-plan-implement.md` | This plan-stage evidence |

### Explicitly not touched

- No product implementation of loop integration/e2e tests or flag helper
- No product edits under `apps/web/src/features/opening/teaching/` exclusive Experience trees beyond docs
- No Data exclusive contract/domain product edits
- No migration SQL under `packages/database/src/migrations/`
- No ALTER / migrate / psql
- No `tasks.json` status → verified / in_progress
- No push / hermes / stash / reset / commit
- Unrelated untracked evidence elsewhere left untouched

## Tip / branch verification

```text
$ git rev-parse HEAD
74ba005b999c5d8f3c4269b9a3ed1162e6cc3071

$ git branch --show-current
feat/opening-release

$ git log -1 --oneline
74ba005 feat(opening): V2-15 matrix_transform UI (Experience half)

$ ls packages/database/src/migrations/*.sql | sort | tail -1
0057_opening_help_exposure_kind.sql

$ test ! -f packages/database/src/migrations/0058* 2>/dev/null; ls packages/database/src/migrations/0058* 2>/dev/null || echo 'no 0058 migr'
no 0058 migr
```

## Plan claims (for Data ACCEPT review)

| Claim | Value |
|---|---|
| Tip baseline | `74ba005` |
| DDL | **NO** |
| Flag proposal | `OPENING_TEACHING_LOOP` / `NEXT_PUBLIC_OPENING_TEACHING_LOOP` (default off) |
| NEW tests | `tests/integration/opening-teaching-loop.test.ts`; `tests/e2e/opening-teaching.spec.ts` |
| Owners | Integrator/QA = tests+flag+e2e; Data/Experience/AI = touch only owned trees, sequenced |
| Plan ACCEPT | **AIstudy Data** (Experience backup) — **not Integrator** |
| Evidence statuses (plan-stage) | engineering/real_model=`not_run`; user_browser=`pending_user`; learning_effect=`unknown` |
| Acceptance | AI主讲 trialable; not reader+chat; no long-term score proof required |
| Rollback | Flag off; keep user content; record failures |

## Handoff

**Ready for Plan ACCEPT by AIstudy Data** (Experience backup). Integrator will not ACCEPT this Plan.

## Not claimed

- No Plan ACCEPT by Integrator  
- No Implement authorization  
- No CI green for NEW tests (files not written yet)  
