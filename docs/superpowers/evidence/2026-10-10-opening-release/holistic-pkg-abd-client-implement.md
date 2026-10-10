# IMPLEMENT：Package A + B + D client (Experience)

**Date:** 2026-10-10 ~22:40 CST (Asia/Shanghai)  
**Owner:** Experience (Grok Bot executor)  
**Branch:** `feat/opening-release`  
**Status:** **READY_FOR_ACCEPT** (no commit / no push / `tasks.json` untouched / not marked verified)  
**Plan:** `docs/superpowers/plans/opening-release/holistic-upload-materials-audit-p0-plan.md` § Package A (client) + B (client) + D  
**Auth:** Integrator ACCEPT A+B server (`holistic-pkg-ab-server-accept.md`); PM assigned Experience A client + B client + Package D  
**Server contract:** `holistic-pkg-ab-server-implement.md`

## Scope respected

- **No** commit / push  
- **No** `tasks.json` verified flips  
- **No** Pipeline server/API route edits (`download/route.ts`, `upload-ticket/`, `source-service.ts`, S3 helpers left as prior Pipeline dirty tree)  
- Package C parse-honesty files untouched by this turn  

## Package A — browser never talks to MinIO (client)

| Path | Change |
|---|---|
| `client/api.ts` | Added `sourceDownloadHref`; **removed** browser `getSourceDownload` JSON path; kept `resolveUploadPutUrl` |
| `inbox/source-viewer.tsx` | `<a href>` always built via `sourceDownloadHref(record.id, version)`; ignores MinIO `download.url` if present; `buildSourceDownloadView` helper |
| `inbox/inbox-panel.tsx` | `openOriginal` builds same-origin view (no JSON fetch); `resolvePutUrl: resolveUploadPutUrl` + `refreshTicket` on upload client |
| Tests | `api.test`, `source-viewer.test` assert no `127.0.0.1:9000` / MinIO in open path |

## Package B — interrupt recovery (client)

| Path | Change |
|---|---|
| `client/api.ts` | `refreshUploadTicket(sourceId)` → `POST /api/opening/sources/:id/upload-ticket` |
| `inbox/upload-client.ts` | Resume/retry: `refreshTicket` → PUT via `resolvePutUrl` → complete; never reuse expired `uploadUrl`; never begin a new source row |
| `assistant/upload-strip.tsx` | Same `refreshTicket` + `resolvePutUrl` wiring |
| `inbox/inbox-panel.tsx` | Pending retry: if queue still holds local bytes for `sourceId` → re-PUT path; else notice「请重新选择文件」+ keep delete; **no** complete-only |
| Tests | mock reissue → PUT → complete; pending without local file does not call complete-only |

## Package D — upload → course

| Path | Change |
|---|---|
| `inbox/capture-dialog.tsx` | Optional `courseId` / `courseRole` props (association owned by parent) |
| `inbox/inbox-panel.tsx` | After `saved`, if `courseId` → `createMaterialOrganizationClient().addToCourse` once (default role `reference`) |
| `assistant/upload-strip.tsx` | Same attach-after-saved; assistant passes `learningAttempt?.courseId ?? resume?.courseId` |
| `courses/course-add-materials.tsx` | CTA「上传并归入本课」→ `/opening/library?tab=materials&courseId=…#upload` |
| `courses/course-detail.tsx` | Empty-state CTA same destination |
| `app/(opening)/opening/library/page.tsx` + `library-view.tsx` | Accept/pass `courseId` query |
| `library/material-library.tsx` + `use-material-library.ts` | Read `uploadCourseId`; switch to course space; pass into `InboxPanel` for post-upload attach |
| Rules | Without `courseId`: no membership. Failed upload: no membership. |
| Tests | with/without courseId; failed upload skips membership; CTA href |

## Files touched (Experience this turn)

- `apps/web/src/features/opening/client/api.ts` (+ test)
- `apps/web/src/features/opening/inbox/source-viewer.tsx` (+ test)
- `apps/web/src/features/opening/inbox/inbox-panel.tsx` (+ test)
- `apps/web/src/features/opening/inbox/upload-client.ts` (+ test)
- `apps/web/src/features/opening/inbox/upload-queue.test.ts`
- `apps/web/src/features/opening/inbox/capture-dialog.tsx`
- `apps/web/src/features/opening/inbox/inbox-upload-course.test.ts` (**new**)
- `apps/web/src/features/opening/assistant/upload-strip.tsx`
- `apps/web/src/features/opening/assistant/assistant-view.tsx`
- `apps/web/src/features/opening/library/library-view.tsx`
- `apps/web/src/features/opening/library/material-library.tsx`
- `apps/web/src/features/opening/library/use-material-library.ts`
- `apps/web/src/app/(opening)/opening/library/page.tsx`
- `apps/web/src/features/courses/course-add-materials.tsx` (+ test)
- `apps/web/src/features/courses/course-detail.tsx`

## Commands run

```bash
cd apps/web && npx tsc --noEmit
# exit 0

npx vitest run \
  apps/web/src/features/opening/client/api.test.ts \
  apps/web/src/features/opening/inbox/source-viewer.test.ts \
  apps/web/src/features/opening/inbox/inbox-panel.test.ts \
  apps/web/src/features/opening/inbox/upload-client.test.ts \
  apps/web/src/features/opening/inbox/upload-queue.test.ts \
  apps/web/src/features/opening/inbox/inbox-upload-course.test.ts \
  apps/web/src/features/courses/course-add-materials.test.ts \
  apps/web/src/features/opening/assistant/message-list.test.ts
# → Test Files  8 passed (8)
# → Tests       86 passed (86)
```

## Skipped checks

- Full `apps/web` vitest suite (only related files)
- Hermes / manual browser Network check that「查看原件」never hits `:9000` (needs Accept + deploy)
- Queue cancel for `uploading`/`idle` (G5 P1)
- Re-bind file picker to existing pending `sourceId` from materials UI (optional P0.1 in prior plan)
- No commit, no push, not marked verified / accepted

## Acceptance mapping

| Criterion | Result |
|---|---|
| Same-origin download `<a href>` / no MinIO in browser open path | Pass (viewer + api unit) |
| Inbox `resolveUploadPutUrl` parity with Strip | Pass |
| Retry = refresh ticket → PUT → complete; no expired URL reuse; no second begin | Pass (upload-client + queue) |
| Pending without local file →「请重新选择文件」; no complete-only | Pass |
| Upload with courseId → membership; without → none; failed → none | Pass |
| Course CTA「上传并归入本课」 | Pass |
| No Pipeline route edits this turn; no commit/push/tasks.json | Pass |

## READY_FOR_ACCEPT

Integrator Accept handoff: Experience Packages A client + B client + D green against accepted A+B server contracts. Not verified; not pushed.
