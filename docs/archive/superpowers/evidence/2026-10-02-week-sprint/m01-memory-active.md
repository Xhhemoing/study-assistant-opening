# M01 Memory Lifecycle Progress

Status: active, not verified.

## Implemented

- Candidate, confirmed, temporary, rejected, deleted, and superseded memory states.
- Source-turn ownership checks before proposal, candidate confirmation, and corrected replacement.
- Candidate review projection from completed tutor turns.
- Expected-version and client-key idempotency for decisions.
- Expiry and source requirements for model-context eligibility.
- `replaceOwnedMemory` transaction: supersede the active confirmed revision and insert a corrected confirmed revision with the next version.

## Verification run

- Focused unit tests: 6 files / 54 tests passed.
- Typechecks: contracts, database, domain, AI, web, and worker passed.
- Changed TypeScript ESLint: passed.
- Plan structure: passed with 43 tasks and no dependency cycles.

## Remaining gate

`tests/integration/handler/opening-memory.test.ts` and the M01 database-backed flow require the isolated PostgreSQL test database. The current environment has no Docker executable and PostgreSQL/MinIO are not running, so handler verification was not claimed. M01 remains `active`; M02 and M03 remain planned until the dependency gate is verified.
