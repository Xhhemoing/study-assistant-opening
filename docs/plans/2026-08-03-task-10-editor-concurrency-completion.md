# Task 10 Editor Concurrency Completion Plan

**Status:** Implemented and main-model reviewed. No commit is authorized; PostgreSQL-backed integration, handler, and browser gates remain environment-blocked.

**Goal:** Complete the remaining Task 10 persistence invariant by preventing an older browser draft from silently creating a revision over a newer server revision.

**Why this slice is next:** The repository already has the Task 10 editor surface, append-only revisions, workspace-scoped document routes, local recovery drafts, and history restore. The remaining explicit Task 10 requirement is optimistic revision/base-version handling with a recognizable conflict result. Task 11/12 UI work is present but their planned domain/repository boundaries are incomplete; Task 13 must not begin before the document write boundary is reliable.

**Scope:** Update an existing document only when the request's expected revision equals the document's current revision. A mismatch returns the existing `CONFLICT` API code with no projection or historical revision mutation. The editor retains the current local draft, reports the conflict, and lets the user reload the latest server document deliberately.

**Out of scope:** Collaborative editing, automatic merge, operational transforms, CRDTs, new backend routes, changing revision-history semantics, or modifying the already-dirty frontend-hardening files.

## Current Evidence

- `packages/database/src/repositories/library.ts` serializes updates with `FOR UPDATE` and appends revisions, but accepts no expected revision number.
- `apps/web/src/features/auth/service.ts` and `apps/web/src/app/api/documents/[id]/route.ts` pass arbitrary PATCH bodies through without a revision precondition.
- `apps/web/src/features/editor/editor-api.ts` and `document-editor.tsx` save title and blocks but do not carry `currentRevisionNumber`.
- Integration coverage already proves append-only revisions and workspace isolation; targeted tests will extend it with stale-write behavior.

## Implementation Tasks

### 1. Establish the red tests

Add narrowly scoped tests before production changes:

1. In `tests/integration/library-repository.test.ts`, create a document at revision 1, save it at expected revision 1, then attempt another save with expected revision 1. Assert `LibraryError.code === "CONFLICT"`, current document remains revision 2 with the first save's content, and revision history remains `[1, 2]`.
2. In `tests/integration/handler/auth.test.ts`, authenticate a user, create a document, PATCH it once with `expectedRevisionNumber: 1`, then PATCH it again with 1. Assert HTTP 409 and `{ error: { code: "CONFLICT" } }`; confirm its history contains no extra revision.
3. In `apps/web/src/features/editor/editor-api.test.ts`, assert `saveDocument` serializes `expectedRevisionNumber` with the patch body and that a 409 keeps structured `EditorApiError` data.
4. Add a pure editor model test only if extraction makes the conflict-state transition independently testable. Do not add a renderer-only test for behavior that cannot run in the current static-render test environment.

Run the narrow tests first and confirm the stale-write assertions fail because the precondition is absent.

### 2. Enforce the server precondition

Modify only these persistence/write-boundary layers:

1. `packages/database/src/repositories/library.ts`: add a required `expectedRevisionNumber: number` to `LibraryRepository.updateDocument`. Validate that it is a positive integer. In the existing transaction, after loading and locking the document, compare it to `current_revision_number`. Throw `LibraryError("CONFLICT", ...)` before any update, block replacement, or revision insert when they differ.
2. `apps/web/src/features/auth/service.ts`: require and forward `expectedRevisionNumber` in `updateDocumentForPrincipal` while preserving the existing ownership probe and route authorization.
3. All server-side callers/tests of `updateDocument` must provide the revision that they just read or received from the previous mutation. Creation remains revision 1 and needs no precondition.

### 3. Carry the revision through the client editor

1. `apps/web/src/features/editor/editor-api.ts`: add `expectedRevisionNumber` to `UpdateDocumentInput` and serialize it in `saveDocument`.
2. `apps/web/src/features/editor/document-editor.tsx`: use `document.currentRevisionNumber` for normal saves and restores. On a `CONFLICT` response, retain the existing local draft and BlockNote document, show explicit non-color conflict text, and expose a visible `RefreshCw` reload command. Reload must discard only after the user chooses it and must reset to the latest server document/local-draft comparison already used by the initial loader.
3. Preserve current error handling for other failures. Do not automatically retry or overwrite a newer version.

### 4. Verify and review

Run:

```bash
npx vitest run --project integration tests/integration/library-repository.test.ts tests/integration/handler/auth.test.ts
npx vitest run --project unit apps/web/src/features/editor/editor-api.test.ts apps/web/src/features/editor/document-editor.test.ts
npm run lint
npm run typecheck
```

Then inspect the diff for these acceptance criteria:

- Stale writes return `CONFLICT`/409.
- A rejected stale write does not alter current blocks, title, timestamp, or revision list.
- Normal saves and restores use the latest known revision.
- A conflict preserves unsaved local work and offers user-directed reload.
- Principal-bound workspace authorization remains the only source of workspace scope.
- No existing dirty frontend-hardening files are reverted or modified.

## Implementation Record

**Implemented with:** project `worker` subagent configured as `tokenfree-gpt/gpt-5.6-luna`.

**Changes completed:**

- `LibraryRepository.updateDocument` now requires a positive `expectedRevisionNumber`, compares it after `FOR UPDATE`, and raises `CONFLICT` before document projection or revision history writes on a stale save.
- Principal-bound PATCH handling forwards that revision; existing `mapDomainError` maps the repository conflict to HTTP 409.
- The editor sends its known revision for saves and restores. A 409 preserves the local draft, reports an explicit conflict state, and offers user-triggered reload of the latest server version.
- Repository, handler, API-client, and course-asset update call sites have regression coverage or explicit current revision arguments.

**Main-model verification performed:**

- `npx vitest run --project unit apps/web/src/features/editor/editor-api.test.ts apps/web/src/features/editor/document-editor.test.ts` passed: 2 files, 7 tests.
- Targeted ESLint passed for every changed implementation and test file.
- `npx tsc -p packages/database/tsconfig.json --noEmit` and `npx tsc -p apps/web/tsconfig.json --noEmit` passed.
- `git diff --check` passed; all `updateDocument` call sites were inspected and supply the required revision.
- Graphify was updated once for this coherent slice; generated output remains ignored by Git.

**Blocked verification:**

- Targeted integration and handler suites require `DATABASE_URL` and PostgreSQL. `DATABASE_URL` is unset, and Docker is unavailable in this environment, so the stale-write repository and HTTP 409 tests have not executed here.
- `npm run lint` and `npm run typecheck` use `scripts/run-heavy.sh`, which requires `flock`; `flock` is unavailable. Direct ESLint and TypeScript checks above are the available substitutes, not replacements for those aggregate gates.

## Follow-On Order

Provision PostgreSQL and the documented command prerequisites, then execute the blocked Task 10 integration, handler, and browser gates before declaring Task 10 fully verified. After that, plan Task 11's typed relation/domain boundary. Do not mark the whole Phase 1 complete: the implementation plan still requires Tasks 11-30 and their validation gates.
