# Mobile/Desktop Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans; screenshot and functional evidence are separate.

**Goal:** Three simple entry points that expose real state and allow natural phone/desktop use.
**Architecture:** New opening routes and client modules consume server contracts. Existing experimental pages remain outside the opening product. No all-purpose component or browser-side authoritative memory store.
**Tech Stack:** Existing Next.js/React, Tailwind, lucide-react, Vitest and Playwright.

## Global Constraints

Mobile first; no inline style/new CSS. New components ≤200 lines. No raw model HTML; sanitize rendered Markdown and link protocols. Do not display fake progress, fake conversation or invented mastery.

### U01: Opening shell and three real entry points

**Owner:** EXPERIENCE. **Depends:** F01,F02.
**Create:** `apps/web/src/app/(opening)/opening/layout.tsx`, `apps/web/src/app/(opening)/opening/today/page.tsx`, `apps/web/src/app/(opening)/opening/assistant/page.tsx`, `apps/web/src/app/(opening)/opening/courses/page.tsx`, `apps/web/src/app/(opening)/opening/courses/[id]/page.tsx`, `apps/web/src/features/opening/shell/opening-shell.tsx`, `apps/web/src/features/opening/shell/navigation.ts`, `apps/web/src/features/opening/shell/navigation.test.ts`, `apps/web/src/features/opening/shell/empty-state.tsx`, `tests/e2e/opening-shell.spec.ts`.
**Modify:** `apps/web/src/app/page.tsx` and `apps/web/src/middleware.ts` (created by F01), with a bounded opening-mode branch. Do not move all legacy pages.
**Interfaces:** `openingNavigation()` returns exactly today/assistant/courses label+href records; current page gets runtime loading/error/data states, not mock provider.

- [ ] Add failing test:
```ts
import { expect, it } from 'vitest';
import { openingNavigation } from './navigation';
it('does not turn the personal assistant into a tools menu', () => {
  expect(openingNavigation().map(x=>x.href)).toEqual(['/opening/today','/opening/assistant','/opening/courses']);
});
```
- [ ] Run navigation unit red; add Playwright shell test at390x844 and1440x900 before UI implementation.
- [ ] Implement top-level capture button, three mobile navigation items, desktop sidebar; keyboard/focus/aria labels and visible current-course scope. Root redirects to opening today when enabled. Legacy learn/explore/preview routes redirect under opening release so Mock experiences cannot masquerade as official features.
- [ ] Empty account shows explanation and upload/course actions; missing API connection shows error with retry. No onboarding personality quiz. Login gate is server-backed, not just a hidden button.
- [ ] Run unit + browser shell tests: navigation, keyboard, page reload, unauthorized access, narrow-screen overflow and long Spanish/English labels. Capture actual screenshots after rendering; commit without claiming downstream functions already complete.

### U02: Capture, upload progress and source viewer

**Owner:** EXPERIENCE. **Depends:** I01,I02,U01.
**Create:** `apps/web/src/features/opening/inbox/upload-client.ts`, `apps/web/src/features/opening/inbox/upload-state.ts`, `apps/web/src/features/opening/inbox/upload-state.test.ts`, `apps/web/src/features/opening/inbox/capture-dialog.tsx`, `apps/web/src/features/opening/inbox/source-row.tsx`, `apps/web/src/features/opening/inbox/source-viewer.tsx`, `tests/e2e/opening-upload.spec.ts`.
**Interfaces:** `sourceStatusLabel(record:Pick<SourceRecord,'uploadState'|'parseState'>):string`; upload client calls beginUpload -> private PUT -> completeUpload in order; only server completion makes uploaded visible as accepted.

- [ ] Add failing state test:
```ts
import { expect, it } from 'vitest';
import { sourceStatusLabel } from './upload-state';
it('distinguishes stored originals from parsed material', () => {
  expect(sourceStatusLabel({uploadState:'uploaded',parseState:'failed'})).toBe('原件已保存，解析失败');
  expect(sourceStatusLabel({uploadState:'pending',parseState:'not_started'})).toBe('等待上传完成');
});
```
- [ ] Run upload-state unit red and browser upload flow red.
- [ ] File input supports camera or existing file selection; warn about unsupported HEIC/legacy PPT without silently renaming format. Show true bytes-uploaded progress, processing state separately, retry without a second formal source. Browser backgrounding may interrupt upload: explain and preserve original locally, never claim background completion.
- [ ] Original viewer uses authenticated signed reads, page labels, zoom and horizontally scrollable equations. Course inference offers correction; low-confidence归属 enters confirmation inbox. Audio shows permission/privacy notice and storage-only state until transcription enabled.
- [ ] Test interrupted PUT, expired URL, duplicate completion click, image orientation, huge file rejection, parser failure and viewing original despite parse failure. Real phone capture is Q02; browser automation alone does not establish lock-screen behavior.

### U03: Conversation, memory, course evidence and plan confirmation

**Early slice (RU-07):** Basic saved-conversation `composer` / `message-list` / `assistant-view` (plus materials pick + optional current page) may ship before M03/L03/P03 so M1 can collect real Q&A feedback. Do **not** unlock the privacy-gated memory panel in this slice. Final U03 integration gate (memory/plan/learning evidence) still applies; thin UI does not waive Q03→Q01→Q02.

**Owner:** EXPERIENCE. **Depends:** T03,M03,L03,P03,U02.
**Create:** `apps/web/src/features/opening/client/api.ts`, `apps/web/src/features/opening/assistant/assistant-view.tsx`, `apps/web/src/features/opening/assistant/message-list.tsx`, `apps/web/src/features/opening/assistant/composer.tsx`, `apps/web/src/features/opening/assistant/memory-panel.tsx`, `apps/web/src/features/opening/learning/course-view.tsx`, `apps/web/src/features/opening/planning/today-view.tsx`, `apps/web/src/features/opening/planning/plan-diff.tsx`, `apps/web/src/features/opening/planning/plan-action.ts`, `apps/web/src/features/opening/planning/plan-action.test.ts`, `tests/e2e/opening-learning-loop.spec.ts`.
**Interfaces:** typed API wrappers consume interfaces.md routes; `canAcceptPlan({pending:boolean,stale:boolean}):boolean` in new `plan-action.ts`; components receive server DTOs. GET/job polling uses cancellation and refresh after mutation, not permanent client copies.

- [ ] Add failing action test:
```ts
import { expect, it } from 'vitest';
import { canAcceptPlan } from './plan-action';
it('does not resubmit a pending or stale plan', () => {
  expect(canAcceptPlan({pending:true,stale:false})).toBe(false);
  expect(canAcceptPlan({pending:false,stale:true})).toBe(false);
  expect(canAcceptPlan({pending:false,stale:false})).toBe(true);
});
```
- [ ] Run plan-action unit red; add browser tests for persisted conversation reload, memory correction and plan409.
- [ ] Chat attaches source IDs and shows course scope; mode controls hint/explain/listen/think_together; original-photo correction stays one tap away. Saved mode polls server job; no-save mode calls ephemeral endpoint and keeps tab-memory history only. Disable duplicate sends while awaiting acknowledgement but allow cancel.
- [ ] Memory panel shows kind/source/time and confirm/reject/delete; warn about source-text deletion choice. Course view distinguishes self-report, model suggestion and reference-checked evidence. Today shows at most three priorities and an explicit before/after plan diff; accept/reject does not need a free-form explanation.
- [ ] Verify API errors preserve drafts, no raw HTML execution, external links safe, real cross-browser updates, lost-response retry, memory deletion refresh and in-app-vs-push labels. Commit after functional browser evidence; screenshots alone are insufficient.
