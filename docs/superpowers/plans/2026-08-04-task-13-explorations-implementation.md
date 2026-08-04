# Task 13 Explorations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist goal-free, workspace-scoped explorations with branches, scratch blocks, hypotheses, open questions, and explicit close/resume transitions, then expose the smallest real Explore workflow in the web app.

**Architecture:** PostgreSQL is the source of truth. An exploration belongs to one workspace and may optionally reference a course and goal; creating an exploration also creates one root branch. Branches reference their parent branch but never copy parent blocks. Scratch content is represented as append-oriented exploration blocks with a constrained kind (`scratch`, `hypothesis`, `open_question`). The web API is principal-bound and the Explore UI consumes the typed API; AI chat, provider calls, promotion candidates, and card creation remain outside this slice and are left to Tasks 14–15/23.

**Tech Stack:** TypeScript, Next.js App Router route handlers, Zod contracts, PostgreSQL via `postgres`, Drizzle schema metadata, Vitest, Playwright, Tailwind CSS utilities, `lucide-react`.

## Global Constraints

- Preserve all existing dirty user changes; never reset, checkout, stash, clean, or revert unrelated files.
- Use the next contiguous migration number currently available: `0008_explorations.sql`; do not reuse the historical plan's `0003` or any already-used migration number.
- Keep migration history append-only; do not modify `0001_library.sql` through `0007_search_indexes.sql`.
- All repository reads, writes, and status transitions require `workspaceId`; never trust a client-supplied workspace identifier.
- Use TDD: write each behavior test, run it and observe the expected failure, then implement the smallest production change.
- Use existing `requirePrincipal`, `jsonError`, and `mapDomainError` authorization/error patterns.
- Keep changed UI in Tailwind utilities only; do not add CSS files or inline styles.
- Do not implement AI provider jobs, vector search, promotion, cards, or persistent learning goals in this slice.
- Do not create a git commit; the working tree contains unrelated user changes and the coordinator will review the final diff.

## File Map

- Create `packages/database/src/schema/explorations.ts`: table metadata and row types for explorations, branches, and blocks.
- Create `packages/database/src/migrations/0008_explorations.sql`: append-only PostgreSQL schema, constraints, indexes, and updated-at trigger behavior where needed.
- Create `packages/database/src/repositories/explorations.ts`: workspace-bound repository and explicit status-transition errors.
- Modify `packages/database/src/index.ts`: export the schema, repository factory, errors, and public record types.
- Modify `packages/contracts/src/exploration.ts`: preserve existing mock conversation contracts while adding persisted exploration, branch, block, request, detail, and response schemas.
- Modify `packages/contracts/src/index.ts`: export the new exploration schemas and types.
- Create `apps/web/src/features/exploration/exploration-api.ts`: typed browser API client for list/create/detail/branch/block/status operations.
- Create `apps/web/src/features/exploration/exploration-workspace.tsx`: real persisted Explore list and detail workflow, including close/resume, branch creation, and block capture.
- Modify `apps/web/src/app/(workspace)/explore/page.tsx`: render the persisted exploration workspace.
- Modify `apps/web/src/app/(workspace)/explore/[id]/page.tsx`: render the persisted exploration detail view.
- Create `apps/web/src/app/api/explorations/route.ts`: authenticated list and create handlers.
- Create `apps/web/src/app/api/explorations/[id]/route.ts`: authenticated detail handler.
- Create `apps/web/src/app/api/explorations/[id]/branches/route.ts`: authenticated branch creation handler.
- Create `apps/web/src/app/api/explorations/[id]/blocks/route.ts`: authenticated block creation handler.
- Create `apps/web/src/app/api/explorations/[id]/status/route.ts`: authenticated close/resume handler.
- Modify `apps/web/src/features/auth/service.ts`: add the exploration repository to `AuthRuntime`, map repository errors, and add principal-bound service functions.
- Create `tests/integration/exploration-repository.test.ts`: PostgreSQL repository, migration, lifecycle, branch, block, and workspace-isolation coverage.
- Create `tests/integration/handler/explorations.test.ts`: authenticated handler contract and authorization coverage using the existing runtime injection pattern.
- Create `tests/e2e/free-exploration.spec.ts`: browser flow for create, add content, branch, close/resume, and cross-user denial.
- Modify `tests/integration/identity-migration-compatibility.test.ts` only where fixed applied-migration expectations must include `0008_explorations.sql`.

---

### Task 1: Contracts and Schema RED tests

**Files:**
- Modify: `packages/contracts/src/exploration.ts`
- Modify: `packages/contracts/src/exploration.test.ts` if present; otherwise create it beside the contract
- Create: `packages/database/src/schema/explorations.ts`
- Create: `packages/database/src/migrations/0008_explorations.sql`
- Test: `tests/integration/migration-order.test.ts` or the closest existing migration-list test only if a deterministic file-list assertion needs updating

**Interfaces:**
- `explorationStatusSchema`: `z.enum(["open", "closed"])`.
- `explorationBlockKindSchema`: `z.enum(["scratch", "hypothesis", "open_question"])`.
- Persisted `Exploration` keeps `id`, `ownerUserId`, `title`, `status`, `createdAt`, `updatedAt`, and adds `workspaceId`, nullable `courseId`, nullable `goalId`, and nullable `closedAt`.
- `ExplorationBranch`: `{ id, explorationId, parentBranchId: string | null, title, createdAt }`.
- `ExplorationBlock`: `{ id, explorationId, branchId, kind, content, position, createdAt, updatedAt }`.
- Request schemas: create exploration `{ title, courseId?: uuid|null, goalId?: uuid|null }`; create branch `{ title, parentBranchId?: uuid|null }`; create block `{ branchId: uuid, kind, content, position?: int }`; status `{ status: "open"|"closed" }`.
- Detail response contains `{ exploration, branches, blocks }`; list response contains `{ explorations }`.

- [ ] Write contract tests before changing implementation. Assert that an exploration without course/goal parses, all three block kinds parse, closed records require no content duplication, and invalid kinds/blank titles/oversized content fail.
- [ ] Run the focused contract test and confirm it fails because the new schemas/types are absent or incomplete.
- [ ] Add the schemas/types while preserving `AIRole`, `ChatTurn`, and `PromotionCandidate` for existing mock UI tests.
- [ ] Run focused contract tests and the contracts TypeScript check.

### Task 2: Database migration and repository RED tests

**Files:**
- Create: `packages/database/src/schema/explorations.ts`
- Create: `packages/database/src/migrations/0008_explorations.sql`
- Create: `packages/database/src/repositories/explorations.ts`
- Modify: `packages/database/src/index.ts`
- Test: `tests/integration/exploration-repository.test.ts`

**Interfaces:**
- `createExplorationRepository(sql: Sql): ExplorationRepository`.
- `ExplorationRepository.createExploration({ workspaceId, ownerUserId, title, courseId?, goalId?, explorationId? }): Promise<ExplorationRecord>`; creation also returns or atomically creates the root branch, exposed as `rootBranch` in the returned record or through `getExploration`.
- `listExplorations({ workspaceId }): Promise<ExplorationRecord[]>`.
- `getExploration({ workspaceId, explorationId }): Promise<ExplorationDetailRecord>`.
- `createBranch({ workspaceId, explorationId, parentBranchId?, title, branchId? }): Promise<ExplorationBranchRecord>`.
- `createBlock({ workspaceId, explorationId, branchId, kind, content, position?, blockId? }): Promise<ExplorationBlockRecord>`.
- `setStatus({ workspaceId, explorationId, status }): Promise<ExplorationRecord>`.
- Repository error codes include `NOT_FOUND`, `VALIDATION`, `WORKSPACE_MISMATCH`, `INVALID_TRANSITION`, and `CONFLICT`.

- [ ] Write integration tests for: creating with null course/goal; root branch identity; block insertion for scratch/hypothesis/open-question; branch parent reference without copied blocks; close then resume; rejection of invalid transitions or blank content; and workspace B unable to list/get/mutate workspace A data.
- [ ] Run `npm run test:integration -- exploration-repository` and confirm the expected environment-gated failure or RED failure. Do not hide a missing `DATABASE_URL`; report it accurately.
- [ ] Add schema metadata matching existing `pgTable` conventions. Use workspace and exploration foreign keys with cascade deletion, a nullable course FK only if the existing course table is available and same-workspace validation remains in the repository, and no fake goal FK because persistent goals do not yet exist.
- [ ] Add migration `0008_explorations.sql` with tables, UUID primary keys, workspace indexes, branch parent index, block ordering index, check constraints for status/kind/nonblank content, and an updated-at trigger or explicit update statement consistent with the repository's existing SQL style.
- [ ] Implement repository validation and workspace-bound queries. Verify referenced course belongs to the requested workspace when supplied. Verify branch belongs to the exploration and workspace before adding blocks or child branches. Ensure `getExploration` never returns another workspace's data.
- [ ] Run repository tests with PostgreSQL when `DATABASE_URL` is available; otherwise run typechecks and preserve the explicit integration blocker.

### Task 3: Principal-bound service and API RED tests

**Files:**
- Modify: `apps/web/src/features/auth/service.ts`
- Modify: `apps/web/src/server/runtime.ts` only if the existing test runtime shape needs an explicit repository field
- Create: `apps/web/src/app/api/explorations/route.ts`
- Create: `apps/web/src/app/api/explorations/[id]/route.ts`
- Create: `apps/web/src/app/api/explorations/[id]/branches/route.ts`
- Create: `apps/web/src/app/api/explorations/[id]/blocks/route.ts`
- Create: `apps/web/src/app/api/explorations/[id]/status/route.ts`
- Create: `tests/integration/handler/explorations.test.ts`

**Interfaces:**
- Extend `AuthRuntime` with `explorations: ExplorationRepository`.
- `listExplorationsForPrincipal(runtime, principal)` uses `principal.workspaceId`.
- `createExplorationForPrincipal(runtime, principal, body)` uses `principal.userId` and ignores any client workspace ID.
- `getExplorationForPrincipal`, `createExplorationBranchForPrincipal`, `createExplorationBlockForPrincipal`, and `setExplorationStatusForPrincipal` all bind `principal.workspaceId`.
- Route responses use `{ explorations }`, `{ exploration }`, `{ exploration, branches, blocks }`, `{ branch }`, `{ block }`, and `{ exploration }` respectively.

- [ ] Write handler tests for unauthenticated requests, invalid body/query, create/list/detail success, workspace denial, branch/block creation, and close/resume.
- [ ] Run the focused handler test and confirm it fails because the runtime/repository/routes do not exist.
- [ ] Add `createExplorationRepository(sql)` in `createAuthRuntime`, map `ExplorationRepositoryError` to the existing API error codes, and use `requirePrincipal` plus Zod parsing in each route.
- [ ] Keep route handlers thin: parse URL params, call the service, return typed JSON, and map errors through `jsonError(mapDomainError(error))`.
- [ ] Run the focused handler test and web TypeScript check.

### Task 4: Persisted Explore UI and browser RED tests

**Files:**
- Create: `apps/web/src/features/exploration/exploration-api.ts`
- Create: `apps/web/src/features/exploration/exploration-workspace.tsx`
- Modify: `apps/web/src/app/(workspace)/explore/page.tsx`
- Modify: `apps/web/src/app/(workspace)/explore/[id]/page.tsx`
- Create: `tests/e2e/free-exploration.spec.ts`

**Interfaces:**
- `ExplorationApi.list()`, `.create(input)`, `.get(id)`, `.createBranch(id,input)`, `.createBlock(id,input)`, `.setStatus(id,status)` return parsed contract values and throw a typed `ExplorationApiError` for structured API failures.
- The page supports: title entry and creation; detail loading; block kind selection; block content submission; branch creation from the current exploration; close/resume; reload persistence; accessible error and retry states.

- [ ] Write the Playwright flow before wiring the UI: register a user, create an exploration with no course/goal, add one hypothesis and one open question, create a branch, close it, resume it, reload, and assert content/state remain. Add a second-user request that receives 403 for the first user's exploration.
- [ ] Run the focused browser test and confirm it fails because the real Explore routes/UI are absent or still mock-only.
- [ ] Implement a small typed API client using `fetch`, `URLSearchParams` only where needed, Zod response parsing, and structured error conversion.
- [ ] Build the UI with Tailwind utilities and lucide icons. Do not embed AI chat or promotion controls in this slice. Show branch ancestry and block kind labels so users can distinguish scratch, hypothesis, and open question content.
- [ ] Update both Explore pages to use the new feature and preserve existing route paths. Keep old mock exploration modules untouched unless a narrow compatibility edit is required by TypeScript.
- [ ] Run the browser test with a configured server/database; if blocked, run focused component/model/unit tests and document the blocker.

### Task 5: Integration, progress record, and final review preparation

**Files:**
- Modify: `tests/integration/identity-migration-compatibility.test.ts` if fixed applied migration arrays require `0008_explorations.sql`.
- Modify: `README.md` with one concise progress entry for Task 13 only after verification evidence is available.
- Modify: `docs/plans/2026-07-24-phase1-tasks-9-30-superpowers-plan.md` by adding a dated execution-status note under Task 13; do not rewrite historical requirements.

- [ ] Run targeted contract tests, repository/handler tests, `npx tsc` for contracts/database/web/e2e, ESLint on all changed TypeScript/TSX files, and `git diff --check`.
- [ ] Run `npm test` or the repository's unit project and record the exact result. Do not claim PostgreSQL or browser gates passed if the environment lacks `DATABASE_URL` or the browser runtime.
- [ ] Run `graphify update .` once after the coherent implementation slice.
- [ ] Review the complete diff for workspace leaks, status-transition bypasses, branch content duplication, unbounded content, route contract mismatches, and accidental edits to unrelated dirty files.
- [ ] Record Task 13 as implemented only with an explicit note of any blocked external-service gates. Keep the next planned item as Task 14; do not mark Phase 1 complete.

## Acceptance Checklist

- [ ] A user can create an exploration with no course and no goal.
- [ ] The exploration and root branch have stable UUID identities.
- [ ] Scratch, hypothesis, and open-question blocks persist and reload.
- [ ] A branch stores its parent branch reference without copying parent blocks.
- [ ] Close and resume are explicit, validated transitions.
- [ ] Every list/get/create/status query is workspace-bound and cross-workspace access is denied.
- [ ] The Explore UI uses the real API and exposes no unsupported AI/promotion claims.
- [ ] Tests and verification commands are recorded with environment blockers separated from code failures.
