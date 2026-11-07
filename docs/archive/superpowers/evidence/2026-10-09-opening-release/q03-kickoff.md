# Q03 kickoff — Production image, backup recovery, operational supervision

**Date:** 2026-10-09 (Asia/Shanghai)  
**Owner:** INTEGRATOR+QA  
**Plan:** `docs/superpowers/plans/opening-release/08-delivery.md` § Q03  
**Deps:** P03 + M02 verified (tasks.json).  
**Status:** `active` (not verified; no commit).

## Create-list inventory

| Create path | State | Notes / alias already in repo |
|---|---|---|
| `tests/integration/opening-backup-privacy.test.ts` | **missing → stub added** | Domain already has `packages/domain/.../backup-privacy.test.ts` + `backup-policy.test.ts`; integration coverage under `opening-memory-deletion-backup.test.ts`, `opening-backup-records-repository.test.ts`, etc. Q01 expects this Create-list path. |
| `infra/docker/Dockerfile.opening-web` | **missing** | Root `Dockerfile` is a single Next standalone web image (no opening-web/worker split). |
| `infra/docker/Dockerfile.opening-worker` | **missing** | No parser-heavy worker image yet. |
| `infra/docker/compose.opening.yml` | **missing** | Dev stack is `infra/docker/compose.yml` (default passwords, public ports) — must **not** be treated as production. Also `infra/deploy/compose.aistudy.yml`. |
| `infra/docker/opening.env.example` | **missing** | Root `.env.example` exists; no opening-production env template. |
| `apps/web/src/app/api/opening/health/route.ts` | **present** | Uses `opening-readiness-probes.mjs` + health-summary. |
| `packages/database/src/repositories/opening-backup.ts` | **missing (monolith)** | Split modules present: `opening-backup-{compose,prepare,records,sources,current,versions,...}.ts` + storage `opening-backup-{archive,cipher,manifest,stage,reader,...}.ts`. No `exportOpeningBackup(scope)` entrypoint matching the plan interface name. |
| `scripts/opening-backup.ts` | **missing** | Called out as deferred in ops doc. |
| `scripts/opening-restore.ts` | **missing** | Restore planner exists (`backup-apply-plan`); apply executor + CLI still deferred. |
| `scripts/opening-readiness.mjs` | **present** | Plus `opening-readiness-probes.mjs` and tooling tests. |
| `docs/operations/opening-release.md` | **present** | Already lists Docker packaging + backup/restore CLIs as not implemented. |

## Present (usable foundation)

- Backup domain policy / compose / privacy / apply-plan (pure).
- DB-backed backup prepare/records/compose + encrypted archive path.
- Health + readiness aggregation (owner, registration, HTTPS, storage, DB/Redis, provider, daily cap, backup freshness).
- Ops doc with honest blocked list.

## Missing (Q03 delivery gap)

- Create-list Docker split (`Dockerfile.opening-web` / `Dockerfile.opening-worker`) and production compose profile (`compose.opening.yml` + `opening.env.example`): loopback bindings, non-default credentials, limits, healthchecks — distinct from current default-password `compose.yml`.
- Monolithic / named `opening-backup.ts` repository export + `opening-backup.ts` / `opening-restore.ts` CLIs.
- Isolated restore-apply drill evidence.
- Create-list integration gate file (now stubbed red).

## First next implement slice

1. **Done this kickoff:** add failing Create-list gate `tests/integration/opening-backup-privacy.test.ts` (requires missing `opening-backup.ts` entrypoint; keeps domain fail-closed cases visible for Q01).
2. **Next:** scaffold `infra/docker/Dockerfile.opening-web` + `Dockerfile.opening-worker` and `compose.opening.yml` / `opening.env.example` production profiles (no deploy).
3. Then: thin `packages/database/.../opening-backup.ts` re-export/`exportOpeningBackup` wrapper + backup/restore CLI stubs; turn privacy gate green without boiling the ocean.
4. Packaging gates + restore drill evidence only after the above; do not mark verified from inventory alone.

## Constraints

- No commit / push.
- No verified status.
- Packaging success ≠ deployed / authorized production change.

## Slice #2 progress (2026-10-09)

Scaffolded Create-list Docker paths (no build/deploy/commit):

- `infra/docker/Dockerfile.opening-web`
- `infra/docker/Dockerfile.opening-worker`
- `infra/docker/compose.opening.yml`
- `infra/docker/opening.env.example`

Evidence: `q03-docker-scaffold.md`. Q03 stays **active** (not verified).

## Slice #3 progress (2026-10-09)

Thin backup entrypoint + CLI stubs (no verified / no commit):

- `packages/database/src/repositories/opening-backup.ts` (`exportOpeningBackup` wrap)
- barrel export in `packages/database/src/index.ts`
- `scripts/opening-backup.ts` / `scripts/opening-restore.ts` confirmation-gated stubs
- Privacy Create-list gate: 4/4 passed

Evidence: `q03-backup-entrypoint.md`. Q03 stays **active** (not verified).

## Slice #4 progress (2026-10-09)

Thin archive/cipher/manifest CLI wiring + fail-closed restore apply stub + packaging gaps checklist (no verified / no commit / no deploy):

- `publishOpeningBackupArchive` + storage re-exports on `opening-backup.ts`
- `scripts/opening-backup.ts` fail-closed when staging incomplete; optional encrypt via `OPENING_BACKUP_PASSPHRASE`
- `applyOpeningRestore({ confirmLocalRestore })` returns deferred with `pendingJobs: cancelled`, secrets never restored
- `scripts/opening-restore.ts` prints guarantees and exits 1
- Evidence: `q03-backup-entrypoint.md`, `q03-packaging-gaps.md`

Q03 stays **active** (not verified). Full DB+S3 CLI export and restore drill remain deferred.
