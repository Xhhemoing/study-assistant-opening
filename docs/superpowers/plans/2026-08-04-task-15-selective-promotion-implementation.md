# Task 15 Selective Promotion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development and superpowers:test-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist, review, accept, edit, reject, and trace individual exploration candidates without promoting an entire exploration or duplicating a promoted note across courses.

**Architecture:** A `promotion_records` row is a workspace-bound immutable source snapshot of one exploration candidate and its review state. Accepting a note atomically creates one confirmed library document and records that document as the promotion target; accepting a card, question, or task records a typed formal target placeholder with provenance but does not impersonate unavailable card/task engines. Existing course membership points to the resulting note document, so several courses share one stable asset. The API is principal-bound and the review UI consumes typed endpoints.

**Tech Stack:** TypeScript, PostgreSQL migrations and `postgres`, Drizzle metadata, Zod, Next.js route handlers, React, Tailwind CSS, Vitest, Playwright.

## Global Constraints

- Preserve all existing uncommitted Task 14 files and do not commit this slice.
- Use migration number `0009_promotions.sql`; do not alter migrations `0001` through `0008`.
- Every promotion read/write is bound to `workspaceId`; source exploration and target document must belong to that same workspace.
- A promotion stores one candidate snapshot and status. It must never confirm, copy, or change other candidates from its exploration.
- Only a note promotion creates a `library_documents` record. Its lifecycle is `confirmed`, it has a single `paragraph` block containing the candidate body, and it retains a `derived_from` relation to the source exploration through promotion provenance rather than a copied exploration document.
- Card, question, and task acceptance must retain their own typed formal target records; do not create fake notes or claim that later practice/task systems exist.
- Rejecting is terminal; accepting an already accepted/rejected promotion is idempotent and returns the original record without replacing its target.
- UI uses Tailwind utilities and lucide icons only. Keep the existing mock candidate panel untouched; add the real review route/component separately.
- Follow TDD. Do not add provider calls, background queues, browser-only local persistence, or direct writes to confirmed assets outside the promotion repository.

## File Map

- Create `packages/contracts/src/promotions.ts`: candidate, creation, review, and response schemas.
- Modify `packages/contracts/src/index.ts`: export promotion contracts.
- Create `packages/database/src/schema/promotions.ts`: Drizzle metadata for promotion records and typed non-document targets.
- Create `packages/database/src/migrations/0009_promotions.sql`: append-only tables, constraints, workspace indexes, target uniqueness, and status guard.
- Create `packages/database/src/repositories/promotions.ts`: workspace-bound create/list/get/accept/reject operations.
- Modify `packages/database/src/index.ts`: export schema and promotion repository APIs.
- Modify `apps/web/src/features/auth/service.ts`: add promotion runtime/service functions and domain-error mapping.
- Create `apps/web/src/app/api/explorations/[id]/promotions/route.ts`: create/list one exploration's promotions.
- Create `apps/web/src/app/api/promotions/[id]/accept/route.ts` and `reject/route.ts`: principal-bound review decisions.
- Create `apps/web/src/features/promotion-review/promotion-api.ts` and `promotion-review.tsx`: typed client and review surface.
- Create `apps/web/src/app/(workspace)/explore/[id]/promotions/page.tsx`: route for real review.
- Create `tests/integration/promotion-repository.test.ts`, `tests/integration/handler/promotions.test.ts`, and `tests/e2e/exploration-promotion.spec.ts`.

### Task 1: Promotion contracts and repository RED tests

**Interfaces:**

- `promotionCandidateKindSchema = z.enum(["note", "card", "question", "task"])`.
- `promotionStatusSchema = z.enum(["pending", "accepted", "rejected"])`.
- `createPromotionRequestSchema` accepts `{ kind, title, body, sourceTurnId?: uuid|null }`.
- `PromotionRecord` includes `id`, `workspaceId`, `explorationId`, nullable `sourceTurnId`, kind, title, body, status, nullable `targetType`, nullable `targetId`, `reviewedAt`, and timestamps.
- `PromotionRepository.create({ workspaceId, explorationId, sourceTurnId?, kind, title, body }): Promise<PromotionRecord>`.
- `accept({ workspaceId, promotionId }): Promise<PromotionRecord>` and `reject({ workspaceId, promotionId }): Promise<PromotionRecord>` are terminal/idempotent.

- [ ] Write integration tests that create two candidates from one exploration, accept one note, reject another, and prove that the rejected/pending row is unchanged.
- [ ] Run `npx vitest run tests/integration/promotion-repository.test.ts` and observe the missing repository/migration failure or the explicit `DATABASE_URL` gate.
- [ ] Add contract schemas, migration `0009_promotions.sql`, Drizzle metadata, and a repository which first verifies workspace and exploration membership before every mutation.
- [ ] Add target uniqueness and status checks. Map cross-workspace promotion/exploration access to `WORKSPACE_MISMATCH` and missing records to `NOT_FOUND`.

### Task 2: Atomic note materialization and typed targets

**Interfaces:**

- `accept` uses one SQL transaction.
- A note creates exactly one `library_documents` record with lifecycle `confirmed`, a generated `paragraph` block, revision 1, and `promotion_records.target_type = "document"`.
- A card/question/task creates one `promotion_targets` row with its own type and immutable candidate content; `target_type` matches the candidate kind and `target_id` is stable.
- Repeating `accept` returns the same target and cannot create another document/target.

- [ ] Add RED tests for note source provenance, stable target on repeated accept, separate typed card target, and one note added to two courses with a shared `documentId`.
- [ ] Implement the transaction using existing library document/revision/block SQL conventions and existing course membership repository for the two-course invariant.
- [ ] Run the focused integration test when PostgreSQL is available; otherwise run database/contracts typechecks and retain the explicit external-service blocker.

### Task 3: Principal-bound API and review UI

**Interfaces:**

- `createPromotionForPrincipal(runtime, principal, explorationId, body)` and list/accept/reject functions always use `principal.workspaceId`.
- Routes return `{ promotions }` or `{ promotion }`, parse Zod bodies, use `requirePrincipal`, and pass errors through `jsonError(mapDomainError(error))`.
- `PromotionApi.list(explorationId)`, `.create(explorationId, input)`, `.accept(id)`, and `.reject(id)` parse contract responses and throw structured errors.
- The review screen can create a candidate, show each candidate's pending/accepted/rejected state, accept/reject only pending records, link accepted note targets to their document route, and show source-exploration provenance.

- [ ] Write handler tests for authentication, invalid payloads, workspace denial, independent candidate decisions, and idempotent terminal requests.
- [ ] Write the Playwright flow: create an exploration, create two note candidates, accept one, edit the resulting document, add it to two courses, reject the other, and confirm the exploration still contains distinct outcomes.
- [ ] Implement services, routes, typed API client, and compact Tailwind review UI without modifying mock candidate behaviors.
- [ ] Run targeted handler/component tests and browser test when a database/browser server is available; otherwise record those prerequisites separately.

### Task 4: Verification and progress record

- [ ] Run focused tests, contracts/database/web/e2e TypeScript checks, targeted ESLint, `git diff --check`, and `graphify update .`.
- [ ] Independently review the complete diff for bulk-exploration promotion, workspace leaks, duplicate target creation, lifecycle bypass, fake card/task notes, and accidental changes to Task 14 files.
- [ ] Update README and the authoritative implementation plan only with fresh verification evidence; set Task 16 as the next implementation feature.

## Acceptance Checklist

- [ ] One candidate is accepted or rejected without changing its siblings.
- [ ] An accepted note is a confirmed, editable document with source provenance.
- [ ] The same promoted note can be a member of two courses without duplication.
- [ ] Card/question/task targets preserve their type and provenance without claiming unsupported practice/task behavior.
- [ ] Every route and repository action is workspace-bound.
- [ ] Review states are terminal and idempotent.
