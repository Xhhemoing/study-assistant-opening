# Q03 — Packaging gates evidence checklist (gaps)

**Date:** 2026-10-09 (Asia/Shanghai)  
**Owner:** INTEGRATOR+QA  
**Status:** checklist only — **not verified**, **no commit**, **no deploy**.  
**Plan gate:** `08-delivery.md` § Q03 — “Run packaging gates: lint, typecheck, guarded backup/privacy tests, production build and restore drill.”

## Gate matrix

| Gate | Required by plan | Current state | Evidence / command | Blocked reason |
|---|---|---|---|---|
| Lint | yes | **not run this slice** | `npm run lint` (repo root) | Deferred; dirty worktree unrelated changes may noise the run |
| Typecheck | partial | database `tsc --noEmit` previously green; full monorepo not claimed | `tsc -p packages/database/tsconfig.json --noEmit` | Full-workspace typecheck + web/worker builds not claimed |
| Guarded backup/privacy tests | yes | Create-list gate **4/4 passed** earlier; entrypoint unit test added this slice | `OPENING_TEST_DB=1 … vitest run --project integration tests/integration/opening-backup-privacy.test.ts`; `vitest` unit for `opening-backup-entrypoint.test.ts` | Integration privacy gate does not equal packaging green |
| Production image build | yes | Dockerfiles scaffolded only | `infra/docker/Dockerfile.opening-{web,worker}` | **No image build** this slice; packaging ≠ deploy |
| Compose up (prod profile) | yes | `compose.opening.yml` + `opening.env.example` scaffold | `infra/docker/compose.opening.yml` | **No compose up**; missing real secrets / authorization |
| Restore drill (isolated empty DB/S3) | yes | dry-run + **empty-namespace preflight** wired; row/object apply still deferred | dry-run plan; confirm+counts → `TARGET_NOT_EMPTY` or deferred with `emptyNamespaceVerified` | No mutating apply; shared test DB populated; no docker empty namespace |
| Backup CLI archive/encrypt wiring | supporting | **thin local publish** wired; fail-closed if staging incomplete | `scripts/opening-backup.ts --confirm-local-backup --staging … --draft … --out …` | Full `exportOpeningBackup` + live S3 path still deferred |
| Readiness / health | present | audited vs §Q03 list; registration403 detail; plan→check docs | `scripts/opening-readiness.mjs`, `/api/opening/health` (coarse) | Alert destination honesty via `alertDelivery`; ops must set `ALERT_WEBHOOK_URL` |
| CI release-SHA evidence | yes | not this slice | `docs/operations/ci.md` | Requires commit SHA; **no commit** |

## Present Create-list paths (scaffold / stubs)

- `tests/integration/opening-backup-privacy.test.ts`
- `infra/docker/Dockerfile.opening-web` / `Dockerfile.opening-worker`
- `infra/docker/compose.opening.yml` / `opening.env.example`
- `packages/database/src/repositories/opening-backup.ts` (`exportOpeningBackup`, `publishOpeningBackupArchive`, dry-run/plan-only + fail-closed `applyOpeningRestore`)
- `scripts/opening-backup.ts` / `scripts/opening-restore.ts`
- `scripts/opening-readiness.mjs`
- `docs/operations/opening-release.md`

## Honest remaining gaps

1. **No packaging green claim** — lint / full typecheck / production build / compose up / restore drill not executed as a package.
2. **No full backup E2E** — CLI publishes from a pre-staged draft only; does not assemble from live DB+S3 in this slice.
3. **No mutating restore apply** — dry-run `DRY_RUN_OK`; empty-namespace gate can return `TARGET_NOT_EMPTY` or deferred with `emptyNamespaceVerified`; still no Opening insert executor. Guarantees: `pendingJobs: cancelled`, secrets never restored.
4. **No deploy / authorization** — image build success would still not mean deployed.
5. **Q03 stays `active`** in `tasks.json` — do not mark verified from this checklist.

## What would close packaging (future)

1. Clean lint + typecheck on packaging-relevant packages.
2. Guarded privacy + entrypoint tests green under `OPENING_TEST_DB`.
3. Local `docker build` for web/worker images (artifact hashes recorded).
4. Compose up against non-default secrets on loopback; readiness probes green.
5. Isolated restore drill after a real apply executor (confirm flag, journal re-read, cancelled pending jobs, no secrets).
6. Supply artifacts to Q01/Q02 final sequence — still not “deployed”.

---

## Cheap gates re-run (2026-10-09 18:34 CST)

See `q03-packaging-gates-run.md` for full matrix.

| Gate | Result |
|---|---|
| `tsc -p packages/database --noEmit` | **PASS** (18:33:22 CST) |
| `opening-backup-entrypoint.test.ts` | **PASS** 3/3 (18:33:23 CST) |
| `opening-backup-privacy.test.ts` | **PASS** 4/4 (18:34:26 CST; needs `OPENING_TEST_DB` + `OPENING_TEST_DATABASE_URL`) |
| Scoped eslint (backup/privacy paths) | **PASS** (18:34:20 CST) |
| Full `npm run lint` / monorepo typecheck+build | **SKIPPED** |
| Image build / compose up / restore drill / live S3 | **NOT RUN** — still block verified |

**Q03 stays `active`.** No commit. No deploy. No verified claim.

---

## Restore-apply dry-run progress (2026-10-09 19:12 CST)

See `q03-restore-apply-progress.md`.

| Gate | Result |
|---|---|
| Entrypoint unit (incl. dry-run) | **PASS** 5/5 |
| `tsc` database + domain | **PASS** |
| Restore CLI dry-run plan | **PASS** (exit 0, mutated=false) |
| Mutating Opening apply / isolated drill / Docker | **NOT DONE** — still block verified |

**Q03 stays `active`.** No commit. No deploy. No verified claim.

---

## Continue slice (2026-10-09 19:36 CST)

See `q03-continue-empty-namespace-readiness.md`.

| Gate | Result |
|---|---|
| `tsc` database | **PASS** |
| Entrypoint + empty-namespace unit | **PASS** (entrypoint now 7 cases incl. empty-namespace) |
| Privacy + empty-namespace integration | **PASS** 6/6 under `OPENING_TEST_DB` |
| Readiness tooling tests | **PASS** 18/18 |
| Scoped eslint | **PASS** |
| Mutating Opening apply / Docker / verified | **NOT DONE** |

**Q03 stays `active`.** No commit. No deploy. No Docker claims.

---

## Cheap fixture roundtrip (2026-10-09 19:39 CST)

See `q03-cheap-fixture-roundtrip.md` + `q03-fixture-apply-plan-artifact.json`.

| Gate | Result |
|---|---|
| Local publish (`opening-backup.ts` archive+encrypt from staged draft) | **PASS** exit 0 (no live S3) |
| Restore dry-run chain | **PASS** exit 0; `DRY_RUN_OK`; `mutated=false` |
| Non-executing `planOpeningRestoreApply` artifact | **PASS**; `mutated:false` / `executed:false` |
| `tsc` packages/domain + packages/database | **PASS** |
| Mutating Opening apply / Docker / live S3 / verified | **NOT DONE** |

**Q03 stays `active`.** No commit. No deploy. No Docker claims. No verified.

---

## No-Docker packaging/docs eval after apply-executor ACCEPT (2026-10-09 ~21:12 CST)

Context: Data **ACCEPT**ed the Opening apply-executor **slice** (`q03-restore-apply-accept.md`). Q03 remains **`active` / not verified**. Docker CLI still **absent** on this box. Cheap scoped eslint/tsc/privacy already green earlier — **not re-churned**.

### Still doable locally (no Docker)

| Item | State | Notes |
|---|---|---|
| Scoped `tsc` domain + database | **already green** | Data re-run attested; see accept md |
| Unit apply/entrypoint/empty-namespace/plan | **already green** (25) | Data re-run |
| `OPENING_TEST_DB` empty-workspace apply + empty-namespace integration | **already green** (3) | Dedicated workspace UUID; not shared wipe |
| Guarded privacy integration | **already green** (prior slice) | Does not equal packaging green |
| Scoped eslint on backup/privacy paths | **already green** (prior) | Do not churn |
| Thin local backup publish + restore dry-run fixture chain | **already green** | `q03-cheap-fixture-roundtrip.md` |
| Readiness CLI / ops readiness table | **present** | `scripts/opening-readiness.mjs`; table in `opening-release.md` |
| Ops doc honesty vs apply-executor reality | **updated this turn** | Status/blocked bullets no longer claim executor missing |
| Evidence + `tasks.json` ledger hygiene | **this turn** | Accept md + evidence path; status stays `active` |

### Still blocked (need Docker / live infra / commit / auth)

| Item | Blocker |
|---|---|
| Production image build (`Dockerfile.opening-{web,worker}`) | **No docker CLI**; packaging ≠ deploy |
| Compose up prod profile (`compose.opening.yml`) | No docker; needs non-default secrets / authorization |
| Isolated empty DB/S3 restore drill via compose-fresh namespace | Docker absent; shared `aistudy_opening_test` is populated |
| Live S3 object restore path | Integration used in-memory `objectPut` only |
| Full live `exportOpeningBackup` + archive + apply E2E | Thin CLI publishes from staged draft; no live DB+S3 assemble→apply claim |
| Full monorepo `npm run lint` / typecheck / production build | Deferred; dirty worktree noise; not claimed packaging green |
| CI release-SHA evidence | **No commit** this work; see `docs/operations/ci.md` |
| Deploy / purchase / public release | Explicitly unauthorized |

### Matrix delta vs earlier checklist

- Prior gap “No mutating restore apply / APPLY_EXECUTOR_DEFERRED forever” is **closed for the confirm+sql+empty path** (slice ACCEPT). CLI-without-sql and objectApplyDeferred honesty gaps remain.
- Packaging green, Docker, live S3, full backup E2E, CI SHA still **block verified**.

**Q03 stays `active`.** No commit. No deploy. No Docker claims. No verified.

---

## Live MinIO object restore + export E2E (2026-10-09 ~21:31 CST)

See `q03-live-minio-object-restore.md`.

| Gate | Result |
|---|---|
| Live MinIO `OpeningRestoreObjectPut` + `objectApplyDeferred=false` | **PASS** (dedicated UUID/keys) |
| Full `exportOpeningBackup` → archive → apply on empty workspace | **PASS** (OPENING_TEST_DB + MinIO) |
| Unit 31 + domain/database tsc | **PASS** |
| Docker image/compose / packaging green / verified | **NOT CLAIMED** |

**Q03 stays `active`.** READY_FOR_DATA_ACCEPT (IMPLEMENT only).


---

## Post CLI-accept remaining (2026-10-09 ~22:54 CST)

Data **ACCEPT** recorded (`q03-cli-live-restore-accept.md`). Agent-owned no-Docker restore slices (dry-run, empty-namespace, apply executor, live MinIO objectPut, CLI live restore) are done. **Q03 stays `active` / not verified.**

Explicit remaining for Q03 **verified** (only):

1. Docker/compose production image build + compose up (Docker CLI historically absent on this box)
2. Full monorepo packaging green (lint / full typecheck / production build as a package)
3. CI quality green on a release SHA that includes packaging/restore evidence
4. Optional: encrypted-archive decrypt→CLI path if still in plan gaps

No more meaningful no-Docker IMPLEMENT slices claimed without new env.
