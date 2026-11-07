# M01 Memory Lifecycle Verification

Status: verified for the implementation and database-backed behavior in this workspace.

## Implemented

- Candidate, confirmed, temporary, rejected, deleted, and superseded states.
- Owner-checked source-turn admission for proposals, candidate confirmation, and corrected versions.
- Candidate review projection and confirmation/rejection bridge.
- Confirmed and unexpired temporary memory context eligibility; candidates and expired temporary memories are excluded.
- Versioned correction transaction: supersede the old confirmed row and insert a new confirmed row with the next version.
- Correction requires at least one source turn; client-key replay checks the superseded source revision, active corrected row, text, and sources.

## Verification

- Isolated PostgreSQL migration registry reports `0023_opening_memory_privacy_epoch.sql` and `0039_opening_memory_revisions.sql` as `verified`.
- Guarded handler suite: `opening-memory.test.ts` and `opening-memory-candidate.test.ts`, 2 files / 12 tests passed before the final source-text privacy test was added; the combined M01/M02/M03 handler run later passed 4 files / 35 tests, including all final memory handler changes.
- Focused database integration: candidate bridge/replay and tutor provenance are included in the M01/M02 integration run (10 files / 54 tests passed).
- Memory context and owner/source admission integration: 2 files / 11 tests passed, including expiry-boundary and excluded-source cases.
- Focused unit coverage: contracts, domain memory policy, proposal/replacement repositories, candidate service, and worker tutor tests passed; the latest replacement/contracts run passed 2 files / 27 tests.
- Contracts, database, domain, AI, web, and worker typechecks passed. Contracts/database/web were rerun after the final source requirement change.
- Changed-file ESLint and `git diff --check` passed; plan validator reports 43 tasks and an acyclic dependency graph.

## Scope boundary

These checks use the repository-managed isolated PostgreSQL at `127.0.0.1:15432/aistudy_opening_test`; no production database or external model was used. Browser interaction remains user-owned and is not claimed here.
