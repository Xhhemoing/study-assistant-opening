# RP5 — GHA quality after unit fixes (`retest:null` + sticky catalog)

**Date:** 2026-10-09 ~22:22 CST (Asia/Shanghai)  
**Owner:** INTEGRATOR  
**Status:** **observed failure** — RP5 stays **active**, **not verified**. No fabricate.

## Push under test

| Field | Value |
|---|---|
| Commit | `792d1d431fa6dec1a93e52bfa014fa987f14b384` |
| Message | `fix(opening): restore retest:null task expectations and sticky catalog availability` |
| Run | https://github.com/Xhhemoing/study-assistant-opening/actions/runs/37941873718 |
| Job | https://github.com/Xhhemoing/study-assistant-opening/actions/runs/37941873718/job/113858218284 |
| Conclusion | **failure** |

## What passed (progress vs prior unit failure)

- Lint — success  
- Typecheck — success  
- Plan and tooling checks — success  
- **Unit and contract tests — success** (2460 passed | 12 skipped | 1 todo; 370 files passed | 1 skipped)  
  - Prior unit failures (`opening-plans` / `opening-retest-task` `retest: null`, `ai-settings` 409) **cleared**  
- Technology spike tests — success  
- Setup / parser / install — success  

## What failed

- Step **Integration tests** — exit 1  
- Summary: **7 failed** | 600 passed | 1 skipped (99 files: 4 failed | 94 passed | 1 skipped)  
- Failed annotations (integration):
  1. `tests/integration/identity-migration-compatibility.test.ts:173` — expected migration list ending at `0045_opening_imports.sql`; received includes `0046`…`0052`
  2. `tests/integration/identity-migration-compatibility.test.ts:256` — same stale expected migration list
  3. `tests/integration/identity-migration-compatibility.test.ts:595` — same (from `0004_identity_repair.sql` baseline)
  4. `tests/integration/opening-learning-consumer-races.test.ts:66` — expected `[]` exclusion candidates; received 1 id
  5. `tests/integration/opening-observation-revision-backup-privacy.test.ts` (×2) — `VALIDATION` / `reference check cannot change the answer` via `opening-learning-facts.ts:5` / `opening-observation-revisions.ts:60`
  6. `tests/integration/opening-sources-storage.test.ts:67` — expected parse status `not_started`; received `queued`

Later route-handler / browser / build steps skipped.

## Notes

- This failure is **beyond** the accepted unit slice; unit gate for the three prior regressions is green on this SHA.  
- Integration drift looks like stale expected migration lists (0046–0052) plus learning/privacy/sources assertion mismatches — **not** introduced by the sticky `catalog-merge` or `retest: null` expectation edits.  
- Do **not** mark RP5 `verified`. Do **not** write `rp5-verified.md`.

## Ledger

- Append this file to RP5 `evidence` in `tasks.json`
- RP5 **status remains `active`**
