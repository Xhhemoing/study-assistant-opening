# IMPLEMENT：Package A + B server (Pipeline half)

**Date:** 2026-10-10 ~22:35 CST (Asia/Shanghai)  
**Owner:** Pipeline (Grok Bot executor)  
**Branch:** `feat/opening-release`  
**Status:** **READY_FOR_ACCEPT** (no commit / no push / `tasks.json` untouched)  
**Plan:** `docs/superpowers/plans/opening-release/holistic-upload-materials-audit-p0-plan.md` § Package A (download) + Package B (reissue)  
**Auth:** PM order after Package C ACCEPT  
**Scope:** Pipeline server/API only — Experience client UI **not** edited

---

## Scope respected

- **No** commit / push  
- **No** `tasks.json` verified flips  
- **No** Experience UI: `source-viewer`, `inbox-panel`, `upload-client`, `upload-queue`, `put-private`, `capture-dialog`  
- **No** Package D  
- **No** `/s3/` public rewrite  
- Repository: reused existing `issueUploadTicket` (pending-only + refresh `upload_url_expires_at`); no duplicate `reissueUploadTicket` row logic needed

---

## Package A — browser never talks to MinIO (download stream)

| Path | Change |
|---|---|
| `packages/database/src/storage/opening-s3.ts` | `getObjectStream(key)` → `ReadableStream` + contentType/contentLength via GetObject |
| `packages/database/src/storage/opening-s3.test.ts` | stream + NOT_FOUND cases |
| `apps/web/.../sources/source-service.ts` | `getDownloadStream` (auth/ownership/version same as `getDownloadUrl`); `presignGet` kept on `getDownloadUrl` for **server/worker-adjacent** use only |
| `apps/web/.../sources/[id]/download/route.ts` | **Binary** GET: pipes stream with `Content-Disposition` / `Cache-Control: private, no-store`; **not** JSON+absolute MinIO URL |
| `apps/web/.../sources/[id]/download/route.test.ts` | **new** — asserts no `127.0.0.1:9000` / `:9000` in headers/body; status/headers OK |
| `source-service.test.ts` | stream bytes round-trip; no MinIO host in stream metadata |

### Contract change for Experience (wire after Accept)

**Before:** `GET /api/opening/sources/:id/download?version=` → JSON `SourceDownload` `{ url, expiresAt, version, currentVersion, versionMismatch }` where `url` was MinIO `presignGet` (`http://127.0.0.1:9000/...`).

**After (Package A):** same path returns **object bytes** (`200`):

| Header | Meaning |
|---|---|
| `Content-Type` | source mime |
| `Content-Disposition` | `attachment; filename="…"; filename*=UTF-8''…` |
| `Content-Length` | when known |
| `Cache-Control` | `private, no-store` |
| `X-Opening-Source-Version` | cited/requested version |
| `X-Opening-Source-Current-Version` | current source.version |
| `X-Opening-Source-Version-Mismatch` | `1` \| `0` |

**Experience should:**

1. Prefer `<a href="/api/opening/sources/:id/download?version=N">` (same-origin cookies) — **do not** `fetch` JSON then open MinIO `url`.  
2. Stop relying on `getSourceDownload` JSON body for the open-original link (client `api.ts` / `source-viewer` owned by Experience).  
3. Version mismatch UX can use list/`SourceRecord.version` vs requested version, or the `X-Opening-Source-*` headers if using `fetch`.

Worker/Docling continues to call storage `presignGet` on hermes loopback (unchanged).

---

## Package B — reissue upload ticket (API)

| Path | Change |
|---|---|
| `source-service.ts` | `reissueUploadTicket` → `issueUploadTicket` + same-origin staging URL (`PUBLIC_BASE_URL` + `/api/opening/sources/:id/staging`), 900s lease |
| `apps/web/.../sources/[id]/upload-ticket/route.ts` | **new** `POST` + `requireOpeningScope` |
| `apps/web/.../sources/[id]/upload-ticket/route.test.ts` | **new** — pending OK; non-pending 409; missing 404; auth 401 |
| `source-service.test.ts` | same id, refreshed `expiresAt`, staging path; CONFLICT after uploaded; cross-workspace NOT_FOUND |

### API contract Experience will call

```http
POST /api/opening/sources/:id/upload-ticket
Cookie: <session>
```

**200** body = `UploadTicket` (same schema as beginUpload):

```json
{
  "source": { "id": "<same>", "uploadState": "pending", "...": "..." },
  "uploadUrl": "https://<PUBLIC_BASE_URL>/api/opening/sources/<id>/staging",
  "expiresAt": "<ISO8601>"
}
```

| Case | Status |
|---|---|
| pending + owner | **200** — same source id, new lease, same-origin staging URL |
| uploaded / rejected / non-pending | **409** `CONFLICT` |
| missing / other workspace | **404** |
| unauthenticated | **401** |

Client retry path (Experience, not this PR): `refreshUploadTicket(id)` → PUT staging (via `resolveUploadPutUrl` if needed) → `complete`. Never reuse expired `uploadUrl`; never begin a second source row.

---

## Tests

```bash
npx vitest run --project unit \
  packages/database/src/storage/opening-s3.test.ts \
  apps/web/src/features/opening/sources/source-service.test.ts \
  'apps/web/src/app/api/opening/sources/[id]/download/route.test.ts' \
  'apps/web/src/app/api/opening/sources/[id]/upload-ticket/route.test.ts' \
  'apps/web/src/app/api/opening/sources/[id]/staging/route.test.ts'
# → 5 files, 46 tests passed

(cd packages/database && npx tsc -p tsconfig.json --noEmit)  # exit 0
(cd apps/web && npx tsc -p tsconfig.json --noEmit)            # exit 0
```

### Acceptance mapping

| Criterion | Result |
|---|---|
| Download response never embeds `127.0.0.1:9000` / raw S3 host | Pass (route + service unit) |
| Stream / status / disposition headers OK | Pass |
| Reissue pending → new expiresAt, same id, staging path | Pass |
| Reissue non-pending → 409 | Pass |
| Reissue missing → 404 | Pass |
| Experience UI untouched | Pass |
| No commit/push/tasks.json | Pass |

---

## READY_FOR_ACCEPT

Integrator Accept handoff: Package A download proxy + Package B upload-ticket API green; Experience wires viewer/retry against contracts above.
