# ACCEPT：Package A + B client + Package D (Experience)

**Date:** 2026-10-10 ~22:42 CST (Asia/Shanghai)  
**Reviewer:** Integrator (Grok Bot executor)  
**Branch:** `feat/opening-release`  
**Verdict:** **ACCEPT**  
**Claim:** `holistic-pkg-abd-client-implement.md` (READY_FOR_ACCEPT)  
**Server Accept:** `holistic-pkg-ab-server-accept.md` (ACCEPT)  
**Plan AGREE:** `holistic-upload-materials-audit-p0-integrator-review.md`  
**Plan:** `holistic-upload-materials-audit-p0-plan.md` § Package A (client) + B (client) + D

---

## Verdict

**ACCEPT** Experience Packages **A client** (same-origin download / `resolveUploadPutUrl`) + **B client** (refresh ticket → PUT → complete) + **Package D** (upload → course membership / CTA).

No product edits, no commit/push, `tasks.json` untouched by this Accept turn.

---

## Gates (re-run 2026-10-10 ~22:41 CST)

```bash
cd /workspace/study-assistant-opening
(cd apps/web && npx tsc -p tsconfig.json --noEmit)  # exit 0

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

| Gate | Result |
|---|---|
| `apps/web` tsc --noEmit | **Pass** (exit 0) |
| Unit (8 files / 86 tests) | **Pass** |

---

## Spot-checks

### Package A — browser never talks to MinIO (client)

| Check | Result |
|---|---|
| `sourceDownloadHref` → `/api/opening/sources/:id/download?version=` (same-origin) | Pass (`client/api.ts`) |
| Browser `getSourceDownload` JSON path removed | Pass (only `sourceDownloadHref` remains) |
| `SourceViewer` / `buildSourceDownloadView` always same-origin; ignores MinIO `download.url` | Pass (`source-viewer.tsx` lines 33, 59–60) |
| Inbox `openOriginal` uses `buildSourceDownloadView` (no JSON fetch → MinIO open) | Pass (`inbox-panel.tsx`) |
| Inbox `resolvePutUrl: resolveUploadPutUrl` + Strip parity | Pass |
| No `127.0.0.1:9000` / `:9000` in client open-path helpers | Pass (api + source-viewer + inbox-panel tests; production helpers only assert-against in tests) |

### Package B — interrupt recovery (client)

| Check | Result |
|---|---|
| `refreshUploadTicket` → `POST …/upload-ticket` | Pass (`api.ts`) |
| Resume/retry: `refreshTicket` → PUT via `resolvePutUrl` → complete | Pass (`upload-client.ts`; upload-client + upload-queue tests) |
| Never reuse expired `uploadUrl`; never second `begin` on resume | Pass (resume branch only refreshes; `begin` only when no `resumeSourceId`) |
| Pending without local file →「请重新选择文件」; keep delete; **no** complete-only | Pass (`retryPendingSource` + inbox-upload-course / inbox-panel tests) |
| Strip wired with same `refreshTicket` + `resolvePutUrl` | Pass (`upload-strip.tsx`) |

### Package D — upload → course

| Check | Result |
|---|---|
| After `saved` with `courseId` → `addToCourse` once (default `reference`) | Pass (`attachSavedToCourse` in inbox-panel + upload-strip) |
| Without `courseId` → no membership | Pass (guard `if (!courseId) return` + test) |
| Failed upload → no membership | Pass (only `state === "saved"` attached; fail test skips complete) |
| Course CTA「上传并归入本课」→ `/opening/library?tab=materials&courseId=…#upload` | Pass (`course-add-materials` + empty-state in `course-detail`) |
| Library accepts/passes `courseId` → `MaterialLibrary` / `InboxPanel` | Pass (page → library-view → material-library → InboxPanel) |
| No auto-assign last course; no R2 explore/marketplace restore | Pass (opt-in `courseId` only; no explore/marketplace in touched course/library files) |

### Regression / scope

| Check | Result |
|---|---|
| No Experience edits this turn to Pipeline download / upload-ticket / source-service / S3 routes | Pass (those remain prior A+B **server** dirty tree; claim file list is Experience-only) |
| No commit / push / `tasks.json` flips this Accept | Pass (`tasks.json` clean in git status) |
| Package C parse-honesty files not in this Accept scope | Pass (noted dirty; not blocking ABD client) |

---

## Remaining (not blocking this ACCEPT)

1. **Batch commit** of Package C + A/B server + A/B client + D still **pending PM standing auth / push**.
2. Hermes / manual Network check that「查看原件」never hits `:9000` (deploy-time).
3. Optional P1: queue cancel for `uploading`/`idle` (G5); re-bind file picker to existing pending `sourceId`.

---

## ACCEPT

Experience A client + B client + Package D match plan/AGREE/claim, gates green, spot-checks pass. Ready for PM-authorized batch commit with prior C + A/B server when standing auth is granted.
