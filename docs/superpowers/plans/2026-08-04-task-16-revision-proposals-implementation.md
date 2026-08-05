# Task 16 Revision Proposal Implementation Plan

**Goal:** Let AI or a user create reviewable note-edit proposals without directly overwriting a confirmed document. A proposal carries the exact base revision, replacement blocks, a deterministic block-level diff, provenance, and support state; every merge respects the document's optimistic-concurrency revision number.

**Current state:** Task 15 is core-complete but its PostgreSQL and browser gates remain blocked by an unset `DATABASE_URL` and unavailable PostgreSQL on port 5432. Task 16 must preserve all Task 14/15 work and adds no provider call, queue, or automatic AI merge.

**Architecture:** `revision_proposals` is a workspace-bound immutable proposal snapshot. A proposal is only mutable in review metadata: `pending`, `accepted`, `rejected`, or `conflicted`; support state and review timestamps are append-safe state fields. The repository calculates the diff deterministically from the stored base blocks and proposed blocks. Accept and partial accept use `LibraryRepository.updateDocument` in one transaction at the original base revision. A revision mismatch marks the proposal conflicted and returns the current revision; it never changes the document. Preserve-both requires an explicit resolver request and creates one new document revision that retains the current user blocks plus selected proposal blocks with proposal provenance in its reason.

## Constraints

- Keep proposals candidate-only until an authenticated reviewer explicitly chooses an action.
- Bind every proposal, document lookup, review, and resolution to `principal.workspaceId`.
- Reuse the existing library revision history and `expectedRevisionNumber` protection. Do not add a second document version model.
- Store source/provenance as structured data and validate it with Zod. Do not fabricate provider metadata.
- The review UI uses Tailwind and lucide icons, has accessible pending/error states, and never disables manual document editing.
- Preserve the existing uncommitted Task 14 and Task 15 files. Do not alter exploration mock candidate behavior.
- Tests are written before their corresponding repository/API/UI behavior. Do not commit this slice.

## File Map

- Create `packages/contracts/src/revision-proposal.ts` and export it from `packages/contracts/src/index.ts`.
- Create `packages/database/src/migrations/0010_revision_proposals.sql` and `packages/database/src/schema/revision-proposals.ts`.
- Create `packages/database/src/repositories/revision-proposals.ts` and export it from `packages/database/src/index.ts`.
- Extend `apps/web/src/features/auth/service.ts` with principal-bound proposal actions.
- Create document-scoped proposal route handlers under `apps/web/src/app/api/documents/[id]/revision-proposals/` and action routes under `apps/web/src/app/api/revision-proposals/[id]/`.
- Create `apps/web/src/features/revision-review/` for the typed client, diff model, and review panel; attach it to the document editor without changing its save behavior.
- Add `tests/integration/revision-proposal-repository.test.ts`, `tests/integration/handler/revision-proposals.test.ts`, and `tests/e2e/ai-note-revision.spec.ts`.

## 1. Contract And RED Tests

1. Define schemas for proposal source, support state, status, base revision, base blocks, proposed blocks, block diff, and reviewer actions.
2. Write failing repository tests proving a proposal captures immutable base/proposed snapshots and emits added/removed/changed/unchanged block diff entries.
3. Add failing tests for workspace denial, rejection terminality, and a stale base revision leaving the document untouched.
4. Run the focused tests. With no database, retain the explicit `DATABASE_URL` gate rather than treating it as a test pass.

## 2. Persistence And Atomic Merge

1. Add migration `0010_revision_proposals.sql` with document/workspace foreign keys, status and support-state checks, source/proposal JSON fields, and indexes for document review queues.
2. Implement workspace-bound create/list/get/review repository methods.
3. Accept full proposals atomically through the existing library revision mechanism at `baseRevisionNumber`.
4. Implement block-level partial accept using explicit selected proposal block IDs; preserve all unselected current blocks.
5. On revision mismatch, set `conflicted` with no document write and expose current revision data. Implement preserve-both only from that state, as an explicit new revision retaining current blocks plus selected proposal blocks and a provenance-bearing reason.
6. Prove repeated terminal actions are idempotent and cannot create duplicate revisions.

## 3. Principal API And Review UI

1. Add handler RED tests for authentication, malformed payloads, cross-workspace denial, full accept, partial accept, reject, conflict, and preserve-both.
2. Implement principal-bound routes and typed client parsing.
3. Build a compact document-editor review panel that shows base revision, block diff, source/support state, and controls for accept, selected-block accept, reject, and explicit conflict resolution. Use titles on icon-only controls.
4. Add a browser flow: create a confirmed note, create a proposal, edit the note concurrently, observe conflict/no overwrite, resolve preserve-both, then verify both contents and immutable revision history.

## 4. Verification And Progress Record

1. Run focused repository/handler/UI tests, contracts/database/web TypeScript, targeted lint, E2E discovery and browser flow, `git diff --check`, and one `graphify update .`.
2. Separately record unavailable PostgreSQL/browser prerequisites; never mark unrun integration or browser gates as passing.
3. Independently review for direct AI writes, workspace leakage, stale overwrite, duplicate revisions, mutable source snapshots, and accidental Task 14/15 changes.
4. Update README and the authoritative plan only with fresh evidence, then identify Task 17 as the next feature slice.
