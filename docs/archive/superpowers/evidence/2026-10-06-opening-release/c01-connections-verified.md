# C01 — authorized connections slice verified

## Scope

- Consent/metadata routes, strict input validation, host allowlist, secret handling, and AES-GCM credential vault.
- Import receipts/cursors transaction and mailbox generation isolation.
- Check/sync fail-closed 503 semantics until real adapters exist.
- Revocation removes credentials, bumps version, and cancels only queued jobs for the revoked connection; running imports remain protected by version write-back checks.
- Race and isolation tests already cover credential/revocation serialization, foreign workspace rejection, secret exclusion, and mailbox generations.

## Verification

- `node node_modules/vitest/vitest.mjs run --project unit apps/worker/src/connectors/import-identity.test.ts` — 1/1 PASS
- `node node_modules/vitest/vitest.mjs run --project integration tests/integration/opening-connections.repository.test.ts` — 4/4 PASS
- `node node_modules/vitest/vitest.mjs run --project handler tests/integration/handler/opening-connections.test.ts` — 5/5 PASS
- `node node_modules/vitest/vitest.mjs run --project integration tests/integration/opening-imports.test.ts` — 5/5 PASS
- `node node_modules/vitest/vitest.mjs run --project integration tests/integration/migration-order.test.ts` — 6/6 PASS
- Database typecheck, targeted ESLint, and `git diff --check` — PASS

## Not covered here

- Push and hosted CI were not run (push remains separately authorized).
- Browser acceptance remains the user's responsibility.
- Real IMAP/DingTalk adapters remain C02/C03; check/sync intentionally fail closed with 503 until their slices complete.
