# Q03 real backup export integration — 2026-09-25

## Goal and boundaries

Verify the fixed 17-table export against the isolated PostgreSQL database, then exercise the database/object draft with real MinIO and encrypted archive I/O. Keep the existing owner gate, deletion journal, immutable migrations, and no-auth/no-job export boundaries. A successful draft is not publication or restore authorization. No production access, paid models, commit, push, or deployment.

## Implementation steps

- [x] Seed connected rows for all 17 durable tables plus foreign workspace/owner data; assert exact table inventory, meaningful rows, numeric source metadata, locator exclusion, and non-owner rejection.
- [x] Add real SQL regressions for excluded/stale/citation-only source lineage, filtered parent sessions and descendants, deleted/excluded memories, and malformed JSON references. Run before implementation changes; record actual failures.
- [x] Apply only demonstrated query fixes. Keep changed code files at or below 200 lines; retain parameterized SQL and owner-scoped repeatable-read transactions.
- [x] Exercise real DB/MinIO draft composition and archive/encryption round trip; verify bytes/hash, source-change/deletion rejection, and staging cleanup. This is the baseline for a later atomic publication protocol, not that protocol itself.
- [x] Run focused and appropriate broader tests, database/domain and explicit test types, lint, plan integrity, and diff check. Record failure → cause → fix → recheck evidence.
- [x] Stop only task-owned services, update evidence/cursor/operations, run one AST-only Graphify update, and report acceptance limits.

## Files and interfaces

- `tests/integration/opening-backup-records-*.ts`: isolated fixtures and repository regression tests; use `readOpeningBackupRecords(sql, scope)` without faking its SQL.
- `packages/database/src/repositories/opening-backup-record-{table-queries,predicates}.ts`: minimal fixes if proven by those tests.
- `tests/integration/opening-backup-compose-repository.test.ts`: real source inventory/staging and archive round trip, using existing storage fixtures.
- Evidence: `docs/superpowers/evidence/2026-09-25-opening-backup-integration/verification.md`.

## Acceptance

All tests use the guarded loopback `aistudy_opening_test` database and task-owned storage namespace. Acceptance is local regression evidence over the existing dirty worktree, not a release SHA or remote CI. Publication locking, restore apply/drill, Docker/fresh-machine installation and external integrations remain separate work. No migration is planned, so rollback is reverting this focused code slice; do not touch other dirty changes.
