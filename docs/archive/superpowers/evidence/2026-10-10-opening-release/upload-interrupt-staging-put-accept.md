# Upload interrupt — same-origin staging PUT — Integrator ACCEPT

**Date:** 2026-10-10 ~21:49 CST (Asia/Shanghai)  
**Reviewer:** INTEGRATOR (ACCEPT)  
**Branch:** `feat/opening-release`  
**HEAD tip:** `0489585` (uncommitted Experience + Pipeline working tree; no commit/push this turn)  
**Sources:**
- Plan: `upload-interrupt-understand-plan.md`
- Integrator AGREE: `upload-interrupt-integrator-review.md` (Accept ONLY app staging PUT; `/s3/` not required)
- Experience: `upload-interrupt-staging-put-implement.md`
- Pipeline: `upload-interrupt-staging-put-pipeline-implement.md`

**Verdict:** **ACCEPT**

## Why ACCEPT

Joint Experience + Pipeline same-origin staging PUT closes the hermes root cause (browser PUT to unreachable `127.0.0.1:9000`). Client always rewrites to `/api/opening/sources/:id/staging`; `beginUpload` issues that same-origin URL; route authenticates, enforces size/mime vs begin, `putObject(stagingKey)`, returns 204. `/s3/` rewrite is explicitly out of Accept scope per AGREE addendum.

## Gates re-run (this ACCEPT turn)

```text
npx vitest run \
  apps/web/src/features/opening/client/api.test.ts \
  apps/web/src/features/opening/inbox/put-private.test.ts \
  apps/web/src/features/opening/inbox/upload-client.test.ts \
  apps/web/src/app/api/opening/sources/[id]/staging/route.test.ts \
  apps/web/src/features/opening/sources/source-service.test.ts
→ Test Files  5 passed (5) | Tests  73 passed (73)

Per-file:
  client/api.test.ts              38
  inbox/put-private.test.ts        1
  inbox/upload-client.test.ts      6
  sources/source-service.test.ts  22
  staging/route.test.ts            6
  Experience slice (api+put+upload): 45
  Pipeline slice (service+route):    28

cd apps/web && npx tsc -p tsconfig.json --noEmit
→ exit 0
```

Live MinIO/Postgres integration suites: **not required** — Pipeline honestly reported updated helpers but not re-run (need `DATABASE_URL` + live MinIO). Accept does not block on that.

## Spot-checks

| Check | Result |
|---|---|
| `resolveUploadPutUrl` ALWAYS → `/api/opening/sources/:id/staging` | **PASS** — `api.ts` returns `stagingPutUrl(ticket.source.id)` unconditionally; tests cover stubs, `/s3/` presign, `127.0.0.1:9000`, absolute staging → same-origin path |
| `beginUpload` returns same-origin staging URL (not `127.0.0.1:9000`) | **PASS** — `stagingUploadUrl` via `PUBLIC_BASE_URL ?? http://127.0.0.1:3000`; no `presignPut` in ticket path |
| PUT route: auth, size/mime vs begin, `putObject(stagingKey)`, 204 | **PASS** — `requireOpeningScope` + `getStagingPutTarget`; Content-Length > bytes → 413; `readOpeningRawBody` hard-cap; mime/bytes exact match in `putStaging`; `storage.putObject(stagingKey, …)`; success 204 |
| `putPrivateBytes` `withCredentials=true` | **PASS** — set for absolute same-origin staging URLs (cookies on absolute ticket URL) |
| No `/s3/` client rewrite required for Accept | **PASS** — AGREE: Accept app staging PUT only; `/s3/` not implemented and not required |

## File lists

### Experience

- `apps/web/src/features/opening/client/api.ts`
- `apps/web/src/features/opening/client/api.test.ts`
- `apps/web/src/features/opening/inbox/put-private.ts`
- `apps/web/src/features/opening/inbox/upload-client.ts`
- evidence: `upload-interrupt-staging-put-implement.md`

### Pipeline

- `apps/web/src/features/opening/sources/source-service.ts`
- `apps/web/src/features/opening/sources/source-service.test.ts`
- `apps/web/src/features/opening/request-body.ts` (`readOpeningRawBody`)
- `apps/web/src/app/api/opening/sources/[id]/staging/route.ts` **(new)**
- `apps/web/src/app/api/opening/sources/[id]/staging/route.test.ts` **(new)**
- `apps/web/src/app/api/opening/imports/email/route.ts` (`putStaging` instead of `fetch(ticket.uploadUrl)`)
- `tests/integration/opening-sources-storage.test.ts`
- `tests/integration/opening-parse-job.test.ts`
- `tests/integration/handler/opening-upload-desktop.test.ts`
- evidence: `upload-interrupt-staging-put-pipeline-implement.md`

## Non-blocking notes (do not reject)

1. P0.1 later: Inbox「重试上传」should resume PUT+complete (called out in AGREE).
2. Integration suites updated but not live-run — PM/hermes can verify on deploy.
3. `/s3/` nginx path remains optional parallel; not part of this Accept.
4. No re-presign `/upload-ticket` API this round.

## Commit / push

**None.** Integrator ACCEPT only; PM owns push/deploy.

## Next

PM push + hermes deploy when ready.
