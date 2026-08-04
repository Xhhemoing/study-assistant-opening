# Task 11A Knowledge Links Implementation Plan

> **For agentic workers:** Implement with TDD through the configured `tokenfree-gpt/gpt-5.6-luna` worker. Do not commit; preserve the existing dirty workspace.

**Status:** Implemented and main-model reviewed. No commit is authorized; PostgreSQL-backed integration, handler, and browser gates remain environment-blocked.

**Goal:** Connect the existing versioned document editor to workspace-authorized document/block relations so backlinks, block references, and embeds are persisted and rendered from the server rather than mock-only local state.

**Architecture:** Keep `library_relations` and the existing repository as the source of truth. Add a small typed contract and principal-bound service/API boundary: saving a document sends extracted wiki-link titles to an indexing endpoint, which creates idempotent document references for titles that resolve in the current workspace; a read endpoint enriches raw relations with current source/target document and block summaries and returns a stable `broken` state when an endpoint is soft-deleted or missing. The editor's backlinks panel consumes this endpoint directly. No new database tables, search system, global state, or relation UI editor is introduced.

**Tech Stack:** TypeScript, Zod, Next.js App Router route handlers, existing PostgreSQL `LibraryRepository`, React client components, Tailwind utilities, `lucide-react`, Vitest and existing integration/browser test conventions.

## Global Constraints

- Preserve all existing uncommitted changes; never reset, checkout, clean, stash, or commit.
- Use the existing `library_relations` table and repository; do not create a second relation, tag, or property store.
- Every server operation derives workspace scope from the authenticated principal; ignore client workspace IDs.
- Relation kinds are typed as `references`, `supports`, `embeds`, `derived_from`, or `related`.
- Indexing is idempotent; duplicate extracted titles must create one relation at most.
- A soft-deleted or missing endpoint is represented as `broken`, never as a fabricated document or block.
- Preserve append-only document revisions and the Task 10 `expectedRevisionNumber` precondition.
- New/changed UI uses Tailwind utilities only and lucide icons; no inline styles or global CSS.
- Do not implement collaborative editing, automatic merge, CRDTs, PDF reading, or the full tags/properties write workflow in this slice.

## Current Context

- `packages/database/src/repositories/library.ts` already supports typed relation rows, workspace checks, idempotent `createRelation`, and `listRelations`.
- `apps/web/src/features/editor/link-utils.ts` already extracts unique `[[Title]]` references.
- `BacklinksPanel` currently calls mock `StudyDataProvider.listBacklinks`; `DocumentEditor` calls mock `indexDocumentLinks` after successful saves.
- Existing integration tests already cover raw document/block relations, embeds, properties, cross-workspace rejection, and soft delete/restore. Extend the closest tests instead of duplicating those repository tests.

## File Map

- Create: `packages/contracts/src/relations.ts` — Zod schemas/types for relation kind, endpoint, enriched knowledge link, and index request/response.
- Modify: `packages/contracts/src/index.ts` — export the relations contract.
- Modify: `apps/web/src/features/auth/service.ts` — principal-bound link read/index helpers and endpoint enrichment.
- Create: `apps/web/src/app/api/documents/[id]/links/route.ts` — authenticated GET and POST route handlers.
- Create: `apps/web/src/features/editor/knowledge-links-api.ts` — typed browser API client with structured errors and encoded document IDs.
- Modify: `apps/web/src/features/editor/document-editor.tsx` — index extracted wiki links through the real API after a successful document save/restore.
- Modify: `apps/web/src/features/editor/backlinks-panel.tsx` — consume `documentId` and the real API, render loading/error/retry/empty/link/embed/broken states.
- Modify: `apps/web/src/features/editor/document-editor.test.ts` — static recovery/accessibility regression assertions where possible.
- Create: `apps/web/src/features/editor/knowledge-links-api.test.ts` — request serialization, encoded IDs, response and 409/403 error handling.
- Modify: `tests/integration/handler/auth.test.ts` — authenticated route, workspace isolation, indexing and enriched read cases.
- Modify: `tests/integration/library-repository.test.ts` only if a missing repository behavior is exposed; do not alter unrelated existing assertions.
- Create: `tests/e2e/knowledge-links.spec.ts` — browser flow for saving `[[Target]]`, opening target, showing backlink, and a stable empty/broken presentation when supported by the fixture.

## Task 1: Contracts and failing tests

- [ ] Add `relationTypeSchema`, `relationEndpointSchema`, `knowledgeLinkSchema`, `knowledgeLinksResponseSchema`, and `indexDocumentLinksRequestSchema`.

Use these exact shapes:

```ts
export const relationTypeSchema = z.enum([
  "references", "supports", "embeds", "derived_from", "related",
]);

export const relationEndpointSchema = z.object({
  type: z.enum(["document", "block"]),
  id: z.string().uuid(),
  title: z.string().nullable(),
  text: z.string().nullable(),
  status: z.enum(["available", "broken"]),
});

export const knowledgeLinkSchema = z.object({
  id: z.string().uuid(),
  relationType: relationTypeSchema,
  from: relationEndpointSchema,
  to: relationEndpointSchema,
  createdAt: z.string().datetime(),
});

export const knowledgeLinksResponseSchema = z.object({
  links: z.array(knowledgeLinkSchema),
});

export const indexDocumentLinksRequestSchema = z.object({
  targetTitles: z.array(z.string().trim().min(1).max(200)).max(100),
});
```

Add unit tests for valid parsing, duplicate-title normalization at the contract boundary where applicable, rejection of unknown relation kinds, and rejection of invalid endpoint IDs. Run the contract/editor API tests and verify the new assertions fail before implementation.

## Task 2: Principal-bound service and route

- [ ] Add `listKnowledgeLinksForPrincipal(runtime, principal, documentId)` and `indexDocumentLinksForPrincipal(runtime, principal, documentId, body)` in `apps/web/src/features/auth/service.ts`.
- [ ] Read the host document first with the existing authorization helper. For indexing, resolve each trimmed title against `runtime.library.listDocuments({ workspaceId: principal.workspaceId })`, excluding the host document and deleted records; create one `references` relation per resolved title through `runtime.library.createRelation`.
- [ ] Make indexing idempotent by relying on repository upsert behavior and deduplicating normalized titles before calls. Unresolved titles are ignored and must not create fake endpoint IDs.
- [ ] For reading, call `listRelations` for the host document. Enrich each endpoint by loading the current document or, for block endpoints, locating the block in its current document. Use `includeDeleted: true` only through the repository to distinguish a known soft-deleted endpoint from an unavailable endpoint. Return `status: "broken"`, null display fields, and no invented content when the endpoint cannot be resolved.
- [ ] Preserve relation direction in the response. Backlinks are relations where the current document is the `to` endpoint; outgoing references/embeds remain available for the panel and future knowledge-link UI.
- [ ] Add GET/POST route handlers under `/api/documents/[id]/links` using `requirePrincipal`, Zod parsing in the service, `jsonError`, and `mapDomainError`.

Before implementation, add handler tests for unauthenticated 401, same-workspace index/read, attacker-supplied workspace fields being ignored, cross-workspace document never appearing, duplicate title resulting in one relation, unresolved title producing no relation, and soft-deleted target returning `broken`. Run them RED, then implement the minimal service/route.

## Task 3: Typed browser client and editor integration

- [ ] Implement `createKnowledgeLinksApi(fetchImpl = fetch)` with:

```ts
type KnowledgeLinksApi = {
  list(documentId: string): Promise<KnowledgeLink[]>;
  index(documentId: string, targetTitles: string[]): Promise<void>;
};
```

Use `encodeURIComponent(documentId)`, JSON content type for POST, and preserve structured error code/status/message in a local `KnowledgeLinksApiError`.

- [ ] In `DocumentEditor`, memoize the API and replace the auxiliary `provider.indexDocumentLinks` call with `knowledgeLinksApi.index(documentId, extractWikiLinks(blocks))` after successful normal saves and restores. A failed index remains auxiliary and must not turn a successful document save into an error.
- [ ] In `BacklinksPanel`, accept `{ documentId }`, load the real API on mount/document change, clear stale links at reload, ignore late results after unmount, show `role=status` loading, `role=alert` error with `RefreshCw` retry, and render available links as encoded `/library/:id` links. Render broken endpoints with explicit text and no clickable fake URL. Show relation kind text for `references`/`embeds`/`supports` and a compact source/target block summary when available.
- [ ] Keep the existing PropertiesPanel mock tag behavior unchanged in this slice.

Add API-client tests before implementation for URL encoding, POST body, structured errors, and response parsing. Add static panel assertions for loading, retry, broken text, and no fake links where the current test environment permits. Run unit tests RED, implement, then run GREEN.

## Task 4: Browser and focused verification

- [ ] Add the browser flow using the existing registration fixture: create a source note and target note, put `[[Target title]]` in the source, save, open the target, and assert the backlink appears. Avoid arbitrary sleeps; wait on visible UI and network-backed state.
- [ ] Run:

```bash
npx vitest run --project unit packages/contracts/src/relations.test.ts apps/web/src/features/editor/knowledge-links-api.test.ts apps/web/src/features/editor/document-editor.test.ts
npx eslint packages/contracts/src/relations.ts packages/contracts/src/index.ts apps/web/src/features/auth/service.ts apps/web/src/app/api/documents/[id]/links/route.ts apps/web/src/features/editor/knowledge-links-api.ts apps/web/src/features/editor/backlinks-panel.tsx apps/web/src/features/editor/document-editor.tsx tests/integration/handler/auth.test.ts
npx tsc -p packages/database/tsconfig.json --noEmit
npx tsc -p apps/web/tsconfig.json --noEmit
```

- [ ] When PostgreSQL/Docker prerequisites are available, run:

```bash
npm run test:handler -- auth
npm run test:integration -- library-repository
npm run test:browser -- knowledge-links
npm run build
```

- [ ] Review the diff for workspace leakage, fabricated broken-link content, stale async updates, duplicate relation creation, improper ID encoding, and accidental edits to existing dirty hardening files.

## Acceptance Criteria

- A saved `[[Existing title]]` creates one workspace-local `references` relation and repeated saves do not duplicate it.
- GET `/api/documents/:id/links` returns typed enriched links for document/document, document/block, and block/block relations.
- A relation to a soft-deleted or missing endpoint is visible as `broken` and cannot be clicked as a document.
- User A cannot index, read, or infer User B's document or block relations.
- The editor's backlink panel uses the real API with loading, retryable error, empty, available, and broken states.
- Task 10 revision concurrency and all pre-existing dirty paths remain intact.

## Implementation Record

**Implemented with:** project `worker` subagent configured as `tokenfree-gpt/gpt-5.6-luna`; the main model completed review fixes after subsequent subagent review calls were blocked by a local Pi extension factory error.

**Changes completed:**

- Added typed relation, endpoint, enriched link, and index request contracts.
- Added authenticated GET/POST `/api/documents/:id/links`, principal-bound relation indexing, workspace-local title resolution, and enriched document/block endpoint reads.
- Added `getBlock` with workspace and soft-delete awareness to the existing library repository.
- Source and target endpoints return `available` or `broken`; available block endpoints include their owning `documentId`, while broken endpoints never become navigable links.
- The API computes `isIncoming` from the host document and its current blocks, so backlinks to a block in the displayed document appear while outbound links remain excluded.
- The editor indexes extracted wiki links via the real API after a successful save/restore; the backlinks panel now has server-backed loading, retryable error, empty, available, broken, and block-reference states.
- Added contracts, API client, handler, repository, and browser regression coverage, including idempotency, unresolved titles, workspace isolation, soft-deleted targets, and target-block backlinks.

**Main-model verification performed:**

- `npx vitest run --project unit packages/contracts/src/relations.test.ts apps/web/src/features/editor/knowledge-links-api.test.ts apps/web/src/features/editor/document-editor.test.ts apps/web/src/features/editor/editor-api.test.ts apps/web/src/features/editor/link-utils.test.ts` passed: 5 files, 19 tests.
- Targeted ESLint passed for all Task 11A implementation and test files.
- `npx tsc -p packages/contracts/tsconfig.json --noEmit`, `npx tsc -p packages/database/tsconfig.json --noEmit`, `npx tsc -p apps/web/tsconfig.json --noEmit`, and `npx tsc -p tsconfig.e2e.json --noEmit` passed.
- `git diff --check` passed.

**Blocked verification:**

- PostgreSQL integration and handler suites require `DATABASE_URL`; it is unset, and Docker is unavailable in this environment.
- Aggregate `npm run lint`, `npm run typecheck`, test wrappers, and browser wrappers require `flock`, which is unavailable. The targeted direct checks above are evidence for their respective areas, not replacements for repository gates.

## Follow-On

Provision PostgreSQL and the documented command prerequisites, then run the Task 10/11A integration, handler, browser, and aggregate gates. Next, implement Task 11B: typed relation creation/editing plus server-backed tags/properties. Do not declare Task 11 or Phase 1 complete: Tasks 11B-30 and their validation gates remain.
