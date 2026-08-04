# Task 11B1 Server-Backed Document Tags Implementation Plan

> **For agentic workers:** Implement through the project `worker` configured as `tokenfree-gpt/gpt-5.6-luna`. Work test-first. Do not commit or alter unrelated dirty files.

**Status:** Implemented and main-model reviewed. No commit is authorized; PostgreSQL-backed handler/integration/browser and aggregate gates remain environment-blocked.

**Goal:** Replace the editor's mock-only document tags with a real, workspace-authorized property API backed by the existing `library_properties` table.

**Architecture:** Tags are a constrained view over one canonical document property: `subjectType: "document"`, `key: "tags"`, `valueType: "json"`, and a normalized `string[]` value. The service validates/normalizes this one property shape, derives workspace exclusively from the authenticated principal, and exposes GET/PUT `/api/documents/:id/tags`. The browser client and existing `PropertiesPanel` use that endpoint; the mock provider remains intact for unrelated mock learning data but no longer owns server document tags.

**Tech Stack:** TypeScript, Zod, Next.js App Router, existing `LibraryRepository.setProperty/listProperties`, React, Tailwind utilities, lucide-react, Vitest, Playwright.

## Why This Is The Next Slice

Task 11A established real document/block relation reads and editor backlinks. `library_properties` already persists typed document/block properties and enforces workspace ownership, but `PropertiesPanel` still reads/writes `StudyDataProvider` localStorage tags. Migrating tags first creates a verified server persistence boundary without prematurely shipping an arbitrary property editor or a second relation-writing interaction.

## Scope And Constraints

- Preserve all existing uncommitted work; do not reset, checkout, clean, stash, revert, amend, or commit.
- Do not modify Task 10 revision concurrency or Task 11A links behavior.
- Use the existing property table and repository; do not add a tag table, migration, global store, or backend dependency.
- Tags apply only to live documents in the current principal workspace. Request workspace IDs are ignored.
- Normalize every tag as `NFKC`, trim, and collapse internal Unicode whitespace to one ASCII space. Deduplicate case-insensitively using locale-insensitive lowercasing while preserving first normalized spelling.
- Limit to 32 tags, each 1-80 characters after normalization. Empty strings are rejected rather than silently retained.
- `PUT { tags: [] }` is a valid way to clear tags; it persists the canonical empty array and returns it.
- Existing non-tag document/block properties remain untouched and are not exposed in this slice.
- New UI must use Tailwind utilities and lucide icons only. Preserve semantic loading/error/retry states; use no inline styles or global CSS.

## File Map

- Create: `packages/contracts/src/tags.ts` - tag normalization-compatible input/response schemas and types.
- Modify: `packages/contracts/src/index.ts` - exports.
- Modify: `apps/web/src/features/auth/service.ts` - principal-bound `getDocumentTagsForPrincipal` and `setDocumentTagsForPrincipal` helpers.
- Create: `apps/web/src/app/api/documents/[id]/tags/route.ts` - authenticated GET/PUT handlers.
- Create: `apps/web/src/features/editor/document-tags-api.ts` - typed browser client and structured errors.
- Create: `apps/web/src/features/editor/document-tags-api.test.ts` - encoding, request/response parsing, error tests.
- Modify: `apps/web/src/features/editor/properties-panel.tsx` - replace provider calls with server API; retain add/remove UX and add pending-control protection.
- Modify: `apps/web/src/features/editor/document-editor.tsx` - remove `StudyDataProvider` dependency from PropertiesPanel only; BacklinksPanel remains API-backed.
- Modify: `apps/web/src/features/editor/document-editor.test.ts` - static UI recovery/accessibility assertions only if the current test convention supports them.
- Modify: `tests/integration/handler/auth.test.ts` - auth/workspace/normalization/clear behavior.
- Modify: `tests/integration/library-repository.test.ts` only if a concrete missing repository invariant appears.
- Create: `tests/e2e/document-tags.spec.ts` - create note, add normalized/deduplicated tags, reload, remove/clear, and verify persisted state.

## Task 1: Contracts And RED Tests

Create `tags.ts` with the following public behavior:

```ts
export const documentTagSchema = z.string().min(1).max(80);
export const documentTagsSchema = z.array(documentTagSchema).max(32);
export const documentTagsResponseSchema = z.object({ tags: documentTagsSchema });
export const documentTagsUpdateSchema = documentTagsResponseSchema;
```

Normalization is intentionally implemented in a pure exported helper, not a Zod transform hidden in a route:

```ts
export function normalizeDocumentTags(tags: string[]): string[];
```

Tests must prove NFKC normalization, trim/whitespace collapse, stable first spelling, case-insensitive dedupe, max count/length rejection, and empty-list acceptance. Run unit test RED before implementation.

## Task 2: Principal-Bound Tags API

Add service helpers:

```ts
getDocumentTagsForPrincipal(runtime, principal, documentId): Promise<string[]>;
setDocumentTagsForPrincipal(runtime, principal, documentId, body: unknown): Promise<string[]>;
```

Implementation requirements:

1. Both helpers call existing `getDocumentForPrincipal` before property access, retaining current 403 versus 404 behavior.
2. GET reads `library.listProperties({ workspaceId, subjectType: "document", subjectId })`, finds key `tags`, and returns `[]` when absent. If a pre-existing tags property has unexpected type/value, return a stable `VALIDATION` error rather than coercing arbitrary JSON.
3. PUT parses the typed request, normalizes via the pure helper, validates after normalization, and calls `library.setProperty` with `key: "tags"`, `valueType: "json"`, and normalized values.
4. The return shape is always `{ tags: string[] }`. Never read a workspace ID from the body.
5. GET and PUT route handlers use existing `requirePrincipal`, `jsonError`, and `mapDomainError`.

Before implementation, add handler tests for unauthenticated access, no property returns empty list, normalized/deduplicated save, empty-array clear, attacker workspace ID ignored, and user B denied reading/updating user A's tags. Run RED if PostgreSQL exists; otherwise record the exact environment prerequisite.

## Task 3: Editor Client And Panel

Implement:

```ts
type DocumentTagsApi = {
  get(documentId: string): Promise<string[]>;
  set(documentId: string, tags: string[]): Promise<string[]>;
};
```

Use encoded document IDs, JSON headers for PUT, the contracts for response validation, and a `DocumentTagsApiError` preserving API `code`, `status`, and message.

Update `PropertiesPanel`:

- Its only prop becomes `{ documentId: string }`.
- Load tags from a memoized API client, clear stale tags on document/retry change, and ignore late requests after unmount.
- Preserve visible loading, empty state, `role=alert` error, `RefreshCw` retry, form semantics, remove-button labels, and current Chinese copy.
- Disable add/remove controls while a write is pending. Clear prior errors before a new write. On write failure retain the last confirmed tag list and typed input so the user can retry or edit it.
- Let API normalization be authoritative; apply returned values to state.

Update `DocumentEditor` so `PropertiesPanel` no longer receives `provider`. Keep `useStudyProvider` only if it is still needed by an unrelated component; remove it if no longer used.

Add client tests RED for URL encoding, PUT body, response parsing, and structured 403/validation errors. Add static rendering checks for loading/retry/pending semantics where useful.

## Task 4: Browser And Verification

Create browser flow using the existing auth registration pattern:

1. Create a server document.
2. Open it, add `"  ＴＯＰＩＣ  "` then `"topic"`.
3. Verify one tag is shown as `TOPIC`.
4. Reload and verify persistence.
5. Remove it and verify the empty state after reload.

Run:

```bash
npx vitest run --project unit packages/contracts/src/tags.test.ts apps/web/src/features/editor/document-tags-api.test.ts apps/web/src/features/editor/document-editor.test.ts
npx eslint packages/contracts/src/tags.ts packages/contracts/src/tags.test.ts packages/contracts/src/index.ts apps/web/src/features/auth/service.ts apps/web/src/app/api/documents/[id]/tags/route.ts apps/web/src/features/editor/document-tags-api.ts apps/web/src/features/editor/document-tags-api.test.ts apps/web/src/features/editor/properties-panel.tsx apps/web/src/features/editor/document-editor.tsx tests/integration/handler/auth.test.ts tests/e2e/document-tags.spec.ts
npx tsc -p packages/contracts/tsconfig.json --noEmit
npx tsc -p apps/web/tsconfig.json --noEmit
npx tsc -p tsconfig.e2e.json --noEmit
```

When PostgreSQL/Docker and `flock` are available, also run:

```bash
npm run test:handler -- auth
npm run test:integration -- library-repository
npm run test:browser -- document-tags
npm run lint
npm run typecheck
npm run build
```

## Acceptance Criteria

- The editor no longer uses mock provider APIs for document tags.
- Tags persist through real workspace-scoped `library_properties` and survive reloads.
- Unicode/case normalization and deduplication have deterministic, tested behavior.
- Clearing tags is persisted and returns a real empty collection.
- Cross-workspace requests return the existing workspace-forbidden shape and reveal no tags.
- The panel preserves user input/confirmed tags on write failure and supports retry.
- Task 10/11A behavior and all existing dirty frontend-hardening paths remain intact.

## Implementation Record

**Delegation:** The configured project `worker` with `tokenfree-gpt/gpt-5.6-luna` was invoked, but the Pi runtime blocked launch before work began because the local `price-sync-core.ts` extension does not export a valid factory. The main model implemented this bounded slice using the approved plan and TDD.

**Changes completed:**

- Added typed document-tag contracts and an exported normalizer: NFKC, trim, Unicode whitespace collapse, locale-independent case dedupe with first spelling preserved, and post-normalization length/count validation.
- Added authenticated GET/PUT `/api/documents/:id/tags`, backed by the existing document `tags` JSON property in `library_properties`.
- Tags access checks document ownership before parsing or writing; only `principal.workspaceId` reaches the repository. Empty arrays persist as intentional clears, while malformed historical tag properties return validation errors.
- Added a typed browser client and migrated `PropertiesPanel` away from mock provider tags. The panel clears stale reads, ignores late results, keeps confirmed tags and typed input after write failures, disables conflicting controls while pending, and preserves visible loading/error/retry states.
- Added handler and browser regression coverage for persistence, Unicode/case normalization, clear, and cross-workspace read/write denial.

**Main-model verification performed:**

- `npx vitest run --project unit packages/contracts/src/tags.test.ts apps/web/src/features/editor/document-tags-api.test.ts apps/web/src/features/editor/document-editor.test.ts` passed: 3 files, 11 tests.
- Targeted ESLint passed for every Task 11B1 source and test file.
- `npx tsc -p packages/contracts/tsconfig.json --noEmit`, `npx tsc -p apps/web/tsconfig.json --noEmit`, and `npx tsc -p tsconfig.e2e.json --noEmit` passed.
- Playwright discovered the `document-tags` browser flow; `git diff --check` passed.

**Blocked verification:**

- `DATABASE_URL` is unset and Docker is unavailable, so the handler test containing the real persistence/isolation assertions cannot execute locally.
- Aggregate `npm run lint`, `npm run typecheck`, test wrappers, and browser wrappers require `flock`, which is unavailable. Direct focused checks above are evidence for their respective areas, not replacements for repository gates.

## Follow-On

Provision PostgreSQL and the documented command prerequisites, then run the Task 10/11A/11B1 integration, handler, browser, and aggregate gates. Next, implement Task 11B2: explicit relation creation/editing plus read-only generic document/block properties. Do not expand Task 12 search until the real tags and relation authoring boundary is verified.
