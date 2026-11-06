# Upload interrupt — same-origin staging PUT (Experience resolve) — implement

**Date:** 2026-10-10 ~21:45 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release`  
**HEAD (at write):** `0489585` (`048958558479f69e089cbd04644cb6fb1775b376`)  
**Authority:** Integrator AGREE + PM P0; Experience scope only (steering: Pipeline owns route)  
**Status:** READY_FOR_ACCEPT  
**Commit/push:** none (do not push)

## Scope (Experience)

| Item | Owner | Done |
|---|---|---|
| `resolveUploadPutUrl` always → `stagingPutUrl(id)` | Experience | yes |
| `api.test.ts` (stubs, `/s3/`, `127.0.0.1:9000`, absolute staging → same-origin path); describe nesting fixed | Experience | yes |
| Optional PUT error detail (HTTP status already on fail; network hint on `onerror`; upload-client appends put error) | Experience | yes |
| `PUT /api/opening/sources/:id/staging` route + `source-service.putStaging` (stream→MinIO) | **Pipeline** | not in this change |
| Commit / push | Integrator after Accept | no |

## Behavior

Browser client **must not** PUT to `http://127.0.0.1:9000` or other MinIO/presign hosts.  
`resolveUploadPutUrl(ticket)` always returns `/api/opening/sources/${ticket.source.id}/staging` regardless of `ticket.uploadUrl` (including `upload.local`, `__SOURCE_ID__`, `https://host/s3/...`, loopback MinIO, and absolute staging URLs).

Server staging write remains Pipeline’s slice (may refine streaming later). Experience only ensures the client targets same-origin staging.

## Files touched

- `apps/web/src/features/opening/client/api.ts`
- `apps/web/src/features/opening/client/api.test.ts`
- `apps/web/src/features/opening/inbox/put-private.ts`
- `apps/web/src/features/opening/inbox/upload-client.ts`
- this evidence note

## Gates

- vitest (repo root): `apps/web/src/features/opening/client/api.test.ts` + `put-private.test.ts` + `upload-client.test.ts` → **3 files, 45 tests passed**
- `cd apps/web && npx tsc -p tsconfig.json --noEmit` → **exit 0**

## Notes

- Pipeline may later stream the staging body to MinIO; Experience arrayBuffer-sized opening uploads remain compatible with same-origin URL.
- No hermes / no product route added here to avoid conflict with Pipeline.

## Cookie / credentials (2026-10-10 ~21:49)
- `resolveUploadPutUrl` returns **relative** `/api/opening/sources/:id/staging` → same-origin; cookies included by default.
- `putPrivateBytes` sets `xhr.withCredentials = true` so absolute same-site staging URLs (if begin returns PUBLIC_BASE_URL) still send cookies.
