# Q03 slice — Backup entrypoint + archive/cipher CLI wiring + restore stub

**Date:** 2026-10-09 (Asia/Shanghai)  
**Owner:** INTEGRATOR+QA  
**Status:** thin wiring — **not verified**, **no commit**, **no deploy**.

## Created / wired

| Path | Role |
|---|---|
| `packages/database/src/repositories/opening-backup.ts` | `exportOpeningBackup`; `publishOpeningBackupArchive` (archive+optional cipher, fail-closed `STAGING_INCOMPLETE`); fail-closed `applyOpeningRestore` stub with guarantees; re-exports archive/cipher/manifest/reader |
| `packages/database/src/repositories/opening-backup-entrypoint.test.ts` | Unit: apply stub guarantees + publish fail-closed / happy path |
| `packages/database/src/index.ts` | Barrel exports for publish + storage helpers |
| `packages/domain/src/index.ts` | Exports `planOpeningRestoreApply` |
| `scripts/opening-backup.ts` | Confirm-gated CLI; local staged draft → archive [→ encrypt]; fail-closed if staging incomplete |
| `scripts/opening-restore.ts` | Confirm-gated CLI; calls apply stub; prints guarantees; exit 1 |
| `docs/.../q03-packaging-gaps.md` | Packaging gates checklist (honest gaps) |

## Test status

Entrypoint unit:

```
node node_modules/vitest/vitest.mjs run packages/database/src/repositories/opening-backup-entrypoint.test.ts
```

(Privacy Create-list gate previously 4/4; re-run if needed.)

CLI smoke (expected):

| Command | Exit |
|---|---|
| `tsx scripts/opening-backup.ts` (no flag) | 2 refuse |
| `tsx scripts/opening-backup.ts --confirm-local-backup` (no staging) | 1 fail-closed staging incomplete |
| `tsx scripts/opening-restore.ts` (no flag) | 2 refuse |
| `tsx scripts/opening-restore.ts --confirm-local-restore` | 1 fail-closed APPLY_EXECUTOR_DEFERRED |

## Remaining gaps (honest)

- **Full CLI export** still deferred: live `exportOpeningBackup(sql, scope, parent, reader)` + S3 object reader not driven end-to-end by the CLI.
- **Restore apply executor** still deferred: stub never mutates; guarantees document `pendingJobs: cancelled` and no secrets.
- Docker image build / compose up / restore drill / packaging green: see `q03-packaging-gaps.md`.
- Plan interface `exportOpeningBackup(scope)` still approximated with sql/parent/reader deps.

## Tasks

`docs/superpowers/plans/opening-release/tasks.json` **Q03 remains `active`** — do not mark verified.
