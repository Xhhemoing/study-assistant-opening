# C01B — opening imports and revocation closure

## Scope

- Added migration 0045 for durable `opening_import_receipts` and per-container `opening_import_cursors`.
- Added the imports repository with transactional receipt insertion, idempotent replay, connection version protection, and generation-safe cursor updates.
- Extended connection revocation to cancel queued jobs for the revoked connection only; running work remains protected by the existing version check.
- Added integration coverage for receipts, cursors, generation/workspace isolation, revoked/stale/foreign connections, and revocation queue isolation.

## Verification

- `npx tsc -p packages/database/tsconfig.json --noEmit` — PASS
- `npx eslint packages/database/src/schema/opening-imports.ts packages/database/src/repositories/opening-imports.ts packages/database/src/repositories/opening-connections.ts packages/database/src/index.ts tests/integration/opening-imports.test.ts` — PASS
- `node node_modules/vitest/vitest.mjs run --project integration tests/integration/opening-imports.test.ts` — 5/5 PASS
- `node node_modules/vitest/vitest.mjs run --project handler tests/integration/handler/opening-connections.test.ts` — 5/5 PASS
- `git diff --check` — PASS

## Not covered here

- Push and hosted CI were not run (push remains separately authorized).
- Browser acceptance remains the user's responsibility.
- Real IMAP sync/check adapters remain for later C02/C03 slices; current 503 semantics are unchanged.
