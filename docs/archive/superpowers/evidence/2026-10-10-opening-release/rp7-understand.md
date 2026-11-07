# RP7 — Understand: release evidence index (same tip SHA)

**Date:** 2026-10-10 ~00:48 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release`  
**Owner (ledger):** INTEGRATOR  
**Plan source:** `15-research-hardening.md` §RP7; research §5.1 P0  
**Gate:** Understand only — **no IMPLEMENT** in this pass

## Restatement

Publish status is not one boolean. “Task verified”, “CI green”, “real environment usable”, and “user acceptance done” are different facts. RP7 builds a **release evidence index** bound to **one tip SHA**: each required check is a row with Research §5.1 fields (`commitSha`, `checkName`, `runId`, `environment`, `completedAt`, `result`, `artifact`). Missing evidence is `unknown`; a pass on an older SHA is `stale`; in-flight is `pending`; failures keep a run/locator URL. Credentials never enter the index.

**Done when:** a release candidate can be audited as **one tip SHA + one index + one quality URL** together — not by treating “tasks verified” or “an index file exists” as delivery.

## Current anchor (pre-IMPLEMENT seed)

| Fact | Value |
|---|---|
| Quality tip SHA | `05217a5ceaec7dfe924e3c9783f39bd0db63da51` |
| Quality run | https://github.com/Xhhemoing/study-assistant-opening/actions/runs/37958795828 |
| Job | `lint-typecheck-test-build` — **success** (Browser + Build included) |
| RP5 evidence | `docs/superpowers/evidence/2026-10-09-opening-release/rp5-gha-05217a5-quality-green.md` |
| Branch HEAD (docs after quality) | `4e18dc7` — ledger commit only; **not** the quality-bound tip unless a new quality run lands on it |

RP5 is already **verified** on that quality tip. Q03 remains **active** (independent packaging/restore track). RP7 must not flip Q03 / Q01–Q04 status.

## In scope (this task)

- Agree schema + paths for a machine-readable index (and optional human view).
- Seed rows for the current tip: quality **pass** @ `05217a5` / run `37958795828`; RP5 evidence path; Q03 packaging/restore evidence paths as honest `unknown` or `stale` until re-checked against the same tip.
- Cross-link `docs/operations/ci.md` / Q03 readiness paths by reference only.
- Keep index under evidence docs — **no** `apps/web` routes.

## Out of scope

- Production cutover / force-push / CAS publish.
- Building a complex workflow engine or replacing GHA.
- Marking Q01–Q04 (or Q03) verified; Docker work for Q03.
- Implementing the index JSON/MD/HTML in this Understand→Plan pass.
- Touching `apps/web` product code.
- Putting secrets, tokens, or connection strings in any index artifact.

## User decisions still open

1. **Primary index format:** JSON as machine source of truth with a companion `.md` human view, **or** JSON only with Experience owning the human view.
2. **Experience timing:** build a read-only static HTML board that consumes the JSON **now** (parallel to INTEGRATOR seeding JSON), **or** after the JSON seed lands.

Neither decision blocks writing the Understand/Plan; both block IMPLEMENT shape.

## Success criteria (audit)

A reviewer can point at:

1. Tip SHA `05217a5…` (or a successor tip after re-run),
2. One index file (proposed path in Plan),
3. Quality URL `…/actions/runs/37958795828` (or successor),

and verify every required row’s `result` without treating the mere presence of the plan or index as “gate passed” or “ready for prod”.
