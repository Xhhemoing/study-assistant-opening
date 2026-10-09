# RP5 — CI gate for active release branch

**Date:** 2026-10-09 (Asia/Shanghai)  
**Owner:** INTEGRATOR  
**Plan:** `docs/superpowers/plans/opening-release/12-review-hardening.md` § RP5  
**Depends:** B02 verified (`tasks.json`)  
**Workspace HEAD:** `a9b87cb9389d827e55583567c0f9531cc4a9d578` (dirty tree; many unrelated WIP files)  
**Status:** **active**, **not verified**. No commit / no push by Integrator.

## What changed (this Integrator pass)

1. `docs/superpowers/plans/opening-release/tasks.json` — surgical status only: RP5 `planned` → `active` (1-space indent preserved; evidence array left `[]`).
2. `.github/workflows/ci.yml` — **no edit this pass**. Required content already present on `feat/opening-release` HEAD:
   - `push.branches` includes `main` and `feat/opening-release`
   - `workflow_dispatch` present
3. `docs/operations/ci.md` — **no edit this pass**. Trigger scope and release-evidence rules already document:
   - triggers: every PR, push to `main` or `feat/opening-release`, and `workflow_dispatch`
   - release evidence must cite the GitHub Actions `quality` job URL + result for the **exact commit SHA**
   - citation location: Q03 readiness checklist in `docs/superpowers/plans/opening-release/08-delivery.md` (section "Q03: Production image, backup recovery and operational supervision"); do not invent a separate citation file

Prior RP5 implementation evidence (2026-09-21) remains at `docs/superpowers/evidence/2026-09-21-opening-release/rp5-ci-gate.md`. This file is the 2026-10-09 Integrator re-activation / re-check record.

## External images in the workflow (re-check 2026-10-09)

Workflow service images: `postgres:16-alpine`, `redis:7-alpine`, `bitnamilegacy/minio:2025.4.22-debian-12-r2`.

| Image | Hub API (2026-10-09) | Action |
|---|---|---|
| `bitnami/minio` (any tag) | `count: 0` pullable tags | **Do not revert**; already replaced in-file |
| `bitnamilegacy/minio:2025.4.22-debian-12-r2` | tag present; linux/amd64 + arm64 `active`; `last_pulled` 2026-10-09 | Keep; in-file comments already explain Bitnami legacy move |
| `postgres:16-alpine` / `redis:7-alpine` | not re-probed this pass (library images; historically CI-pullable) | Keep |

No silent image swap this pass: workflow comments already authorize / document the `bitnamilegacy` replacement. Box has no Docker CLI; this is registry API existence only, not a pulled container or GHA service health proof.

## Explicit gap (blocks verified)

**No GitHub Actions `quality` job run link yet.** Integrator must **not** commit or push unless Paula/PM asks. Plan acceptance: 验收以 GitHub Actions 记录为准 — a green claim without the Actions URL + conclusion for the release SHA is invalid.

Until someone pushes the branch (or runs `workflow_dispatch` on a concrete SHA) and records:

- Actions run URL for job `quality` / `lint-typecheck-test-build`
- conclusion (success/failure)
- exact commit SHA

RP5 stays **active**, **not verified**.

## Not done

- Commit / push
- Marking RP5 `verified`
- Fabricating or inventing a CI run URL
- Changing MinIO / other service images beyond the already-documented legacy pin
