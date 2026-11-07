# RP7 — IMPLEMENT: release evidence index

**Date:** 2026-10-10 ~00:50 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release`  
**Owner:** INTEGRATOR  
**Status:** IMPLEMENT done on disk — **READY_FOR_ACCEPT** (Data or Experience). No commit / no push.

## What was created

| Path | Role |
|---|---|
| `docs/superpowers/evidence/2026-10-10-opening-release/release-evidence-index.json` | Primary machine index (option A) |
| `docs/superpowers/evidence/2026-10-10-opening-release/release-evidence-index.md` | Short human companion table |
| `docs/operations/ci.md` | Surgical cross-link subsection |
| `docs/superpowers/plans/opening-release/tasks.json` | RP7 evidence paths appended only; status stays `active` |

## Seed tip

- tipSha (full 40): `05217a5ceaec7dfe924e3c9783f39bd0db63da51`
- qualityUrl / runId: `37958795828` → pass (`gha-quality`, `rp5-ci-gate`)

## Stale rule applied

Q03 rows with resolvable prior SHAs ≠ tip → `stale` (never silent inherit):

- `q03-packaging-gates` @ `030662f…`
- `q03-cli-live-restore` @ `8a22308…`
- `q03-live-minio-object-restore` @ `fa3cc26…`
- `q03-restore-apply` @ `030662f…`

Placeholders `q01-user-acceptance`, `q02`, `q04`: `commitSha` null, `result` `unknown`.

## Explicit non-claims

- No Experience HTML board this slice.
- No Docker, no `apps/web` edits, no Q03/RP5/Q01–Q04 ledger status flips.
- Index presence ≠ prod cutover ≠ Q03 verified.

## Gate

**READY_FOR_ACCEPT** — hand to **Data** (schema/integrity + Q03 stale honesty) or **Experience** (optional later HTML consumer of JSON). Accept agent only; do not mark RP7 `verified` in this IMPLEMENT pass.
