# C02 IMAP code slice evidence

- Implemented the bounded IMAP sync adapter in `apps/worker/src/connectors/imap-sync.ts`.
- Cursor semantics: `nextImapCursor` never decreases `lastUid`; UIDVALIDITY/folder generations remain isolated; cursor advancement is sent to the import commit only after source creation, storage upload, source completion, and import receipt submission.
- Mail parsing: MailParser runs with remote content disabled (`skipImageLinks: true`, `skipHtmlToText: true`); attachment names are basename-only and capped at 180 characters.
- Limits: batch size 100, mail 25 MiB, single attachment 20 MiB, attachment total 25 MiB.
- Added `apps/worker/src/jobs/sync-mail.ts` as the worker-side handler boundary using authorized-host validation, AES-GCM credential decryption, read-only ImapFlow, and existing source/import repositories.
- Added `docs/operations/opening-mail.md` documenting the implementation boundary and explicit non-goals.

## Verification

- `node node_modules/vitest/vitest.mjs run --project unit apps/worker/src/connectors/imap-sync.test.ts` — 3/3 passed.
- `npx tsc -p apps/worker/tsconfig.json --noEmit` — passed.
- `npx eslint apps/worker/src/connectors/imap-sync.ts apps/worker/src/connectors/imap-sync.test.ts apps/worker/src/jobs/sync-mail.ts` — passed.

## Blocked gate

- The required isolated standard IMAP integration suite (`tests/integration/opening-imap-sync.test.ts`) was not run because no isolated IMAP test service is available in this environment.
- Per plan, C02 remains `planned` and CAP01 automatic sync is not complete. School-hosted live acceptance remains a separate gate.
