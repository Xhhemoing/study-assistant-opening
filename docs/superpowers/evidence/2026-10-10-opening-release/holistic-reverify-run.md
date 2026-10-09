# Holistic reverify — agent read-only run log

**Date:** 2026-10-10 ~07:44 CST (Asia/Shanghai)  
**Slice:** Holistic opt **B** (docs/evidence only)  
**Branch:** `feat/opening-release`  
**Product tip context:** `63a4737` (TZ01-verified product tip Paula named for index refresh)  
**Later docs tips:** e.g. `0aa641b` / `6dc9021` (Understand/Plan + Experience readonly gate notes) — product surface unchanged  
**Mode:** read-only re-verify; **no** product edits; **no** hermes redeploy; **no** ledger / `tasks.json` flips; **no** claim of packaging-green or prod cutover

## Summary totals

| Owner | Result | Notes |
|---|---|---|
| AI | **116 PASS** | 9 files — provider / errors / usage / effective-cap / catalog-merge / budget-local-day + budgeted-call / budget-contract-discovery / tutor-turn |
| Data | **121 PASS** | day-planner / local-day-bounds / retest + reminders / observations.retest-earliest (+ related); domain/database `tsc` 0 |
| Experience | **77 unit + 4 browser PASS** | plan-service / retest unit subset; browser: `guidance-modes.spec.ts` + `today-plan.spec.ts` (~2.2m) with `OPENING_RELEASE=0` + e2e DB |

Suites may overlap across owners; counts are **not** additive unique tests.

## Tip relationship

- Claimed run tip: **`63a4737`**.
- Docs commits after product tip do not change the product surface under test.
- RP7 quality tip remains historically green at **`05217a5`** / GHA `37958795828`; relative to tip `63a4737` those index rows are **stale** (see [release-evidence-index.md](./release-evidence-index.md)).

## Commands

Full command paste and gate notes: **[holistic-verify-readonly-gates.md](./holistic-verify-readonly-gates.md)**.

Plan context: [holistic-verify-plan.md](./holistic-verify-plan.md) §1.

## Explicit non-claims

- Not a GHA quality re-run on `63a4737`.
- Not Q03 packaging / Docker / compose green.
- Not Q01 / Q02 / Q04 verified.
- Not hermes live deep-fix or redeploy.
