# Task 11B2 Relation Authoring And Read-Only Properties Implementation Plan

> **For agentic workers:** Implement this plan through the project `worker` configured as `tokenfree-gpt/gpt-5.6-luna`. Work test-first. Do not commit, reset, checkout, clean, stash, amend, or change unrelated dirty files.

**Status:** Implemented and main-model reviewed. No commit is authorized; PostgreSQL-backed integration/handler/browser and aggregate gates remain environment-blocked.

**Goal:** Let an authorized editor create, retype, and delete typed outgoing document relations, and inspect persisted document/block properties without exposing generic property writes.

**Architecture:** The existing `library_relations` table stays authoritative. The repository gains relation lookup/update/delete primitives constrained by `workspace_id`, then principal-bound service helpers guarantee that the host document is readable and remains the relation source. A document-scoped API exposes all mutations under `/api/documents/:id/relations`; it resolves only current-workspace document/block targets and returns enriched relation endpoints. A separate GET-only `/api/documents/:id/properties` returns non-tag document properties plus block property groups belonging to the current document. The client calls typed APIs, and the editor gets two compact operational panels: outgoing relation authoring and read-only metadata.

**Non-goals:**

- No migration, new table, global state, CRDT, automatic relation inference, collaborative editing, or search rewrite.
- No generic property creation, mutation, deletion, schema builder, or tags duplication. `tags` remains exclusively owned by the existing tags endpoint/panel.
- No changing relation endpoints during edit. Editing only changes `relationType`; changing an endpoint is a deliberate delete-and-create action.
- No incoming-relation mutation from a target note. The current document can only author relations with itself as `from` endpoint.
- No selection of individual source blocks in this slice. A relation starts at the current document and can target a document or one of its blocks.

## Contract And Security Decisions

### Relation identity and mutation

- `POST /api/documents/:id/relations` body:

```ts
{
  to: { type: "document" | "block"; id: string },
  relationType: "references" | "supports" | "embeds" | "derived_from" | "related"
}
```

- The route parameter is the authoritative `from` document ID. The request never accepts `workspaceId`, `fromType`, or `fromId`.
- `PATCH /api/documents/:id/relations/:relationId` body only accepts `{ relationType }`. It keeps endpoints and `createdAt` stable.
- `DELETE /api/documents/:id/relations/:relationId` returns `204`.
- A `PATCH` that would duplicate another relation with the same workspace, endpoints, and target type returns `409 CONFLICT`, preserving both existing rows. It does not silently delete or merge user-authored relations.
- An edit/delete can affect only a relation whose `fromType === "document"` and `fromId === :id`. The route must reject a matching incoming relation as `NOT_FOUND`; it must never authorize mutation based only on a relation ID.
- Repository methods always filter by `workspaceId`, preventing direct cross-workspace ID access. Service methods call `getDocumentForPrincipal` before parsing/performing mutations so user B receives the existing `WORKSPACE_FORBIDDEN` response for user A's document.
- The repository validates relation endpoint type/UUID/liveness and both endpoint workspaces. Soft-deleted documents or blocks attached to one are invalid new targets. Existing references to subsequently deleted endpoints remain listable as `broken` through Task 11A behavior.

### Read-only properties

- `GET /api/documents/:id/properties` returns:

```ts
{
  document: PropertyView[],
  blocks: Array<{
    blockId: string;
    blockType: string;
    text: string | null;
    properties: PropertyView[];
  }>
}
```

- `PropertyView` has `{ id, key, valueType, value, updatedAt }`. It intentionally omits `workspaceId` and subject IDs, because scope is defined by the endpoint.
- `document` excludes the canonical `tags` property. The existing `PropertiesPanel` remains its UI, preventing duplicate representation and conflicting ownership.
- `blocks` includes only blocks with at least one non-tag property, ordered by document block position. Property records maintain repository key order.
- Values use their persisted JSON form and are rendered read-only with a bounded, stable formatter. Strings, booleans, numbers, arrays and objects are displayed; invalid/unserializable values degrade to a non-sensitive placeholder rather than failing the full panel.

## Files And Ownership

- Modify `packages/contracts/src/relations.ts`: relation mutation requests, enriched outgoing relation, and list response contracts.
- Create `packages/contracts/src/properties.ts`: response contracts for read-only document/block properties.
- Modify `packages/contracts/src/index.ts`: exports.
- Modify `packages/database/src/repositories/library.ts`: `getRelation`, `updateRelationType`, `deleteRelation`, with workspace and endpoint invariants.
- Modify `tests/integration/library-repository.test.ts`: repository lifecycle, collision, cross-workspace and source-direction cases.
- Modify `apps/web/src/features/auth/service.ts`: principal-bound author/list/mutate relations and read-only document property helpers.
- Create `apps/web/src/app/api/documents/[id]/relations/route.ts` and `apps/web/src/app/api/documents/[id]/relations/[relationId]/route.ts`: authenticated relation handlers.
- Create `apps/web/src/app/api/documents/[id]/properties/route.ts`: authenticated GET-only metadata handler.
- Create `apps/web/src/features/editor/document-relations-api.ts` and tests: typed browser client and structured errors.
- Create `apps/web/src/features/editor/document-properties-api.ts` and tests: typed browser client and structured errors.
- Create `apps/web/src/features/editor/relation-authoring-panel.tsx`: current-document outgoing relation list, create form, relation type editing, deletion and recoverable state.
- Create `apps/web/src/features/editor/read-only-properties-panel.tsx`: document/block property display with loading/error/retry states.
- Modify `apps/web/src/features/editor/document-editor.tsx`: mount the new panels without changing editor saves, draft behavior, backlinks, or tags.
- Modify `apps/web/src/features/editor/document-editor.test.ts`: static state/accessibility coverage following the existing convention.
- Modify `tests/integration/handler/auth.test.ts`: authenticated, validation, ownership, collision, property visibility and cross-workspace handler regressions.
- Create `tests/e2e/document-relations.spec.ts`: browser create, retype, delete, reload persistence and incoming visibility.

## Task 1: Contracts And Repository RED Tests

1. Extend contracts with `relationMutationTargetSchema`, `createDocumentRelationRequestSchema`, `updateDocumentRelationRequestSchema`, `managedRelationSchema`, and `managedRelationsResponseSchema`.
2. Preserve `KnowledgeLink` and Task 11A read/index contracts unchanged. Reuse `relationTypeSchema` rather than cloning enum values.
3. Add `readOnlyPropertySchema`, `blockPropertyGroupSchema`, and `documentPropertiesResponseSchema`. `value` uses `z.unknown()` and endpoint response validation handles serializable JSON values.
4. Expand `LibraryRepository` with:

```ts
getRelation({ workspaceId, relationId }): Promise<RelationRecord>;
updateRelationType({ workspaceId, relationId, relationType }): Promise<RelationRecord>;
deleteRelation({ workspaceId, relationId }): Promise<void>;
```

5. Start with PostgreSQL repository tests proving:
   - update preserves relation ID, endpoints and creation time while changing type;
   - update collision rejects with `CONFLICT` and does not remove either relation;
   - delete removes only the requested row and `getRelation` returns `NOT_FOUND` afterwards;
   - mismatched workspace cannot read/update/delete another workspace relation;
   - invalid type and missing relation reject predictably.
6. Implement SQL operations with `workspace_id` predicates. For update, map unique-constraint collision to `LibraryError("CONFLICT", ...)`; do not catch unrelated DB failures.

## Task 2: Principal-Bound Services And Routes

1. Add a reusable enrich helper for relation records, retaining existing endpoint `available`/`broken` behavior.
2. Add service helpers:

```ts
listManagedDocumentRelationsForPrincipal(runtime, principal, documentId)
createDocumentRelationForPrincipal(runtime, principal, documentId, body)
updateDocumentRelationForPrincipal(runtime, principal, documentId, relationId, body)
deleteDocumentRelationForPrincipal(runtime, principal, documentId, relationId)
listDocumentPropertiesForPrincipal(runtime, principal, documentId)
```

3. Each helper first runs `getDocumentForPrincipal`. Create validates the target endpoint is live and in `principal.workspaceId`; it always writes `{ fromType: "document", fromId: documentId }`.
4. Update/delete fetch the relation within `principal.workspaceId`, verify source direction exactly, and map an incoming/unrelated relation to `NOT_FOUND` without exposing its endpoints.
5. Property reads list document properties and the host document's blocks with `Promise.all`, exclude `key === "tags"`, omit empty block groups, and return only safe property fields.
6. Routes use `requirePrincipal`, `mapDomainError`, and `jsonError`. `GET /relations`, `POST /relations`, `PATCH/DELETE /relations/:relationId`, and GET `/properties` are the entire surface.
7. Handler tests must cover unauthenticated routes, create/list/update/delete flow, invalid payloads, duplicate update conflict, incoming relation mutation denial, absent tags in metadata, block property visibility, user B read/mutation/property denial, and client-supplied `workspaceId` irrelevance.

## Task 3: Typed Clients And Editor UI

1. Add API clients modeled on `document-tags-api.ts`: encoded IDs, JSON request headers, Zod response parsing, and typed errors preserving server code/status/message.
2. `RelationAuthoringPanel` uses a memoized client. It has a compact create form with:
   - document/block segmented target type control;
   - target UUID input;
   - relation type select;
   - icon-only submit with an accessible label and tooltip.
3. Render only outgoing relations. Each item displays target title/text, relation type select, and icon-only delete button. Broken targets render as text without a navigation link. Update/delete/create requests disable all conflicting controls while pending; failed writes retain last confirmed list and form fields. List failures expose `role="alert"` and a retry button.
4. `ReadOnlyPropertiesPanel` uses a memoized client and supports loading, empty, error/retry and available states. It displays non-tag document properties first, then labeled block groups. It has no mutation controls.
5. Keep cards shallow and the existing two-column responsive editor layout. Change the panel grid to a stable three-column-aware layout that stacks cleanly; do not alter global CSS or use inline styles.
6. Add static rendering tests for title/labels, loading, recovery and disabled mutation controls. Client tests must cover encoded paths, bodies, response parsing, structured `403`, `409`, and validation errors.

## Task 4: Browser Flow And Verification

Create `tests/e2e/document-relations.spec.ts`:

1. Register one user; create source and target notes by API.
2. Open source, create an outgoing `references` relation to target, and wait for a successful relation mutation response.
3. Change type to `supports`, reload, and assert the updated type persists.
4. Delete it, reload, and assert the outgoing list empty state.
5. Open target and assert incoming backlink still appears before deletion, proving Task 11A link read compatibility.

Run focused checks first:

```bash
npx vitest run --project unit packages/contracts/src/relations.test.ts packages/contracts/src/properties.test.ts apps/web/src/features/editor/document-relations-api.test.ts apps/web/src/features/editor/document-properties-api.test.ts apps/web/src/features/editor/document-editor.test.ts
npx eslint packages/contracts/src/relations.ts packages/contracts/src/relations.test.ts packages/contracts/src/properties.ts packages/contracts/src/properties.test.ts packages/contracts/src/index.ts packages/database/src/repositories/library.ts apps/web/src/features/auth/service.ts apps/web/src/app/api/documents/[id]/relations/route.ts apps/web/src/app/api/documents/[id]/relations/[relationId]/route.ts apps/web/src/app/api/documents/[id]/properties/route.ts apps/web/src/features/editor/document-relations-api.ts apps/web/src/features/editor/document-relations-api.test.ts apps/web/src/features/editor/document-properties-api.ts apps/web/src/features/editor/document-properties-api.test.ts apps/web/src/features/editor/relation-authoring-panel.tsx apps/web/src/features/editor/read-only-properties-panel.tsx apps/web/src/features/editor/document-editor.tsx apps/web/src/features/editor/document-editor.test.ts tests/integration/library-repository.test.ts tests/integration/handler/auth.test.ts tests/e2e/document-relations.spec.ts
npx tsc -p packages/contracts/tsconfig.json --noEmit
npx tsc -p packages/database/tsconfig.json --noEmit
npx tsc -p apps/web/tsconfig.json --noEmit
npx tsc -p tsconfig.e2e.json --noEmit
git diff --check
```

When PostgreSQL/Docker and `flock` are available, additionally run:

```bash
npm run test:integration -- library-repository
npm run test:handler -- auth
npm run test:browser -- document-relations
npm run lint
npm run typecheck
npm run build
```

## Implementation Record

**Delegation:** The configured project `worker` using `tokenfree-gpt/gpt-5.6-luna` was invoked after this plan was written. Pi blocked launch before the worker began because `C:\\Users\\86080\\.pi\\agent\\extensions\\price-sync-core.ts` does not export a valid factory. The main model then implemented this bounded slice test-first and performed the review.

**Additional hardening completed after the initial implementation record:**

- Removed repository `this`-method binding dependence by routing relation lookup through a closure helper.
- Added repository-level live-endpoint checks so direct relation writes cannot target soft-deleted documents or blocks.
- Normalized relation mutation authorization before request-body parsing, including foreign-workspace and incoming relation IDs.
- Made local relation-client validation return structured `DocumentRelationsApiError` values and corrected the accessible labels used by the browser flow.

**Changes completed:**

- Added contracts for strict relation creation/type updates, managed relation responses, and read-only document/block property responses.
- Extended `LibraryRepository` with workspace-scoped relation lookup, type update, and deletion. Type collisions map to `CONFLICT`; direct cross-workspace repository access maps to `WORKSPACE_MISMATCH`.
- Added authenticated relation routes for list/create and source-authorized update/delete. The route document is always the source; incoming, unrelated, and foreign-workspace relation IDs are normalized to `NOT_FOUND` at this API boundary.
- Added a GET-only properties route that returns the host document and its block properties, excludes canonical `tags`, omits empty block groups, and never exposes workspace or subject IDs.
- Added typed browser clients and editor panels for outgoing relation authoring/retyping/deletion and read-only persisted metadata. Both panels preserve loading/error/retry states; relation writes disable conflicting controls and retain confirmed state and form input after failures.
- Added repository, handler, client, static UI, and browser regression coverage for lifecycle, conflict, workspace authorization, target-source direction, tag filtering, reload persistence, and Task 11A backlink compatibility.

**Main-model verification performed:**

- `npx vitest run --project unit packages/contracts/src/tags.test.ts packages/contracts/src/relations.test.ts packages/contracts/src/properties.test.ts apps/web/src/features/editor/document-tags-api.test.ts apps/web/src/features/editor/knowledge-links-api.test.ts apps/web/src/features/editor/document-relations-api.test.ts apps/web/src/features/editor/document-properties-api.test.ts apps/web/src/features/editor/editor-api.test.ts apps/web/src/features/editor/document-editor.test.ts` passed: 9 files, 38 tests.
- Targeted ESLint passed for contracts, repository, auth service, Task 11B2 routes, clients, panels, editor, and database/handler/browser tests.
- `npx tsc -p packages/contracts/tsconfig.json --noEmit`, `npx tsc -p packages/database/tsconfig.json --noEmit`, `npx tsc -p apps/web/tsconfig.json --noEmit`, and `npx tsc -p tsconfig.e2e.json --noEmit` passed.
- Playwright discovered `document-relations.spec.ts`; `git diff --check` passed.

**Blocked verification:**

- `DATABASE_URL` is unset and Docker remains unavailable, so repository integration and handler test projects cannot run locally.
- Aggregate test/lint/typecheck/browser/build wrappers still require `flock`, which is unavailable. Focused direct checks above are not substitutes for those gates.

## Acceptance Criteria

- Relation mutations are documented, typed, and enforce source-document ownership plus workspace scope server-side.
- Existing Task 11A backlinks keep correct `isIncoming` behavior after relation create/retype/delete.
- A user cannot mutate an incoming relation from the target document or learn a foreign workspace relation/property through IDs.
- Relation type collision returns a stable conflict without destructive merge.
- Editor outgoing relations persist across reload, can be created/retyped/deleted, and preserve confirmed UI state after failed mutations.
- The editor displays non-tag document and block properties but ships no generic property writer.
- Existing task 10/11A/11B1 behavior remains intact; all focused unit/type/lint checks are run, while database/browser aggregate gates are explicitly recorded if unavailable.
