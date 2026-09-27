# Q03 backup publication implementation plan — 2026-09-25

## Goal

Continue the approved Q03 backup/restore plan after the real-export integration slice. Deliver a consistent historical database capture with matching object bytes, encrypted output, explicit privacy checks at publication, and safe failure outcomes. Never describe PostgreSQL plus the filesystem as a distributed atomic transaction. No production access, commit, push, deployment, paid model or task-status promotion.

## Design decisions

1. Capture the fixed 17 durable tables and privacy metadata in one owner-scoped repeatable-read snapshot (T0). Derive the object inventory from the same source rows; independently verify staged bytes against their version, length and SHA-256. Ordinary concurrent edits do not turn this into a publication-time database snapshot.
2. Generate archive and encrypted output in caller-owned private staging. Only complete ciphertext may appear at the final path. Final-file creation must fail if any destination already exists; do not use a probe followed by an overwriting rename or a copying fallback.
3. Use a short workspace-first transaction at publication to recheck the owner, epoch, full deletion journal and expected source inventory. Existing workspace locks do not cover every application write; no global freeze is claimed. Review privacy writer participation explicitly.
4. Distinguish a complete file becoming visible from an acknowledged publication result. A connection/commit failure near filesystem publication must produce an explicit uncertain outcome. Do not silently overwrite/retry, delete an unproven final file, or authorize off-host copying/restoration from that result. Restore always checks an authoritative current deletion journal separately from archive metadata.
5. File cleanup owns only files/directories created by the call. A cleanup failure after publication must report that the artifact exists. Filesystem capability or cross-volume failures are fail-closed. Windows ACLs are not established by POSIX mode bits and remain an explicit runtime precondition until enforcement is verified.

Alternatives rejected: holding long global table locks during object streaming unnecessarily freezes unrelated users; an unlocked final metadata check leaves a privacy race; probe-then-rename does not provide exclusive publication. A DB outbox/receipt table is not added merely to label filesystem I/O transactional; introduce one only if the detailed protocol requires it and document a migration/rollback.

## Work sequence and ownership

- [x] **A — Exclusive file creation:** worker owns `opening-backup-archive.ts`, `opening-backup-cipher.ts`, a focused publication helper and unit regressions. Deterministic gates plus real files must expose the current race before fixes. Prove destination invisibility until complete, competing-file preservation, cleanup ownership, unsupported-filesystem failure, and published-but-cleanup-failed status. Parent independently verifies.
- [ ] **B — Final protocol specification:** read-only reviewer audits lock participation and data/IO boundaries; parent writes the concrete interfaces and error outcomes in a companion spec before implementing the orchestrator.
- [ ] **C — Database publication fence:** parent owns repository-level snapshot/fence code and guarded SQL concurrency tests. Test deletion winning, publication winning with deletion blocked, owner loss, malformed scope, journal-only drift and connection uncertainty.
- [ ] **D — Capture/encryption orchestration:** own temporary lifecycle, snapshot-derived inventory, archive verification, ciphertext hash/length receipt and narrow error handling. No runtime route or automatic paid work.
- [ ] **E — Real integration and review:** use task-owned PostgreSQL/MinIO; test complete ciphertext and all failure/race outcomes with real IO. Preserve independent current-journal rejection after a later deletion. Agent review does not substitute for parent-run checks.
- [ ] **F — Evidence and cleanup:** focused unit/integration, appropriate broader checks, explicit test types, package types, lint, plan/diff checks, owned-service shutdown and one AST-only Graphify update per completed implementation slice.

## Evidence and remaining scope

Keep RED/GREEN logs under `.local/opening-e2e/evidence/q03-exclusive-*` / `q03-publication-*` and summarize the failure → cause → fix → recheck chain in `docs/superpowers/evidence/2026-09-25-opening-backup-publication/verification.md`.

Restore apply, a new-empty-database/storage recovery drill, CLI wrappers, retention/journal lifecycle, Windows private staging verification and packaging remain required Q03 work after these steps. The previous slice intentionally omitted memories without verifiable provenance; preserving legitimate handwritten memories needs an explicit contract before claiming complete preservation. Do not silently replace any of these requirements with a round-trip or a mock.

## Execution redirect — 2026-09-25

A is complete locally; parent checks and limitations are recorded in ../evidence/2026-09-25-opening-backup-publication/verification.md. B–F remain uncompleted and are transferred to personal-use PU05A0–PU05C after PU00/PU01, per the user's new priority. This is not a Q03 promotion.
