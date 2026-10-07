# C02 manual .eml import route evidence

- Added `POST /api/opening/imports/email` as the manual `.eml` fallback.
- Requires an authenticated session; accepts multipart `file`; enforces `.eml`, strict RFC822 MIME metadata, and the 25 MiB email limit before source creation.
- Reuses the existing immutable source boundary: server-side SHA-256 → beginUpload → staging PUT → completeUpload/parse job.
- Responds with `{ sourceId, name, bytes, manual: true }`; it does not write an `opening_import_receipt`, so it does not claim authorized mailbox synchronization.
- Added a narrowly scoped handler-only source-service test double for storage-independent HTTP boundary validation.

## Verification

- `npx tsc --noEmit --pretty false --project apps/web/tsconfig.json` — passed.
- `npx eslint apps/web/src/app/api/opening/imports/email/route.ts apps/web/src/features/opening/sources/email-import-test-service.ts tests/integration/handler/opening-imports-email.test.ts` — passed.
- `node node_modules/vitest/vitest.mjs run --project handler tests/integration/handler/opening-imports-email.test.ts` — 5/5 passed.

## Limits

- Local MinIO/Docker is unavailable, so success was validated through the controlled source-service double and stubbed staging transport; real MinIO end-to-end remains pending service availability.
- Browser upload/import UX acceptance remains user-owned.

## UI fallback update

- Added `.eml` / `message/rfc822` to the existing upload picker and MIME resolver so manual email imports are selectable in the regular inbox UI.

## Updated verification

- `node node_modules/vitest/vitest.mjs run --project unit apps/web/src/features/opening/inbox` — 11 files / 48 tests passed.
- `npx tsc -p apps/web/tsconfig.json --noEmit` — passed.
- `npx eslint apps/web/src/features/opening/inbox/upload-state.ts apps/web/src/features/opening/inbox/upload-state.test.ts apps/web/src/features/opening/inbox/upload-dropzone.tsx` — passed.
- Guarded handler rerun: `OPENING_TEST_DB=1 OPENING_TEST_DATABASE_URL=postgresql://aistudy:aistudy@127.0.0.1:5433/aistudy_opening_test node node_modules/vitest/vitest.mjs run --project handler tests/integration/handler/opening-imports-email.test.ts` — 5/5 passed.
- Browser acceptance remains user-owned and pending.