# V2-16 Teaching loop — Understand-stage evidence

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Integrator / QA (executor / Grok Bot)  
**Branch:** `feat/opening-release`  
**Tip HEAD:** `74ba005b999c5d8f3c4269b9a3ed1162e6cc3071` (`74ba005`) — matches PM tip baseline `74ba005` (`feat(opening): V2-15 matrix_transform UI (Experience half)`)  
**Stage:** Understand only (paired with Plan docs). **No product Implement. No ALTER. No push / hermes / stash / reset / commit.**  
**Status:** **Understand complete — not ACCEPT** (Plan ACCEPT awaits **AIstudy Data**, Experience backup; Integrator ≠ accepter)  
**Gates:** `docs/superpowers/plans/opening-release/review-test-gates.md` (list what was read; do **not** self-ACCEPT)

## Diff scope (this slice)

### Written (docs only)

| Path | Role |
|---|---|
| `docs/superpowers/plans/ai-led-learning-v2/v2-16-teaching-loop-understand.md` | Understand |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-16-teaching-loop-understand.md` | This understand-stage evidence |

### Explicitly not touched

- No `tests/integration/opening-teaching-loop.test.ts` product file
- No `tests/e2e/opening-teaching.spec.ts` product file
- No `teaching-loop-flag.ts` product file
- No edits to teaching workspace / resume / commands / attempts / matrix / compile exclusive trees
- No migration SQL; tip remains **0057**
- No `tasks.json` status flips
- No push / hermes / stash / reset / commit

## Tip / branch verification

```text
$ git rev-parse HEAD
74ba005b999c5d8f3c4269b9a3ed1162e6cc3071

$ git rev-parse --short HEAD
74ba005

$ git branch --show-current
feat/opening-release

$ git log -1 --oneline
74ba005 feat(opening): V2-15 matrix_transform UI (Experience half)

$ ls packages/database/src/migrations/*.sql | sort | tail -3
0055_opening_compile_teaching_unit_job.sql
0056_opening_intervention_settings.sql
0057_opening_help_exposure_kind.sql

$ test ! -f tests/integration/opening-teaching-loop.test.ts && echo LOOP_TEST_ABSENT
LOOP_TEST_ABSENT

$ test ! -f tests/e2e/opening-teaching.spec.ts && echo E2E_SPEC_ABSENT
E2E_SPEC_ABSENT

$ date '+%Y-%m-%d %H:%M %Z'
2026-10-11 13:57 CST
```

## Claims (inventory only)

- V2-08…V2-15 teaching modules present on tip (workspace, resume, commands, intervention, evidence, matrix_transform, compile flags).
- Proposed loop test paths **ABSENT** (NEW).
- Feature flags `OPENING_TEACHING_WORKSPACE`, `OPENING_MATRIX_TRANSFORM_INTERACTIVE`, `OPENING_TEACHING_COMPILER_ENABLED`, `OPENING_TEACHING_VALIDATION_ENABLED`, `OPENING_RELEASE` observed; loop trial flag **proposed** in Plan as `OPENING_TEACHING_LOOP`.
- Five empty/error states mapped to existing AI readiness / materials / parse / library hooks.
- **DDL: NO** expected.
- Plan ACCEPT handoff: **Data** (not Integrator).

## Not claimed

- No Implement ACCEPT  
- No engineering/real_model/user_browser green  
- No learning_effect proven  
