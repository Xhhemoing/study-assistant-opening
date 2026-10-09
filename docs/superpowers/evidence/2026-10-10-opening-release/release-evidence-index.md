# Opening release evidence index

**Date:** 2026-10-10 ~07:44 CST (Asia/Shanghai)  
**Role:** Machine-readable index companion (RP7 option A). **Not** prod cutover. **Not** Experience HTML board.  
**Refresh:** Holistic opt slice **A** — tip moved to TZ01-verified product tip `63a4737`; quality @ `05217a5` kept as historical locator, rows marked **stale** vs tip.

| Field | Value |
|---|---|
| tipSha | `63a4737b6e0000c70733aa269ba02a5e692fbabf` |
| qualityUrl | https://github.com/Xhhemoing/study-assistant-opening/actions/runs/37958795828 |
| Primary JSON | [release-evidence-index.json](./release-evidence-index.json) |

## Checks

| checkName | commitSha (short) | result | runId | artifact |
|---|---|---|---|---|
| gha-quality | `05217a5` | stale | 37958795828 | [rp5-gha-05217a5-quality-green.md](../2026-10-09-opening-release/rp5-gha-05217a5-quality-green.md) |
| rp5-ci-gate | `05217a5` | stale | 37958795828 | [rp5-gha-05217a5-quality-green.md](../2026-10-09-opening-release/rp5-gha-05217a5-quality-green.md) |
| tz01 | `63a4737` | pass | — | [tz01-verified.md](./tz01-verified.md) |
| dl11 | `1d5c69e` | stale | — | [dl11-verified.md](./dl11-verified.md) |
| q03-packaging-gates | `030662f` | stale | — | [q03-packaging-gates-run.md](../2026-10-09-opening-release/q03-packaging-gates-run.md) |
| q03-cli-live-restore | `8a22308` | stale | — | [q03-cli-live-restore-accept.md](../2026-10-09-opening-release/q03-cli-live-restore-accept.md) |
| q03-live-minio-object-restore | `fa3cc26` | stale | — | [q03-live-minio-object-restore-accept.md](../2026-10-09-opening-release/q03-live-minio-object-restore-accept.md) |
| q03-restore-apply | `030662f` | stale | — | [q03-restore-apply-accept.md](../2026-10-09-opening-release/q03-restore-apply-accept.md) |
| q01-user-acceptance | — | unknown | — | planned |
| q02 | — | unknown | — | planned |
| q04 | — | unknown | — | planned |

## Integrity notes

- **Index ≠ prod cutover.** Presence of this file does not mean the release is cut over or Q03 verified.
- **Historical quality pass:** GHA run `37958795828` on tip `05217a5` was a real **pass** (see `rp5-gha-05217a5-quality-green.md`). Relative to index tip `63a4737`, rows `gha-quality` and `rp5-ci-gate` are **`stale`** until re-run on tip; `qualityUrl` remains the locator only.
- **TZ01:** product tip `63a4737` verified → tip-bound **`pass`** (`tz01-verified.md` / closeout accept).
- **DL11:** product `1d5c69e` / verified-docs `5187ec7` ≠ tip → **`stale`** (domain evidence still valid historically; not tip-bound). Artifacts: `dl11-verified.md`, `dl11-retest-submit-reject-early-accept.md`.
- **Q03 remains active.** Packaging / CLI live restore / MinIO object restore / restore-apply rows stay **stale**; ledger status unchanged.
- **Stale rule:** any historically green check whose `commitSha` ≠ tipSha is marked `stale` and needs re-run on tip before it can pass again. Do not silently inherit old greens.
- **Pass rule:** `result === pass` ⇒ `commitSha === tipSha` (40-char). Non-tip rows must not be `pass`.
- Tip-bound pass rows today: **`tz01` only**.

## Links

- Plan: [rp7-plan.md](./rp7-plan.md)
- Holistic opt A/B/G: [holistic-opt-abg-implement.md](./holistic-opt-abg-implement.md)
- Residual register: [residual-register.md](./residual-register.md)
- Research / AC: [15-research-hardening.md](../../plans/opening-release/15-research-hardening.md) §RP7
- Ops CI: [docs/operations/ci.md](../../../operations/ci.md)
