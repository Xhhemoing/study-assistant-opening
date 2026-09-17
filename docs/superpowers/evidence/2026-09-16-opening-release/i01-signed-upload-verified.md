# I01 signed upload verified — 2026-09-16

Repo: `E:/Project/study-assistant-opening`; branch `feat/opening-release`. LOCAL-ONLY.
Implemented by two `xhh/gpt-5.6-luna-fast` worker runs (`mu492tnj-310dd074` core, `mu49erjn-5a1eb277` magic/sniffing + unit rewrite); integration gate + completion pass finished by lead after a third delegation attempt returned no result. Infrastructure provisioned by lead (INTEGRATOR): portable MinIO `RELEASE.2025-04-22T22-12-26Z` (exact compose-pinned version) into gitignored `.local/minio.exe` with bucket `aistudy`, portable Redis 8.10.1 into `.local/redis8/` (I03 prep), deps pinned at `c5a0012`.

## Delivered

- `packages/database/src/storage/opening-s3.ts`: OpeningS3 wrapper (presign PUT/GET, HEAD, bounded streaming digest with first-16-byte capture, CopyObject with `CopySourceIfMatch` ETag precondition, delete) + typed `OpeningStorageError` (NOT_FOUND/CONFLICT/UNAVAILABLE). `storage/magic.ts`: magic-byte signatures for the full MIME whitelist (pptx = PK zip signature, necessary-not-sufficient; real content validation is I02's job). Unit-tested with injected clients, no network.
- `apps/web/src/features/opening/sources/source-service.ts`: beginUpload → presigned PUT ticket (15 min) to staging key; completeUpload → idempotent (uploaded → return unchanged), HEAD, bounded digest (bytes capped at declared+1, server-computed sha256 — client value never trusted), magic/MIME enforcement before any DB write, `validateStoredUpload`, copy staging→final under ETag precondition, then `completeWithParseJob` transaction, then staging delete (own unreferenced object). getDownloadUrl → presigned GET with `attachment` disposition + `private, no-store`.
- `repositories/opening-sources.ts`: `completeWithParseJob` — `SELECT ... FOR UPDATE` → uploaded early-return (replay-safe, no second outbox row) → in-tx `assertMatch` → CAS `UPDATE ... WHERE upload_state='pending'` → opening_jobs + opening_outbox inserts in ONE transaction (columns match 0018).
- Routes: sources beginUpload (presigned URL, stagingAbsoluteUrl removed), `[id]/complete` replay-safe, `[id]/download` (NEW, per interfaces.md readSource), `[id]/staging` local-staging route DELETED. `packages/database/src/index.ts` normalized to `export *` barrels (module set diffed against HEAD: identical + the two new storage modules; full handler suite re-run to prove no consumer breakage).

## Lead corrections to worker output (evidence chain)

1. Worker run 1 gutted `packages/database/src/index.ts` explicit named exports; verified module-set equivalence via diff of `from "./..."` targets before accepting (no renames existed; consumers re-proven by handler 44/44).
2. Unit suite was left failing (2 tests referencing removed `clearOpeningSourceStagingForTests`) and integration gate was punted twice; rewritten by lead: fake-sql/fake-storage service tests (10 intents incl. spoof/sha/bytes rejection BEFORE any DB write, replay idempotency, download signing) and the real-storage integration gate.
3. `streamDigest.firstBytes` was an empty stub in run 1; implemented in run 2 and lead-verified against real JPEG-vs-PDF spoof bytes.

## Gates (exact output)

```text
$ node node_modules/vitest/vitest.mjs run --project unit
Test Files 137 passed (137)   Tests 669 passed (669)
$ OPENING_TEST_DB=1 OPENING_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/aistudy_opening_test \
  node node_modules/vitest/vitest.mjs run --project integration tests/integration/opening-sources-storage.test.ts
Test Files  1 passed (1)   Tests  9 passed (9)
  (real MinIO 9000 + portable PG 5433; includes ORIGINAL-BYTES ROUND-TRIP acceptance gate)
$ ... same env ... vitest run --project integration tests/integration/opening-foundation.test.ts tests/integration/opening-budget.test.ts
Test Files  2 passed (2)   Tests  10 passed (10)
$ OPENING_TEST_DB=1 OPENING_TEST_DATABASE_URL=... node node_modules/vitest/vitest.mjs run --project handler
Test Files  13 passed (13)   Tests  44 passed (44)
$ npm run typecheck -w @aistudy/database && npx tsc -p apps/web/tsconfig.json --noEmit → clean
$ npx eslint packages/database/src/storage packages/database/src/repositories/opening-sources.ts packages/database/src/index.ts apps/web/src/features/opening/sources apps/web/src/app/api/opening/sources tests/integration/opening-sources-storage.test.ts → exit 0
```

Integration coverage: happy path (PUT→complete→uploaded+parse job/outbox→download round-trip), duplicate completion (1 outbox row), cross-workspace NOT_FOUND, missing object, MIME spoof (source stays pending, 0 jobs), sha mismatch, bytes mismatch, re-PUT changed object under same ticket, download of pending source.

## Deferred (recorded, non-blocking)

- Bucket lifecycle policy for orphan staging objects is infra-level (MinIO lifecycle rule in deployment config); completion-path cleanup + audit are implemented. Candidate for Q03 ops checklist.
- `completeUpload` on a `rejected`-state source: repository CAS leaves it unchanged (tx rollback via empty UPDATE) but the error surfaced is a TypeError from empty RETURNING, not a clean CONFLICT — harmless today (nothing sets rejected yet), tighten when rejection flow lands.
- HTTP-route-level e2e for download/complete still needs a running web app (service-level gate passed; handler suite covers routes in-process). Q02 full-gate item.
