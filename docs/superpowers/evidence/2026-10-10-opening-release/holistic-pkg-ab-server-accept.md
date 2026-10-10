# ACCEPT：Package A + B server (Pipeline half)

**Date:** 2026-10-10 ~22:36 CST (Asia/Shanghai)  
**Reviewer:** Integrator (Grok Bot executor)  
**Branch:** `feat/opening-release`  
**Verdict:** **ACCEPT**  
**Claim:** `holistic-pkg-ab-server-implement.md` (READY_FOR_ACCEPT)  
**Plan AGREE:** `holistic-upload-materials-audit-p0-integrator-review.md`  
**Plan:** `holistic-upload-materials-audit-p0-plan.md` § Package A + B (server only)

---

## Verdict

**ACCEPT** Package A (download binary stream) + Package B (`POST …/upload-ticket`) **server half**. Experience client wiring (viewer / retry / Package D) remains **pending** and is out of this Accept.

No product edits, no commit/push, `tasks.json` untouched by this Accept turn.

---

## Gates (re-run 2026-10-10 ~22:35 CST)

```bash
cd /workspace/study-assistant-opening
npx vitest run --project unit \
  packages/database/src/storage/opening-s3.test.ts \
  apps/web/src/features/opening/sources/source-service.test.ts \
  'apps/web/src/app/api/opening/sources/[id]/download/route.test.ts' \
  'apps/web/src/app/api/opening/sources/[id]/upload-ticket/route.test.ts' \
  'apps/web/src/app/api/opening/sources/[id]/staging/route.test.ts'
# → Test Files  5 passed (5)
# → Tests       46 passed (46)

(cd packages/database && npx tsc -p tsconfig.json --noEmit)  # exit 0
(cd apps/web && npx tsc -p tsconfig.json --noEmit)            # exit 0
```

| Gate | Result |
|---|---|
| Unit (5 files / 46 tests) | **Pass** |
| `packages/database` tsc --noEmit | **Pass** (exit 0) |
| `apps/web` tsc --noEmit | **Pass** (exit 0) |

---

## Spot-checks

### Package A — download stream

| Check | Result |
|---|---|
| `GET …/download` returns **binary** `Response(download.body)` not JSON+presign | Pass (`download/route.ts`) |
| Headers: `Content-Disposition`, `Cache-Control: private, no-store`, `X-Opening-Source-Version*` | Pass |
| No `127.0.0.1:9000` / `:9000` in headers or body | Pass (route.test) |
| `getDownloadStream` + `getObjectStream` present | Pass |
| `presignGet` retained on `getDownloadUrl` for server/worker | Pass (documented; not browser path) |

### Package B — upload-ticket

| Check | Result |
|---|---|
| Pending → same source id, same-origin `/staging` URL, refreshed `expiresAt` | Pass (service + route tests) |
| Non-pending → **409** CONFLICT | Pass |
| Missing → 404; unauthenticated → 401 | Pass |
| Reuses `issueUploadTicket` (pending-only fence) | Pass (`opening-sources.ts` line ~126) |

### Regression / scope

| Check | Result |
|---|---|
| Staging PUT route tests still green | Pass (included in 46) |
| Experience UI untouched this slice: `source-viewer`, `inbox-panel`, `upload-client`, `upload-queue`, `put-private`, `capture-dialog` | Pass (`git status` clean for those paths) |
| No Package D / `/s3/` nginx / `tasks.json` edits in A+B server files | Pass |
| Staging route itself unmodified | Pass |

**Note:** Workspace also carries Package C dirty files (`upload-state*`, `opening-job-failure*`, `opening-jobs*`) from the prior C wave; those are **not** part of this A+B Accept scope and do not block ACCEPT of the server half.

---

## Follow-up (not blocking this ACCEPT)

1. **Experience** must wire Package A client: prefer `<a href="/api/opening/sources/:id/download?version=">` (cookies); stop treating download as JSON+MinIO URL.
2. **Experience** must wire Package B client: `refreshUploadTicket` → PUT staging → complete; never reuse expired `uploadUrl`; never second `begin`.
3. Package **D** (upload→course) remains pending per PM sequence.
4. Integrator / PM: commit/push only when authorized after Experience halves + remaining Accepts.

---

## ACCEPT

Package A+B **server** contracts and gates are green. Experience client still pending after this ACCEPT.
