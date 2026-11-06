# Q03 — Live MinIO object restore slice — Data ACCEPT

**Date:** 2026-10-09 ~21:41 CST (Asia/Shanghai)  
**Workspace:** `/workspace/study-assistant-opening`  
**Branch:** `feat/opening-release` (uncommitted)  
**Scope:** Agent **ACCEPT** of the Opening-scoped **live MinIO object restore + export→archive→apply E2E** slice only (IMPLEMENT evidence: `q03-live-minio-object-restore.md`).  
**Verdict:** **ACCEPT** (slice only). **Not verified.** Full **Q03 stays `active`.**  
**Attestation:** PM reports AIstudy **Data** ACCEPTed this live-MinIO object-restore slice (not full Q03 verified).  
**Commit/push/deploy/Docker:** **not done** / **not claimed**.

## What was accepted

Live `OpeningRestoreObjectPut` via `OpeningS3.putObject` / PutObject against live MinIO (no longer memory-only); `objectApplyDeferred=false` with head+digest proof on a dedicated workspace UUID; full `exportOpeningBackup` → `publishOpeningBackupArchive` → `applyOpeningRestore` on a fresh empty workspace. Secrets/API keys/sessions unrestored; pending `opening_jobs` cancelled in-tx. Dedicated UUID/keys only — no shared DB/bucket wipe.

Implement evidence (do not alter its IMPLEMENT verdict):  
`docs/superpowers/evidence/2026-10-09-opening-release/q03-live-minio-object-restore.md`

## Data re-run gates (PM attestation)

| Gate | Result (per PM / Data) |
|---|---|
| Unit tests (backup-apply / S3 / entrypoint / empty-namespace / domain plan) | **PASS** — **31** unit |
| `OPENING_TEST_DB` integration restore-apply + empty-namespace | **PASS** — **4**/4 |
| `tsc -p packages/domain --noEmit` | **PASS** (exit 0) |
| `tsc -p packages/database --noEmit` | **PASS** (exit 0) |

These gates match the IMPLEMENT evidence command set (unit 31; integration restore-apply + empty-namespace = 4; domain/database tsc). This accept records Data’s re-run attestation; it does **not** re-claim packaging green or full Q03.

## Explicit non-claims

- **Not verified** — do not flip Q03 to `verified`.
- **Slice ACCEPT only** — remaining open for full Q03:
  - Docker / compose (image build, compose up)
  - Full packaging green (lint / monorepo typecheck / production build)
  - CI release-SHA evidence (**no commit**)
  - CLI live `objectPut` wiring
  - Encrypted-archive decrypt→apply path
- No commit, no push, no deploy, no Docker image/compose claims.

## Tasks

`docs/superpowers/plans/opening-release/tasks.json` **Q03** remains **`status: active`**. This accept path is appended under `evidence`. **verified: not set.**
