# Upload interrupt — same-origin staging PUT (Pipeline) — implement

**Date:** 2026-10-10 ~21:48 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release`  
**HEAD tip (at write):** `0489585` (uncommitted Pipeline + Experience working tree)  
**Authority:** Integrator AGREE + PM P0; Pipeline owns service + staging route + tests  
**Status:** READY_FOR_ACCEPT  
**Commit/push:** none (do not push)

## Scope (Pipeline)

| Item | Done |
|---|---|
| `createOpeningSourceService.putStaging` + `getStagingPutTarget` | yes |
| `beginUpload` returns same-origin staging URL (not MinIO `presignPut`) | yes |
| `PUT /api/opening/sources/[id]/staging` route (204, cookie auth, size/mime guards) | yes |
| `readOpeningRawBody` hard-cap helper | yes |
| Unit tests (service + route) | yes — 28 pass |
| Integration helpers: stop `fetch(ticket.uploadUrl)` MinIO assumption | yes |
| Email import companion: call `putStaging` (server no longer has usable MinIO ticket URL) | yes |
| `/s3/` public endpoint rewrite | **not** done (fallback; out of scope) |
| Experience client always-rewrite | Experience file — not edited by Pipeline this slice |
| `tasks.json` verified | **not** marked |

## beginUpload URL change

Before: `storage.presignPut(stagingKey, …)` → browser got `http://127.0.0.1:9000/...` (unreachable / CORS).

After:

```ts
new URL(`/api/opening/sources/${id}/staging`, process.env.PUBLIC_BASE_URL ?? "http://127.0.0.1:3000").toString()
```

`expiresAt`: `now + 900s` (UX lease; staging route uses cookie auth, not SigV4 expiry).

## Route contract

- Auth: `requireOpeningScope` → `source.create` / ownership via scope `get`
- `Content-Length` > begin `bytes` → **413**
- Stream body with hard cap = `source.bytes` (`readOpeningRawBody`)
- `Content-Type` base mime must match begin mime (`;params` stripped, lowercased)
- Body length must equal begin `bytes` exactly → else **400** `UploadPolicyError`
- Non-pending / missing / wrong owner → **404**
- Storage failure → **503** (or 404 for storage NOT_FOUND)
- Success → **204**

## Files touched (Pipeline)

- `apps/web/src/features/opening/sources/source-service.ts`
- `apps/web/src/features/opening/sources/source-service.test.ts`
- `apps/web/src/features/opening/request-body.ts` (`readOpeningRawBody`)
- `apps/web/src/app/api/opening/sources/[id]/staging/route.ts` **(new)**
- `apps/web/src/app/api/opening/sources/[id]/staging/route.test.ts` **(new)**
- `apps/web/src/app/api/opening/imports/email/route.ts` (use `putStaging` instead of `fetch(ticket.uploadUrl)`)
- `tests/integration/opening-sources-storage.test.ts` → `svc.putStaging`
- `tests/integration/opening-parse-job.test.ts` → `service.putStaging`
- `tests/integration/handler/opening-upload-desktop.test.ts` → staging route `PUT` with session cookie
- this evidence note (distinct from Experience’s `upload-interrupt-staging-put-implement.md`)

## Gates

```text
npx vitest run apps/web/src/features/opening/sources/source-service.test.ts \
  'apps/web/src/app/api/opening/sources/[id]/staging/route.test.ts'
→ Test Files  2 passed (2) | Tests  28 passed (28)

cd apps/web && npx tsc -p tsconfig.json --noEmit
→ exit 0
```

Guarded MinIO/Postgres integration suites were **updated** for the new ticket URL but **not re-run** in this agent turn (require `DATABASE_URL` + live MinIO). Handler test now exercises staging `PUT` in-process with the session cookie.

## Accept notes / blockers for Experience

1. Experience already owns client always-rewrite to `stagingPutUrl` — Pipeline did not edit `api.ts` / `upload-client.ts` / `put-private.ts`.
2. Browser `putPrivateBytes` must send same-origin cookies (`withCredentials` / default same-origin XHR). Confirm if app is ever served cross-subdomain vs API host.
3. `/s3/` rewrite intentionally **not** implemented this round.
4. No re-presign `/upload-ticket` API this round.
5. Pair Accept with Experience client evidence when both trees are co-reviewed.

## READY_FOR_ACCEPT
