# C03 DingTalk callback slice evidence

## What changed

- Added `apps/worker/src/connectors/dingtalk-client.ts` with DingTalk callback SHA-1 verification, AES-CBC/PKCS7 decryption, encrypted success acknowledgement, timestamp freshness, and a process-local replay helper.
- Added `apps/worker/src/jobs/sync-dingtalk.ts` and tests. The sync boundary explicitly returns `needs_authorization` without an internal read capability and `unsupported_history_read` even with one, because DingTalk has no historical group-chat read API.
- Added the callback service at `apps/web/src/features/opening/connections/dingtalk-callback-service.ts`:
  - Callback URLs carry no Opening workspace/owner/connection identity.
  - Corpid-to-connection routing is administrator-owned through `OPENING_DINGTALK_CALLBACK_CONNECTIONS`; missing routing fails closed.
  - `allowedScopes` remain database-owned; callback content cannot expand authorization.
  - Duplicate event IDs are resolved against the existing durable import receipt before creating a source.
  - Verified event/attachment bytes are stored through the immutable source boundary and committed as `ImportIdentity`/`ImportReceipt`.
  - Attachment hosts are denied unless `OPENING_DINGTALK_ALLOWED_DOWNLOAD_HOSTS` explicitly allows them.
- Added the POST-only HTTP route at `apps/web/src/app/api/opening/connections/dingtalk/events/route.ts`, wired to the auth runtime database and injected storage upload functions.
- Added `docs/operations/opening-dingtalk.md` with verified documentation URLs, SDK/licence facts, capability limits, callback trust boundaries, and runtime prerequisites.

## Verification

- `node node_modules/vitest/vitest.mjs run --project unit apps/worker/src/jobs/sync-dingtalk.test.ts apps/worker/src/connectors/dingtalk-client.test.ts apps/worker/src/connectors/dingtalk-policy.test.ts` — 3 files / 9 tests passed.
- `npx tsc -p apps/worker/tsconfig.json --noEmit` — passed.
- `npx tsc --noEmit --pretty false --project apps/web/tsconfig.json` — passed.
- `npx eslint apps/web/src/features/opening/connections/dingtalk-callback-service.ts apps/web/src/app/api/opening/connections/dingtalk/events/route.ts apps/worker/src/jobs/sync-dingtalk.ts apps/worker/src/jobs/sync-dingtalk.test.ts apps/worker/src/connectors/dingtalk-client.ts apps/worker/src/connectors/dingtalk-client.test.ts` — passed.
- Existing guarded DB checks were rerun without new failures:
  - integration: `tests/integration/opening-connections.repository.test.ts` — 4/4 passed.
  - handler: `tests/integration/handler/opening-connections.test.ts` — 5/5 passed.
  - integration: `tests/integration/opening-imports.test.ts` — 5/5 passed.

## Independent review

- A GLM5.3 read-only review agent audited callback routing, authorization immutability, idempotency ordering, attachment host allowlisting, route export shape, and storage injection.
- It found the route was still a 503 stub and never invoked the callback service.
- The route was fixed to construct the service with the auth runtime SQL and injected storage, process the verified callback, and return the encrypted acknowledgement.

## Follow-up integration slice

- `/api/opening/connections/[id]/sync` now routes DingTalk through `syncDingTalk`; `needs_authorization` returns 200 without pulling data, while an authorized read capability returns `unsupported_history_read` because DingTalk has no historical group-chat read API. IMAP remains a 503 adapter stub.
- `/api/opening/connections/[id]/check` remains a fail-closed 503 status check.
- Settings now include a minimal DingTalk connections panel listing callback status/scope and exposing the explicit sync boundary. Browser acceptance remains user-owned.

## Blocked gates

- Implemented and passed `tests/integration/opening-dingtalk.test.ts` (9/9); the version-change test exercises mid-request mutation through the injected staging boundary and relies on the durable receipt guard.
- Real enterprise authorization, real DingTalk callback delivery, real attachment samples, rate-limit behaviour, and pagination behaviour remain blocked pending an authorized organization.
- Browser/real-use acceptance remains user-owned.
- C03 therefore remains active; CAP02 is not marked as a completed live integration.
