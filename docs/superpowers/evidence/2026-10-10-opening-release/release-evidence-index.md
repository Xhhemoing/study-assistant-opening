# Opening release evidence index

**Date:** 2026-10-10 ~00:50 CST (Asia/Shanghai)  
**Role:** Machine-readable index companion (RP7 option A). **Not** prod cutover. **Not** Experience HTML board.

| Field | Value |
|---|---|
| tipSha | `05217a5ceaec7dfe924e3c9783f39bd0db63da51` |
| qualityUrl | https://github.com/Xhhemoing/study-assistant-opening/actions/runs/37958795828 |
| Primary JSON | [release-evidence-index.json](./release-evidence-index.json) |

## Checks

| checkName | commitSha (short) | result | runId | artifact |
|---|---|---|---|---|
| gha-quality | `05217a5` | pass | 37958795828 | [rp5-gha-05217a5-quality-green.md](../2026-10-09-opening-release/rp5-gha-05217a5-quality-green.md) |
| rp5-ci-gate | `05217a5` | pass | 37958795828 | [rp5-gha-05217a5-quality-green.md](../2026-10-09-opening-release/rp5-gha-05217a5-quality-green.md) |
| q03-packaging-gates | `030662f` | stale | — | [q03-packaging-gates-run.md](../2026-10-09-opening-release/q03-packaging-gates-run.md) |
| q03-cli-live-restore | `8a22308` | stale | — | [q03-cli-live-restore-accept.md](../2026-10-09-opening-release/q03-cli-live-restore-accept.md) |
| q03-live-minio-object-restore | `fa3cc26` | stale | — | [q03-live-minio-object-restore-accept.md](../2026-10-09-opening-release/q03-live-minio-object-restore-accept.md) |
| q03-restore-apply | `030662f` | stale | — | [q03-restore-apply-accept.md](../2026-10-09-opening-release/q03-restore-apply-accept.md) |
| q01-user-acceptance | — | unknown | — | planned |
| q02 | — | unknown | — | planned |
| q04 | — | unknown | — | planned |

## Integrity notes

- **Index ≠ prod cutover.** Presence of this file does not mean the release is cut over or Q03 verified.
- **Q03 remains active.** Packaging / CLI live restore / MinIO object restore / restore-apply rows are cited for honesty; ledger status is unchanged.
- **Stale rule:** any historically green check whose `commitSha` ≠ tipSha is marked `stale` and needs re-run on tip before it can pass again. Do not silently inherit old greens.
- Tip-bound pass rows today: `gha-quality`, `rp5-ci-gate` only (GHA run `37958795828`).

## Links

- Plan: [rp7-plan.md](./rp7-plan.md)
- Research / AC: [15-research-hardening.md](../../plans/opening-release/15-research-hardening.md) §RP7
- Ops CI: [docs/operations/ci.md](../../../operations/ci.md)
