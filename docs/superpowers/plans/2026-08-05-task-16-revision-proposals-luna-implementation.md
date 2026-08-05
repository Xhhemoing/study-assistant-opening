# Task 16 Revision Proposals Luna Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use test-driven development. Execute tasks in order and keep checkbox state current. The coordinator performs the final specification and quality review.

**Goal:** Add a workspace-scoped review pipeline for AI/user note revision proposals so no proposal can overwrite a confirmed document without an explicit authenticated decision and an optimistic-concurrency check.

**Architecture:** Contracts own proposal, diff, provenance, support-state, action, and response shapes. The pure domain package computes deterministic block diffs and selected-block merge candidates. PostgreSQL stores immutable base/proposed snapshots plus review metadata; the repository serializes review decisions and delegates document writes to the existing append-only revision model in the same transaction. Thin App Router handlers bind all operations to the session principal, and a compact editor panel consumes typed APIs without changing manual-save behavior.

**Tech Stack:** TypeScript, Zod, PostgreSQL, `postgres`, Drizzle schema metadata, Next.js App Router, React, Tailwind CSS, lucide-react, Vitest, Playwright.

## Global Constraints

- Preserve every pre-existing dirty file and all Task 14/15 work. Do not reset, checkout, stash, clean, revert, or commit.
- Use the next contiguous migration, `0010_revision_proposals.sql`; never edit migrations `0001` through `0009`.
- Bind every repository and route operation to `workspaceId` from the authenticated principal. A client-supplied workspace ID is ignored or rejected.
- Proposal base blocks, proposed blocks, provenance, base revision number, and computed diff are immutable after creation.
- Reuse `library_documents`, `library_blocks`, `library_revisions`, and their append-only/optimistic-concurrency rules. Do not create a second document version store.
- A stale proposal never mutates the document. It becomes `conflicted` and returns current document data needed for resolution.
- Terminal decisions are idempotent and cannot append duplicate document revisions.
- Provider metadata is nullable when unknown; never fabricate it.
- Use Tailwind utilities only and lucide-react icons. Preserve the incumbent editor visual system and manual editing flow.
- Do not add provider calls, queue jobs, automatic acceptance, collaborative editing, or Task 17 functionality.
- Follow RED -> GREEN -> refactor for each behavior. Record exact commands and failures in the Execution Record.

## File Map

- Create `packages/contracts/src/revision-proposal.ts`: serializable proposal, diff, source, support, action, conflict, and response schemas.
- Modify `packages/contracts/src/index.ts`: export all Task 16 schemas/types.
- Create `packages/domain/src/revisions/proposals.ts`: pure deterministic diff and merge-selection helpers.
- Create `packages/domain/src/revisions/proposals.test.ts`: domain RED/GREEN coverage.
- Modify `packages/domain/src/index.ts`: export the proposal helpers.
- Create `packages/database/src/migrations/0010_revision_proposals.sql`: persistence, checks, indexes, immutable snapshot guard, and effect uniqueness.
- Create `packages/database/src/schema/revision-proposals.ts`: Drizzle metadata and row JSON types.
- Create `packages/database/src/repositories/revision-proposals.ts`: workspace-bound create/list/get/review/resolve operations.
- Modify `packages/database/src/index.ts`: export schema/repository APIs.
- Modify `apps/web/src/features/auth/service.ts`: runtime repository construction, error mapping, and principal-bound services.
- Create handlers under `apps/web/src/app/api/documents/[id]/revision-proposals/` and `apps/web/src/app/api/revision-proposals/[id]/`.
- Create `apps/web/src/features/revision-review/revision-proposal-api.ts`: typed client and structured API errors.
- Create `apps/web/src/features/revision-review/revision-review-panel.tsx`: editor review queue and decision controls.
- Modify `apps/web/src/features/editor/document-editor.tsx`: mount the review panel without coupling it to manual save state.
- Create `tests/integration/revision-proposal-repository.test.ts` and `tests/integration/handler/revision-proposals.test.ts`.
- Create `tests/e2e/ai-note-revision.spec.ts`.
- Update current progress records only after verification.

---

### Task 1: Contract And Pure Domain Boundary

**Interfaces:**

```ts
export type RevisionProposalStatus = "pending" | "accepted" | "rejected" | "conflicted";
export type RevisionProposalSupportState = "supported" | "partial" | "insufficient" | "conflicting" | "inference";
export type RevisionProposalDiffKind = "added" | "removed" | "changed" | "unchanged";
export type RevisionProposalAction = "accept" | "partial_accept" | "reject" | "preserve_both";

export function diffRevisionBlocks(
  baseBlocks: RevisionProposalBlock[],
  proposedBlocks: RevisionProposalBlock[],
): RevisionProposalDiffEntry[];

export function selectProposalBlocks(
  currentBlocks: RevisionProposalBlock[],
  proposedBlocks: RevisionProposalBlock[],
  selectedProposalBlockIds: string[],
): RevisionProposalBlock[];

export function preserveBothBlocks(
  currentBlocks: RevisionProposalBlock[],
  proposedBlocks: RevisionProposalBlock[],
  selectedProposalBlockIds: string[],
): RevisionProposalBlock[];
```

- [ ] Write domain tests first for added/removed/changed/unchanged classification, stable output ordering, duplicate-ID rejection, explicit selected-block replacement/addition, and preserve-both ID collision handling.
- [ ] Run `npx vitest run packages/domain/src/revisions/proposals.test.ts`; confirm the expected missing-module RED.
- [ ] Implement Zod contracts with UUID block/document/proposal IDs, non-empty bounded strings, JSON-record block content, immutable source/provenance fields, nullable provider metadata, and discriminated review requests.
- [ ] Implement the pure helpers without DB/HTTP imports and export them.
- [ ] Run the focused domain tests plus contracts/domain typechecks.

### Task 2: Persistence And Repository RED/GREEN

**Repository interface:**

```ts
export type RevisionProposalRepository = {
  create(input: {
    workspaceId: string;
    documentId: string;
    baseRevisionNumber: number;
    proposedTitle?: string | null;
    proposedBlocks: RevisionProposalBlock[];
    source: RevisionProposalSource;
    supportState: RevisionProposalSupportState;
    proposalId?: string;
  }): Promise<RevisionProposalRecord>;
  list(input: { workspaceId: string; documentId: string }): Promise<RevisionProposalRecord[]>;
  get(input: { workspaceId: string; proposalId: string }): Promise<RevisionProposalRecord>;
  review(input: {
    workspaceId: string;
    proposalId: string;
    action: "accept" | "partial_accept" | "reject";
    selectedProposalBlockIds?: string[];
    actorUserId: string;
  }): Promise<RevisionProposalReviewResult>;
  resolveConflict(input: {
    workspaceId: string;
    proposalId: string;
    action: "preserve_both";
    selectedProposalBlockIds: string[];
    actorUserId: string;
    expectedCurrentRevisionNumber: number;
  }): Promise<RevisionProposalReviewResult>;
};
```

- [ ] Write repository tests before implementation: immutable snapshot/diff, list/get workspace isolation, cross-workspace denial, reject terminality, full acceptance appending exactly one revision, partial acceptance, stale conflict with no write, preserve-both resolution, and repeated terminal requests returning the same result.
- [ ] Run `npx vitest run tests/integration/revision-proposal-repository.test.ts`; if `DATABASE_URL` is absent, preserve that exact blocker and still verify the intended import/compile RED separately.
- [ ] Add `0010_revision_proposals.sql` with workspace/document FKs, status/support/action checks, JSONB snapshots/diff/source, reviewer fields, current-conflict snapshot, unique `(workspace_id, id)`, indexes for document/status, a unique accepted effect key, and a trigger rejecting updates to immutable snapshot columns.
- [ ] Implement schema metadata and repository mapping/validation.
- [ ] Serialize review with a proposal row lock. Full/partial acceptance must check the current document revision against `base_revision_number`, append one library revision, and update proposal review metadata in one SQL transaction. If current revision differs, write only conflict metadata.
- [ ] Make repeated accepted/rejected/conflicted decisions idempotent; reject incompatible second decisions with `CONFLICT`.
- [ ] Run repository tests when PostgreSQL exists, then database typecheck.

### Task 3: Principal-Bound Services And App Router Handlers

**Routes:**

```text
GET  /api/documents/:documentId/revision-proposals
POST /api/documents/:documentId/revision-proposals
GET  /api/revision-proposals/:proposalId
POST /api/revision-proposals/:proposalId/review
POST /api/revision-proposals/:proposalId/resolve
```

- [ ] Write handler tests first for unauthenticated access, malformed payloads, create/list/get, workspace denial, accept, partial accept, reject, stale conflict, and preserve-both.
- [ ] Run the focused handler test and confirm the intended RED or explicit database prerequisite.
- [ ] Extend `AuthRuntime` with `revisionProposals`, instantiate it from the shared SQL client, and map repository `WORKSPACE_MISMATCH`, `NOT_FOUND`, `VALIDATION`, `INVALID_TRANSITION`, and `CONFLICT` errors through existing API conventions.
- [ ] Add principal-bound service functions. Creation loads the principal's current/base revision and never trusts body workspace/user identity. Review actions stamp `principal.userId`.
- [ ] Keep handlers thin: parse params/body, call service, return contract-shaped JSON, and pass failures through `jsonError(mapDomainError(error))`.
- [ ] Run handler tests and web typecheck.

### Task 4: Editor Review UI And Browser Workflow

**Client interface:**

```ts
export type RevisionProposalApi = {
  list(documentId: string): Promise<RevisionProposalRecord[]>;
  create(documentId: string, input: CreateRevisionProposalRequest): Promise<RevisionProposalRecord>;
  review(proposalId: string, input: ReviewRevisionProposalRequest): Promise<RevisionProposalReviewResult>;
  resolve(proposalId: string, input: ResolveRevisionProposalRequest): Promise<RevisionProposalReviewResult>;
};
```

- [ ] Write the Playwright test first: create a confirmed note, create a proposal, edit the note concurrently, attempt acceptance, verify conflict/no overwrite, explicitly preserve both, and verify both contents plus immutable revision history.
- [ ] Run Playwright discovery/target and record the intended RED or environment blocker.
- [ ] Add a Zod-parsed API client with structured errors.
- [ ] Build a compact un-nested review panel showing proposal count/status, base revision, source/support state, deterministic diff, selected-block controls, accept/reject, and preserve-both conflict resolution. Include loading, empty, error, retry, pending, and success states. Use accessible labels and at least 40px hit targets.
- [ ] Mount the panel alongside existing editor metadata panels. Manual save remains independently usable during proposal loading/failure.
- [ ] Add focused component/model tests for rendering and decision-state behavior.
- [ ] Run component tests, web typecheck, and Playwright target when services are available.

### Task 5: Verification, Review Input, And Progress Record

- [ ] Run focused Vitest tests for contracts/domain/UI and database/handler suites where PostgreSQL is available.
- [ ] Run `npm run typecheck -w @aistudy/contracts`, `npm run typecheck -w @aistudy/domain`, `npm run typecheck -w @aistudy/database`, and `npm run typecheck -w @aistudy/web`.
- [ ] Run targeted ESLint on every changed TypeScript/TSX file, `git diff --check`, migration-list validation, and Playwright discovery.
- [ ] Attempt the relevant repository wrapper tests/build; distinguish host/service blockers from code failures.
- [ ] Run `graphify update .` exactly once after the coherent slice.
- [ ] Update `README.md`, `docs/plans/2026-07-21-lifelong-learning-implementation.md`, and `docs/plans/2026-07-24-phase1-tasks-9-30-superpowers-plan.md` with a dated execution status that lists passed and blocked gates. Keep Task 17 as next.
- [ ] Complete the Execution Record below. Do not claim unrun database/browser gates passed.

## Acceptance Checklist

- [ ] A proposal captures immutable base/proposed snapshots, deterministic diff, provenance, and support state.
- [ ] Every operation is principal/workspace-bound.
- [ ] Full and partial accept append one new document revision and never mutate history.
- [ ] A stale proposal cannot overwrite a concurrent edit.
- [ ] Explicit preserve-both resolution retains current content and selected proposal content.
- [ ] Reject and terminal repeats are auditable and idempotent.
- [ ] The editor's manual save path remains usable if proposal services fail.
- [ ] Progress reporting separates verified gates from environment blockers.

## Execution Record

- Model: `tokenfree-gpt/gpt-5.6-luna` requested on 2026-08-05.
- Implementation status: core Task 16 contracts, pure domain helpers, migration, repository, principal-bound routes/services, typed client, editor review panel, and focused tests are present in the working tree. No commit or destructive git operation was performed.
- RED evidence: `npx vitest run packages/domain/src/revisions/proposals.test.ts packages/contracts/src/revision-proposal.test.ts` initially failed with two expected `Cannot find module` errors for the not-yet-created domain/contracts modules.
- GREEN evidence: the same focused tests later passed: 2 files, 7 tests. The focused editor/domain/contracts run passed: 3 files, 13 tests. The executable review-panel test subsequently passed together with domain/contracts: 3 files, 8 tests.
- Type/lint/build evidence: `npm run typecheck -w @aistudy/contracts`, `npm run typecheck -w @aistudy/domain`, `npm run typecheck -w @aistudy/database`, direct `npx tsc -p apps/web/tsconfig.json --noEmit`, and targeted ESLint over changed Task 16 files passed. `git diff --check` completed with only pre-existing CRLF warnings. The workspace wrapper web typecheck was blocked by missing Windows `flock` in `scripts/run-heavy.sh`; full build was not run.
- Final repair RED evidence: after adding `repeats an accepted decision idempotently after the target document is soft-deleted`, `npx vitest run tests/integration/revision-proposal-repository.test.ts` failed at the explicit `DATABASE_URL is required` guard; the test could not reach PostgreSQL in this environment.
- Final repair implementation: `mapResult()` now catches only same-workspace `NOT_FOUND` from the live document lookup, verifies the target workspace with a second query, and returns the terminal proposal with `document: null`; workspace mismatches and unexpected SQL errors still propagate.
- Final repair GREEN-adjacent evidence: focused non-DB tests passed (`3 files, 12 tests`), `npm run typecheck -w @aistudy/contracts`, `npm run typecheck -w @aistudy/domain`, and `npm run typecheck -w @aistudy/database` passed, changed-file ESLint passed, Playwright discovery found 1 test, and `npx tsc -p tsconfig.e2e.json --noEmit` passed. The database regression and handler suites remain service-gated by missing `DATABASE_URL`.
- Database/browser blockers: repository and handler integration tests were attempted and blocked immediately because `DATABASE_URL` is unset. Playwright discovery passed for `tests/e2e/ai-note-revision.spec.ts` (1 test); the expanded browser flow was not run because PostgreSQL/web services are unavailable. The web workspace typecheck was attempted and blocked by missing Windows `flock` in `scripts/run-heavy.sh`. `git diff --check` completed with only pre-existing CRLF warnings.
- Files changed: Task 16 repository and tests were strengthened; README and current Task 16 progress records were updated only after the fresh focused verification. Existing dirty Task 14/15 files were preserved; no commit/reset/checkout/clean/stash was performed.
- Final concurrency/migration repair RED attempt: `npx vitest run --project integration tests/integration/revision-proposal-repository.test.ts` was blocked during collection by the explicit `DATABASE_URL is required` guard; no PostgreSQL result is claimed.
- Final concurrency/migration repair implementation: `create()` now uses `sql.begin`, locks the current workspace document with `SELECT ... FOR UPDATE`, then reads blocks and inserts the proposal through the transaction client. The repository integration assertion now requires the stored base revision, title, and blocks to equal the known current snapshot. Migration `0010_revision_proposals.sql` and Drizzle metadata now define the partial unique `(workspace_id, document_id, resulting_revision_number)` index.
- Final concurrency/migration repair non-DB evidence: domain/contracts focused tests passed (`2 files, 10 tests`), database/domain/contracts typechecks passed, changed-file ESLint passed, migration loader listed `0010_revision_proposals.sql` in contiguous order, and `git diff --check` emitted only existing line-ending warnings.
- Unresolved concerns: PostgreSQL-backed repository/handler behavior and the browser workflow remain unverified until `DATABASE_URL`, PostgreSQL, and web services are available. Full build was not run.
- Review repair RED evidence: the new domain regression test initially failed because `assertNonEmptyRevisionBlocks` was not yet exported, confirming the missing guard; the repository integration test was also attempted and stopped at its explicit unset `DATABASE_URL` guard.
- Review repair implementation: exported the pure non-empty revision-block invariant, revised the incorrect removal-only integration expectation to require `VALIDATION` plus unchanged document/proposal state, and applied the invariant centrally before every proposal revision append path.
- Review repair GREEN evidence: `npx vitest run packages/domain/src/revisions/proposals.test.ts packages/contracts/src/revision-proposal.test.ts apps/web/src/features/revision-review/revision-review-panel.test.ts` passed with 3 files and 13 tests; domain/contracts/database typechecks, direct web/e2e TypeScript checks, targeted ESLint, `git diff --check`, and `graphify update .` completed. Repository and handler database suites remain blocked by missing `DATABASE_URL`; integration is not marked passed.
