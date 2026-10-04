# Opening 上传工作流 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 统一 Opening 的文件上传交互，支持拖拽、多文件队列、失败恢复和隐私 epoch 正确传递。

**Architecture:** 保留现有 `createUploadClient` 作为单文件协议层，新增队列状态层和可复用 Dropzone UI。Today 与 Assistant 只负责提供 API 和刷新回调。解析重试在 source service 复用 workspace privacy epoch 与 parse job 仓储。

**Tech Stack:** React 19, TypeScript, Tailwind utilities, Zod contracts, Vitest, Next.js route handlers, postgres repositories.

## Global Constraints

- UI 只使用 Tailwind 工具类和 lucide-react 图标。
- 不修改用户已有未提交代码范围之外的模块。
- 浏览器验收由用户负责，Agent 只运行非浏览器检查。
- 上传状态必须区分对象上传进度与服务端解析状态。
- 客户端校验不能替代服务端 MIME、大小、magic bytes 校验。

---

### Task 1: 统一上传 MIME 与队列状态

**Files:**
- Modify: `apps/web/src/features/opening/inbox/upload-state.ts`
- Modify: `apps/web/src/features/opening/inbox/upload-client.ts`
- Create: `apps/web/src/features/opening/inbox/upload-queue.ts`
- Test: `apps/web/src/features/opening/inbox/upload-state.test.ts`
- Test: `apps/web/src/features/opening/inbox/upload-queue.test.ts`

**Interfaces:**
- `resolveUploadMime({ name, type })` returns the same supported MIME union for documents, images, and audio.
- `createUploadQueue(client, files)` exposes queue items with `idle | uploading | saved | failed` and processes each file independently.

- [ ] **Step 1: Write failing tests** for audio MIME resolution and queue continuation after one file fails.
- [ ] **Step 2: Run `npx vitest run --project unit apps/web/src/features/opening/inbox/upload-state.test.ts apps/web/src/features/opening/inbox/upload-queue.test.ts` and verify the new assertions fail.
- [ ] **Step 3: Add audio MIME/extension mappings and implement the smallest queue state machine using the existing `createUploadClient`.
- [ ] **Step 4: Re-run the two tests and verify they pass.
- [ ] **Step 5: Run ESLint on the changed files.**

### Task 2: Build the shared drag-and-drop surface

**Files:**
- Create: `apps/web/src/features/opening/inbox/upload-dropzone.tsx`
- Modify: `apps/web/src/features/opening/inbox/capture-dialog.tsx`
- Modify: `apps/web/src/features/opening/assistant/upload-strip.tsx`
- Modify: `apps/web/src/features/opening/inbox/inbox-panel.tsx`
- Test: `apps/web/src/features/opening/inbox/upload-dropzone.test.tsx`

**Interfaces:**
- `UploadDropzone` accepts `disabled`, `multiple`, `accept`, `onFiles`, and renders a keyboard-accessible drop target.
- `InboxPanel` and `UploadStrip` pass files to the same queue and render per-file status.

- [ ] **Step 1: Write failing render tests for drag hint, keyboard trigger, multiple files, and unsupported-file message.
- [ ] **Step 2: Run the focused test and verify it fails because the component does not exist.
- [ ] **Step 3: Implement `UploadDropzone` with `onDragEnter/onDragOver/onDragLeave/onDrop`, a hidden input, and visible status text. Keep all layout in Tailwind classes.
- [ ] **Step 4: Replace duplicated file input markup in both entry points and render queue progress without blocking existing materials.
- [ ] **Step 5: Run focused component tests and ESLint.

### Task 3: Add parse retry and repair privacy epoch capture

**Files:**
- Modify: `apps/web/src/features/opening/sources/source-service.ts`
- Modify: `packages/database/src/repositories/opening-sources.ts`
- Modify: `packages/database/src/repositories/opening-jobs.ts`
- Modify: `apps/worker/src/runtime/run-job.ts`
- Create: `apps/web/src/app/api/opening/sources/[id]/retry/route.ts`
- Modify: `apps/web/src/features/opening/client/api.ts`
- Modify: `apps/web/src/features/opening/inbox/source-row.tsx`
- Modify: `apps/web/src/features/opening/inbox/inbox-panel.tsx`
- Test: `apps/web/src/features/opening/sources/source-service.test.ts`
- Test: `packages/database/src/repositories/opening-sources.test.ts`
- Test: `apps/worker/src/runtime/run-job.test.ts`

**Interfaces:**
- `retryParse(sourceId)` creates one parse job for an uploaded source and returns the source record.
- Parse job creation receives `workspacePrivacyEpoch(scope.workspaceId)` and never hardcodes `0`.
- Worker failure handling marks stale jobs as failed/excluded without leaving source parse state indefinitely pending.

- [ ] **Step 1: Write failing tests for retrying a failed source and creating a job with the current workspace epoch.
- [ ] **Step 2: Run the focused tests and verify the failures reproduce the current hardcoded epoch/no-retry behavior.
- [ ] **Step 3: Implement repository/service/API retry path and workspace epoch lookup.
- [ ] **Step 4: Wire `SourceRow` and `InboxPanel` to the retry API for `parseState=failed`.
- [ ] **Step 5: Run focused tests, direct worker/web `tsc --noEmit`, and ESLint.

### Task 4: Keep Opening navigation inside Opening

**Files:**
- Modify: `apps/web/src/features/opening/shell/navigation.ts`
- Modify: `apps/web/src/middleware.ts`
- Modify: `apps/web/src/features/courses/course-list.tsx`
- Modify: `apps/web/src/features/courses/course-create.tsx`
- Modify: `apps/web/src/features/courses/course-detail.tsx`
- Modify: `apps/web/src/features/opening/assistant/assistant-view.tsx`
- Modify: `apps/web/src/features/opening/design/ui.tsx`
- Test: `apps/web/src/features/opening/shell/navigation.test.ts`
- Test: `apps/web/src/features/courses/course-list.test.tsx`

**Interfaces:**
- Opening navigation exposes `/opening/today`, `/opening/assistant`, `/opening/courses`.
- Course create/detail links preserve an `opening` origin and remain under `/opening/courses`.

- [ ] **Step 1: Write failing navigation tests for exactly three Opening entries and nested legacy redirects.
- [ ] **Step 2: Run the focused tests and verify current six-entry/nested-route behavior fails.
- [ ] **Step 3: Update link builders and route redirects while preserving legacy routes for non-Opening callers.
- [ ] **Step 4: Replace Assistant material-management link with `/opening/library` and keep the current conversation state intact.
- [ ] **Step 5: Run targeted unit tests and direct web typecheck.

### Task 5: Final verification

**Files:**
- No production files unless a verification failure requires a targeted fix.

- [ ] **Step 1: Run `npx vitest run --project unit` and record any pre-existing failure separately.**
- [ ] **Step 2: Run `npx eslint` on all changed TypeScript/TSX files.**
- [ ] **Step 3: Run `npx tsc -p apps/web/tsconfig.json --noEmit` and `npx tsc -p apps/worker/tsconfig.json --noEmit`.**
- [ ] **Step 4: Run `git diff --check`.**
- [ ] **Step 5: Provide manual browser acceptance steps for drag/drop, multi-file queue, parse retry, audio, and Opening navigation.**

