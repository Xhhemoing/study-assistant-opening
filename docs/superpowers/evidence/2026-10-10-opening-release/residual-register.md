# Opening release — residual register

**Date:** 2026-10-10 ~07:44 CST (Asia/Shanghai)  
**Slice:** Holistic opt **G**  
**Branch:** `feat/opening-release`  
**Index tip:** `63a4737` · **RP7 quality tip (historical):** `05217a5`  
**Purpose:** One honest page of **open** residuals. Verified work ≠ zero gap. **No fake closures.**

Companion: [release-evidence-index.md](./release-evidence-index.md) · [holistic-verify-plan.md](./holistic-verify-plan.md) §4 · [holistic-reverify-run.md](./holistic-reverify-run.md)

---

## Open residuals

| ID | Residual | Status | Why still open | Unblock / next |
|---|---|---|---|---|
| R1 | **Q03 Docker / packaging / restore drill** | open (active ledger) | Image build, compose.opening green, full restore drill not claimed; index Q03 rows **stale** | Docker + Integrator packaging gates; re-bind evidence to tip |
| R2 | **Q01 user acceptance** | open (planned) | Depends on Q03 path; Create-list gaps; prep accepted but IMPLEMENT not authorized as verified | Q03 path + PM authorize Phase2/3 + observe evidence |
| R3 | **Q02 / Q04** | open (planned) | Depend on Q01 (Q04 also U04 already verified) | After Q01 verified path |
| R4 | **RP7 tip vs quality tip** | open (index honesty) | Index tipSha = `63a4737`; GHA quality pass remains on `05217a5` / `37958795828` → `gha-quality` / `rp5-ci-gate` **stale** | Re-run quality on tip (or accept stale until then) |
| R5 | **DL11 ≠ tip** | open (stale vs tip) | Product `1d5c69e` / docs verify `5187ec7` ≠ tip; domain AC historically met | Optional tip-bound re-cite after tip move; not a failure of DL11 AC |
| R6 | **TZ01 nature-test matrix partial** | open (accepted partial) | Overnight / DST / adjacent locks present; overlapping free capacity / full seasonal expand **not** claimed | Optional slice C if PM wants tighter residual |
| R7 | **Hermes redeploy / live deep-fix** | gated | No redeploy this pass; live provider/vision constrained by deploy + budget | Explicit PM authorize redeploy + budget |
| R8 | **Q01-prep Phase2 skip reds** | open (auth-gated) | Red skeleton / skipped WIP need auth; default CI must not run reds | PM authorize Phase2; keep reds out of default CI |
| R9 | **BC1 web `operationId`** | deferred | Accepted deferral (ephemeral web short path) | Optional slice D if authorized |
| R10 | **Packaging-green / prod cutover** | blocked | Never from local scaffold / index presence alone | Explicit auth + packaging path |

---

## Tip-bound vs historical (quick)

| Claim | Tip-bound? | Notes |
|---|---|---|
| TZ01 verified | **yes** (`63a4737`) | Index row `tz01` = **pass** |
| Holistic agent readonly gates | tip context `63a4737` | AI 116 / Data 121 / Exp 77+4 — see reverify log |
| GHA quality `37958795828` | **no** (`05217a5`) | Real historical **pass**; index **stale** vs tip |
| DL11 verified | **no** (`1d5c69e`) | Real historical verify; index **stale** vs tip |
| Q03 packaging | **no** | stale / not claimed green |

---

## Explicitly not closed by this register

- Q03 / Q01 / Q02 / Q04 ledger flips  
- Hermes redeploy  
- Silent inheritance of `05217a5` quality as tip-bound pass  
- Prod cutover / `npm audit fix --force` / new agent frameworks  

---

## Gate

**READY_FOR_ACCEPT** (suggest **Data**) — docs/evidence only; Integrator commit/push after Accept.
