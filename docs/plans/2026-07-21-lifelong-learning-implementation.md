# AIstudy Lifelong Learning Platform Implementation Plan

> **For implementer:** Use TDD throughout. Write failing test first. Watch it fail. Then implement. Commit after every green task.

**Goal:** Build the first production-capable AIstudy foundation where target learning, free exploration, and notes/knowledge are equal entry points sharing one asset model, with long-lived courses, multiple goals, time windows, AI-assisted selective promotion, practice, and SRS.

**Architecture:** Use a modular TypeScript monolith with a Next.js web process and a separate worker process. PostgreSQL is the system of record; shared assets have stable workspace-level identities, course membership is relational, learning events are append-only, and assessments/plans are versioned derived projections. AI writes candidates and revision proposals only.

**Tech Stack:** Versions must be pinned by Task 1 after official-documentation spikes. Intended stack: Node.js, TypeScript, Next.js App Router, React, PostgreSQL, Drizzle ORM or validated equivalent, Redis/BullMQ, S3-compatible storage, Zod, Vitest, Testing Library, Playwright.

**Approved design:** `docs/plans/2026-07-21-lifelong-learning-design.md`

---

## Working Rules

- Do not implement a feature that has no acceptance criterion in the approved design.
- Keep `main` deployable; use short branches or atomic commits.
- Every behavior task follows red → green → refactor → commit.
- Domain logic must be pure where possible and must not import UI or infrastructure.
- Shared asset identity, append-only events, and strategy versioning are architectural invariants.
- AI failure must never block manual notes, exploration, practice, or review.
- Do not create separate note models for exploration, courses, and knowledge library.
- Do not introduce microservices, collaborative editing, database views, whiteboards, or full PDF reading in Phase 1.

## Intended Repository Structure

```text
apps/
  web/
  worker/
packages/
  contracts/
  domain/
  database/
  ai/
  config/
  ui/
infra/docker/
tests/
  contract/
  integration/
  e2e/
docs/decisions/
```

---

## Phase 0: Validate the Stack and Scaffold

### Task 1: Pin the Technical Stack With Executable Spikes

**Files:**
- Create: `docs/decisions/ADR-001-stack.md`
- Create: `spikes/web/package.json`
- Create: `spikes/database/package.json`
- Create: `spikes/queue/package.json`
- Create: `spikes/auth/package.json`
- Test: `spikes/**/README.md`

**Step 1: Write the spike acceptance checklist**

Document failing/unverified assumptions for:

- Next.js server rendering and self-hosting;
- session authentication and object-level authorization;
- PostgreSQL migrations, transactions, JSONB, and test isolation;
- BullMQ idempotency and retry behavior;
- S3-compatible signed upload/download;
- Vitest workspace and Playwright execution.

**Step 2: Run each empty spike**

Command: `npm test --workspaces --if-present`  
Expected: FAIL or missing implementation for each required spike.

**Step 3: Implement the smallest executable spike per concern**

Each spike must contain one focused test and no product code.

**Step 4: Run all spikes**

Command: `npm test --workspaces --if-present`  
Expected: PASS.

**Step 5: Write ADR-001**

Record exact versions, official sources, accepted/rejected alternatives, self-hosting constraints, and upgrade policy.

**Step 6: Commit**

```bash
git add docs/decisions spikes
git commit -m "docs: validate and pin the initial platform stack"
```

### Task 2: Create the npm Workspace and Quality Gates

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Create: `tsconfig.base.json`
- Create: `eslint.config.mjs`
- Create: `vitest.workspace.ts`
- Create: `apps/web/package.json`
- Create: `apps/worker/package.json`
- Create: `packages/contracts/package.json`
- Create: `packages/domain/package.json`
- Create: `packages/database/package.json`
- Create: `packages/ai/package.json`
- Create: `packages/config/package.json`
- Create: `packages/ui/package.json`
- Test: `packages/domain/src/smoke.test.ts`

**Step 1: Write a failing workspace smoke test**

Test importing a symbol from `@aistudy/domain` through workspace resolution.

**Step 2: Run the test**

Command: `npm test`  
Expected: FAIL because workspace configuration and package do not exist.

**Step 3: Implement the minimal workspace**

Add scripts:

```json
{
  "dev": "...",
  "worker:dev": "...",
  "lint": "...",
  "typecheck": "...",
  "test": "...",
  "test:integration": "...",
  "test:e2e": "...",
  "build": "..."
}
```

Use exact commands validated by Task 1.

**Step 4: Verify quality gates**

Command: `npm run lint && npm run typecheck && npm test && npm run build`  
Expected: PASS.

**Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.base.json eslint.config.mjs vitest.workspace.ts apps packages
git commit -m "chore: scaffold the AIstudy workspace"
```

### Task 3: Create Local Infrastructure and Health Checks

**Files:**
- Create: `infra/docker/compose.yml`
- Create: `.env.example`
- Modify: `.gitignore`
- Create: `packages/config/src/env.ts`
- Test: `packages/config/src/env.test.ts`
- Create: `apps/web/src/app/api/health/route.ts`
- Test: `tests/integration/health.test.ts`

**Step 1: Write failing environment and health tests**

Require validated DB, Redis, storage, and public base URL variables. Health response must report each dependency without leaking secrets.

**Step 2: Run tests**

Command: `npm test -- packages/config/src/env.test.ts tests/integration/health.test.ts`  
Expected: FAIL.

**Step 3: Implement Compose, env parsing, and health endpoint**

Services: PostgreSQL, Redis, S3-compatible object storage.

**Step 4: Verify**

```bash
npm run compose:up
npm run db:migrate
npm run test:integration -- health
npm run compose:down
```

Expected: PASS; stopped and restarted services retain test data.

**Step 5: Commit**

```bash
git add infra .env.example .gitignore packages/config apps/web/src/app/api/health tests/integration/health.test.ts
git commit -m "chore: add local platform infrastructure"
```

### Task 4: Add Continuous Integration

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `docs/operations/ci.md`

**Step 1: Add a CI contract test**

Use a local workflow validator or a script that asserts required jobs and commands.

**Step 2: Run it before workflow creation**

Expected: FAIL because CI workflow is absent.

**Step 3: Implement CI**

Jobs: install, lint, typecheck, unit, integration, build. Use isolated service containers and no production secrets.

**Step 4: Verify locally**

Command: `npm run verify:ci`  
Expected: PASS.

**Step 5: Commit**

```bash
git add .github docs/operations/ci.md package.json
git commit -m "ci: enforce platform quality gates"
```

---

## Phase 1: Establish the Unified Asset Foundation

### Task 5: Define Workspace and Asset Contracts

**Files:**
- Create: `packages/contracts/src/workspace.ts`
- Create: `packages/contracts/src/assets.ts`
- Test: `packages/contracts/src/assets.test.ts`

**Step 1: Write failing contract tests**

Cover:

- workspace-level stable IDs;
- lifecycle: scratch/candidate/confirmed/published/archived/discarded;
- asset types: source/document/block/card/practice-item/artifact;
- schema version and timestamps;
- invalid lifecycle transitions.

**Step 2: Run test**

Command: `npm test -- packages/contracts/src/assets.test.ts`  
Expected: FAIL because schemas are missing.

**Step 3: Implement minimal Zod schemas and inferred types**

Do not add course-specific IDs to the asset identity.

**Step 4: Run test**

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/contracts/src/workspace.ts packages/contracts/src/assets.ts packages/contracts/src/assets.test.ts
git commit -m "feat: define unified workspace asset contracts"
```

### Task 6: Create Document, Block, Relation, Property, and Revision Schemas

**Files:**
- Create: `packages/database/src/schema/library.ts`
- Create: `packages/database/src/migrations/0001_library.sql`
- Create: `packages/database/src/repositories/library.ts`
- Test: `tests/integration/library-repository.test.ts`

**Step 1: Write failing integration tests**

Test:

- create a document with blocks;
- stable block IDs across edits;
- create relation between blocks/documents;
- attach typed properties;
- update through a new revision;
- soft-delete and restore;
- reject cross-workspace references.

**Step 2: Run test**

Command: `npm run test:integration -- library-repository`  
Expected: FAIL due to missing schema/repository.

**Step 3: Implement minimal schema and repository**

Keep revisions append-only. Current document state can be a projection but revisions remain recoverable.

**Step 4: Run test and migration round-trip**

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/database/src/schema/library.ts packages/database/src/migrations/0001_library.sql packages/database/src/repositories/library.ts tests/integration/library-repository.test.ts
git commit -m "feat: persist versioned documents and knowledge relations"
```

### Task 7: Prove Asset Uniqueness Across Courses

**Files:**
- Create: `packages/database/src/schema/courses.ts`
- Create: `packages/database/src/migrations/0002_courses.sql`
- Create: `packages/database/src/repositories/course-membership.ts`
- Test: `tests/integration/course-asset-identity.test.ts`

**Step 1: Write the failing architectural invariant test**

Scenario:

1. Create one document.
2. Add it to Course A and Course B.
3. Edit it through Course A.
4. Verify Course B sees the same updated asset.
5. Remove it from Course A.
6. Verify the asset and Course B membership remain.

**Step 2: Run test**

Expected: FAIL.

**Step 3: Implement Course and AssetMembership**

Membership carries course-specific role/order/visibility, never copied document content.

**Step 4: Run test**

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/database/src/schema/courses.ts packages/database/src/migrations/0002_courses.sql packages/database/src/repositories/course-membership.ts tests/integration/course-asset-identity.test.ts
git commit -m "feat: share stable assets across long-lived courses"
```

### Task 8: Add Authentication and Workspace Authorization

**Files:**
- Create: `packages/database/src/schema/identity.ts`
- Create: `apps/web/src/features/auth/`
- Create: `apps/web/src/lib/authorization.ts`
- Test: `tests/integration/workspace-authorization.test.ts`
- Test: `tests/e2e/auth.spec.ts`

**Step 1: Write failing authorization tests**

Verify user A cannot read or mutate user B's workspace, assets, courses, or revisions through direct API access.

**Step 2: Run tests**

Expected: FAIL.

**Step 3: Implement the validated auth library and server-side authorization**

Do not rely on hidden UI controls.

**Step 4: Run integration and E2E tests**

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/database/src/schema/identity.ts apps/web/src/features/auth apps/web/src/lib/authorization.ts tests/integration/workspace-authorization.test.ts tests/e2e/auth.spec.ts
git commit -m "feat: secure personal learning workspaces"
```

---

## Phase 2: Deliver Equal Navigation and Strong Notes

### Task 9: Build the Three-Entry Application Shell

**Files:**
- Create: `apps/web/src/app/(workspace)/layout.tsx`
- Create: `apps/web/src/app/(workspace)/learn/page.tsx`
- Create: `apps/web/src/app/(workspace)/explore/page.tsx`
- Create: `apps/web/src/app/(workspace)/library/page.tsx`
- Create: `packages/ui/src/workspace-navigation.tsx`
- Test: `packages/ui/src/workspace-navigation.test.tsx`
- Test: `tests/e2e/workspace-navigation.spec.ts`

**Step 1: Write failing component and E2E tests**

Require three equally prominent entries, keyboard navigation, remembered default entry, and mobile bottom navigation.

**Step 2: Run tests**

Expected: FAIL.

**Step 3: Implement the shell**

Do not place Learn as an unavoidable root redirect after the user selects another default.

**Step 4: Verify**

Command: `npm test -- workspace-navigation && npm run test:e2e -- workspace-navigation`  
Expected: PASS at 320, 768, and 1440 px.

**Step 5: Commit**

```bash
git add apps/web/src/app/'(workspace)' packages/ui/src/workspace-navigation.tsx packages/ui/src/workspace-navigation.test.tsx tests/e2e/workspace-navigation.spec.ts
git commit -m "feat: add equal learning exploration and library navigation"
```

### Task 10: Build the Versioned Block Editor Core

**Files:**
- Create: `apps/web/src/features/editor/`
- Create: `packages/domain/src/documents/commands.ts`
- Test: `packages/domain/src/documents/commands.test.ts`
- Test: `tests/e2e/document-editor.spec.ts`

**Step 1: Write failing tests**

Cover creation/editing for heading, paragraph, list, quote, code, math, table, media, and stable block IDs. Test undo and saved revision history.

**Step 2: Run tests**

Expected: FAIL.

**Step 3: Implement the smallest editor supporting approved block types**

Use the validated editor library from Task 1; persist through revision commands, not direct row mutation.

**Step 4: Run tests**

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/web/src/features/editor packages/domain/src/documents tests/e2e/document-editor.spec.ts
git commit -m "feat: add the versioned block note editor"
```

### Task 11: Add Backlinks, Block References, Embeds, Tags, and Properties

**Files:**
- Create: `packages/domain/src/relations/`
- Create: `apps/web/src/features/knowledge-links/`
- Test: `packages/domain/src/relations/relations.test.ts`
- Test: `tests/e2e/knowledge-links.spec.ts`

**Step 1: Write failing tests**

Cover:

- document backlink;
- block reference;
- transclusion/embed without content duplication;
- tag/property query;
- broken-link display after soft deletion;
- restore or replace referenced block.

**Step 2: Run tests**

Expected: FAIL.

**Step 3: Implement relations and UI**

Embeds render referenced data and source identity; they must not copy block text into the host document.

**Step 4: Run tests**

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/domain/src/relations apps/web/src/features/knowledge-links tests/e2e/knowledge-links.spec.ts
git commit -m "feat: connect notes with backlinks and block embeds"
```

### Task 12: Add Global Search and Command Palette

**Files:**
- Create: `packages/domain/src/search/`
- Create: `apps/web/src/features/search/`
- Create: `apps/web/src/features/command-palette/`
- Test: `tests/integration/search.test.ts`
- Test: `tests/e2e/command-palette.spec.ts`

**Step 1: Write failing tests**

Search across documents, blocks, sources, cards, explorations, courses, and artifacts. Results must show type, lifecycle, course memberships, and source state.

**Step 2: Run tests**

Expected: FAIL.

**Step 3: Implement PostgreSQL full-text baseline and command palette**

Vector search is not required for this task.

**Step 4: Run tests**

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/domain/src/search apps/web/src/features/search apps/web/src/features/command-palette tests/integration/search.test.ts tests/e2e/command-palette.spec.ts
git commit -m "feat: search and create across the learning workspace"
```

---

## Phase 3: Free Exploration and Selective Promotion

### Task 13: Persist Explorations, Branches, and Scratch Blocks

**Files:**
- Create: `packages/database/src/schema/explorations.ts`
- Create: `packages/database/src/migrations/0003_explorations.sql`
- Create: `packages/contracts/src/exploration.ts`
- Create: `apps/web/src/features/exploration/`
- Test: `tests/integration/exploration-repository.test.ts`
- Test: `tests/e2e/free-exploration.spec.ts`

**Step 1: Write failing tests**

A user with no course and no goal can create an exploration, add scratch blocks, branch a conversation, record hypotheses/open questions, close and resume it.

**Step 2: Run tests**

Expected: FAIL.

**Step 3: Implement exploration persistence and UI**

Course and goal IDs remain optional.

**Step 4: Run tests**

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/database/src/schema/explorations.ts packages/database/src/migrations/0003_explorations.sql packages/contracts/src/exploration.ts apps/web/src/features/exploration tests/integration/exploration-repository.test.ts tests/e2e/free-exploration.spec.ts
git commit -m "feat: support goal-free learning explorations"
```

### Task 14: Define AI Roles and Provider-Neutral Conversation Jobs

**Files:**
- Create: `packages/ai/src/providers/provider.ts`
- Create: `packages/ai/src/roles.ts`
- Create: `packages/contracts/src/ai-jobs.ts`
- Create: `apps/worker/src/jobs/exploration-chat.ts`
- Test: `packages/ai/src/roles.test.ts`
- Test: `tests/integration/exploration-chat-job.test.ts`

**Step 1: Write failing tests**

Test role policy for retriever, explainer, tutor, challenger, editor, examiner, collaborator, and silent assistant. Provider output must be schema-validated and cannot directly mutate confirmed assets.

**Step 2: Run tests**

Expected: FAIL.

**Step 3: Implement role configuration and job contract**

Capture provider, model, prompt policy, selected sources, cost, and provenance.

**Step 4: Run tests**

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/ai/src packages/contracts/src/ai-jobs.ts apps/worker/src/jobs/exploration-chat.ts tests/integration/exploration-chat-job.test.ts
git commit -m "feat: add switchable AI roles for exploration"
```

### Task 15: Add Candidate Promotion to Long-Term Assets

**Files:**
- Create: `packages/database/src/schema/promotions.ts`
- Create: `packages/domain/src/promotions/`
- Create: `apps/web/src/features/promotion-review/`
- Test: `packages/domain/src/promotions/promotions.test.ts`
- Test: `tests/e2e/exploration-promotion.spec.ts`

**Step 1: Write failing cross-entry continuity test**

Scenario:

1. Create an exploration without a course.
2. AI/user proposes two notes, one open question, two cards, one task.
3. Accept one note and one card; edit the note; reject others.
4. Verify confirmed assets retain provenance to the original exploration.
5. Add the note to two courses without duplication.
6. Return from the note to the exploration.

**Step 2: Run tests**

Expected: FAIL.

**Step 3: Implement PromotionRecord and review UI**

Promotion references or creates formal assets; it never marks the entire conversation confirmed.

**Step 4: Run tests**

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/database/src/schema/promotions.ts packages/domain/src/promotions apps/web/src/features/promotion-review tests/e2e/exploration-promotion.spec.ts
git commit -m "feat: selectively promote exploration insights"
```

### Task 16: Add AI Revision Proposals for Notes

**Files:**
- Create: `packages/contracts/src/revision-proposal.ts`
- Create: `packages/domain/src/revisions/proposals.ts`
- Create: `apps/web/src/features/revision-review/`
- Test: `packages/domain/src/revisions/proposals.test.ts`
- Test: `tests/e2e/ai-note-revision.spec.ts`

**Step 1: Write failing tests**

AI proposal must include base revision, proposed blocks, diff, provenance, and support state. A concurrent user edit must produce a conflict, not overwrite the document.

**Step 2: Run tests**

Expected: FAIL.

**Step 3: Implement proposal review and merge**

Support accept, reject, partial accept, and preserve-both conflict resolution.

**Step 4: Run tests**

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/contracts/src/revision-proposal.ts packages/domain/src/revisions apps/web/src/features/revision-review tests/e2e/ai-note-revision.spec.ts
git commit -m "feat: review AI note edits before merging"
```

---

## Phase 4: Long-Lived Courses, Multiple Goals, and Time Windows

### Task 17: Implement Course Requirement Profiles

**Files:**
- Create: `packages/contracts/src/course-requirements.ts`
- Create: `packages/domain/src/courses/requirements.ts`
- Create: `apps/web/src/features/course-settings/`
- Test: `packages/domain/src/courses/requirements.test.ts`

**Step 1: Write failing tests**

Cover memory, mathematical/procedural, language, research/writing, programming/project, and free-exploration profiles. Users can choose a simple preset or disable assessment.

**Step 2: Run tests**

Expected: FAIL.

**Step 3: Implement profile contracts and simplified settings UI**

Full weights remain behind developer settings.

**Step 4: Run tests**

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/contracts/src/course-requirements.ts packages/domain/src/courses apps/web/src/features/course-settings
git commit -m "feat: configure learning requirements per course"
```

### Task 18: Implement Multiple Goals and Time Windows

**Files:**
- Create: `packages/database/src/schema/goals.ts`
- Create: `packages/database/src/migrations/0004_goals.sql`
- Create: `packages/domain/src/goals/effective-requirements.ts`
- Test: `packages/domain/src/goals/effective-requirements.test.ts`
- Test: `tests/integration/multi-goal-course.test.ts`

**Step 1: Write failing tests**

Use one mathematics course with:

- short-term final exam;
- long-term entrance exam;
- interest exploration;
- maintenance goal.

Verify requirements combine by version, time window, and user override while sharing assets/history.

**Step 2: Run tests**

Expected: FAIL.

**Step 3: Implement goals, windows, and deterministic merge order**

```text
course baseline
→ active goal requirements
→ current time-window modifier
→ user override
```

**Step 4: Run tests**

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/database/src/schema/goals.ts packages/database/src/migrations/0004_goals.sql packages/domain/src/goals tests/integration/multi-goal-course.test.ts
git commit -m "feat: combine multiple course goals and time windows"
```

### Task 19: Add Free, Advisory, and Coach Guidance Modes

**Files:**
- Create: `packages/domain/src/guidance/`
- Create: `apps/web/src/features/guidance-settings/`
- Test: `packages/domain/src/guidance/guidance.test.ts`
- Test: `tests/e2e/guidance-modes.spec.ts`

**Step 1: Write failing tests**

- Free: no auto-plan and no blocked features.
- Advisory: suggestions require confirmation.
- Coach: may reorder future tasks inside budget, but cannot mutate history or confirmed knowledge.
- User can reserve protected exploration time.

**Step 2: Run tests**

Expected: FAIL.

**Step 3: Implement mode policy and settings**

Each course may differ; workspace defaults are optional.

**Step 4: Run tests**

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/domain/src/guidance apps/web/src/features/guidance-settings tests/e2e/guidance-modes.spec.ts
git commit -m "feat: make learning guidance independently adjustable"
```

### Task 20: Build Goal and Course Onboarding Without Blocking Exploration

**Files:**
- Create: `apps/web/src/features/onboarding/`
- Test: `tests/e2e/onboarding-paths.spec.ts`

**Step 1: Write failing E2E tests**

Path A: user starts free exploration without course/goal.  
Path B: user creates a course with final-exam goal.  
Path C: user promotes an exploration to a new course.  
Path D: user creates knowledge-only course with no plan.

**Step 2: Run tests**

Expected: FAIL.

**Step 3: Implement optional onboarding paths**

Do not force diagnostic, deadline, or course creation before exploration/library use.

**Step 4: Run tests**

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/web/src/features/onboarding tests/e2e/onboarding-paths.spec.ts
git commit -m "feat: offer goal-driven and free onboarding paths"
```

---

## Phase 5: Practice, SRS, and Target Learning

### Task 21: Add Append-Only Learning Events

**Files:**
- Create: `packages/contracts/src/learning-events.ts`
- Create: `packages/database/src/schema/learning-events.ts`
- Create: `packages/database/src/migrations/0005_learning_events.sql`
- Create: `packages/database/src/repositories/learning-events.ts`
- Test: `tests/integration/learning-event-idempotency.test.ts`

**Step 1: Write failing tests**

Test append, idempotency key, correction event, content version reference, and immutable historical payload.

**Step 2: Run tests**

Expected: FAIL.

**Step 3: Implement event store repository**

No generic unvalidated JSON-only event table; important fields remain typed and payloads are schema-versioned.

**Step 4: Run tests**

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/contracts/src/learning-events.ts packages/database/src/schema/learning-events.ts packages/database/src/migrations/0005_learning_events.sql packages/database/src/repositories/learning-events.ts tests/integration/learning-event-idempotency.test.ts
git commit -m "feat: record immutable personal learning events"
```

### Task 22: Build Practice Player and Attempt Capture

**Files:**
- Create: `apps/web/src/features/practice/`
- Create: `packages/contracts/src/attempts.ts`
- Test: `tests/e2e/practice-player.spec.ts`

**Step 1: Write failing tests**

Cover multiple choice, short answer, and procedural checkpoint task. Capture answer, timing, hints, confidence, and error attribution. Retry must not duplicate an attempt.

**Step 2: Run tests**

Expected: FAIL.

**Step 3: Implement minimal practice player**

Direct-answer viewing is allowed but marks the event as assisted evidence.

**Step 4: Run tests**

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/web/src/features/practice packages/contracts/src/attempts.ts tests/e2e/practice-player.spec.ts
git commit -m "feat: capture contextual practice attempts"
```

### Task 23: Implement Cards and One Personal SRS State

**Files:**
- Create: `packages/database/src/schema/cards.ts`
- Create: `packages/database/src/migrations/0006_cards.sql`
- Create: `packages/domain/src/srs/`
- Create: `apps/web/src/features/review/`
- Test: `packages/domain/src/srs/scheduler.test.ts`
- Test: `tests/integration/card-multi-goal-state.test.ts`

**Step 1: Write failing tests**

The same card belongs to two courses and three goals but has one personal review state. Goals alter priority/deadline, not duplicate scheduling history. Support auto, self-selected, and free review.

**Step 2: Run tests**

Expected: FAIL.

**Step 3: Implement cards, review state, and validated baseline scheduler**

Cards may be excluded from assessment, paused, archived, or maintained until a date.

**Step 4: Run tests**

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/database/src/schema/cards.ts packages/database/src/migrations/0006_cards.sql packages/domain/src/srs apps/web/src/features/review tests/integration/card-multi-goal-state.test.ts
git commit -m "feat: review shared cards with one personal schedule"
```

### Task 24: Derive Contextual Ability Evidence and Concise Status

**Files:**
- Create: `packages/domain/src/assessment/`
- Create: `packages/contracts/src/assessment.ts`
- Test: `packages/domain/src/assessment/assessment.test.ts`

**Step 1: Write failing tests**

Cover recognition, recall, procedure, transfer, expression, timed stability, and retention. Output only stable/usable/weak/untested plus reason codes and actions. Course/goal can disable a slice.

**Step 2: Run tests**

Expected: FAIL.

**Step 3: Implement versioned rule baseline**

Do not implement a global mastery percentage. Same evidence snapshot and model version must reproduce the result.

**Step 4: Run tests**

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/domain/src/assessment packages/contracts/src/assessment.ts
git commit -m "feat: derive contextual learning status from evidence"
```

### Task 25: Build Planner With Conflicting-Goal Options

**Files:**
- Create: `packages/domain/src/planning/`
- Create: `packages/contracts/src/plan.ts`
- Create: `apps/web/src/features/today-plan/`
- Test: `packages/domain/src/planning/planner.test.ts`
- Test: `tests/e2e/today-plan.spec.ts`

**Step 1: Write failing tests**

Planner must:

- honor time budget;
- preserve locked tasks and protected exploration time;
- support final/entrance/maintenance goals;
- show 2–3 options when goals conflict;
- explain every task;
- allow plan disabled;
- never mark plan-external learning as failure.

**Step 2: Run tests**

Expected: FAIL.

**Step 3: Implement deterministic baseline planner and concise UI**

AI optimization is not part of this task.

**Step 4: Run tests**

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/domain/src/planning packages/contracts/src/plan.ts apps/web/src/features/today-plan tests/e2e/today-plan.spec.ts
git commit -m "feat: plan learning without constraining exploration"
```

---

## Phase 6: Portability and First-Phase Completion

### Task 26: Add Markdown Import and Export

**Files:**
- Create: `packages/domain/src/portability/markdown/`
- Test: `packages/domain/src/portability/markdown/roundtrip.test.ts`

**Step 1: Write failing round-trip tests**

Cover headings, lists, code, math, tables, attachments, links, block IDs mapping, tags, and unsupported-feature loss report.

**Step 2: Run tests**

Expected: FAIL.

**Step 3: Implement importer/exporter**

Preserve source files and issue explicit warnings for unsupported semantics.

**Step 4: Run tests**

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/domain/src/portability/markdown
git commit -m "feat: exchange notes through Markdown"
```

### Task 27: Add Anki Projection and Loss Report

**Files:**
- Create: `packages/domain/src/portability/anki/`
- Test: `packages/domain/src/portability/anki/export.test.ts`

**Step 1: Write failing tests**

Export card content, media, tags, source links, and supported scheduling fields. Report loss for course requirements, exploration provenance, relationships, and unsupported review history.

**Step 2: Run tests**

Expected: FAIL.

**Step 3: Implement projection**

Do not describe it as lossless.

**Step 4: Run tests**

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/domain/src/portability/anki
git commit -m "feat: export cards with explicit Anki projection loss"
```

### Task 28: Add Complete Native Backup and Restore

**Files:**
- Create: `packages/contracts/src/backup.ts`
- Create: `packages/domain/src/portability/native/`
- Test: `tests/integration/native-backup-roundtrip.test.ts`

**Step 1: Write failing round-trip test**

Backup and restore workspace, courses, memberships, goals, windows, documents, blocks, relations, revisions, explorations, promotions, cards, events, and referenced file manifest.

**Step 2: Run tests**

Expected: FAIL.

**Step 3: Implement versioned native package**

Include schema manifest and migration compatibility check.

**Step 4: Run restore in a fresh test database**

Expected: PASS with identity and relation counts matching.

**Step 5: Commit**

```bash
git add packages/contracts/src/backup.ts packages/domain/src/portability/native tests/integration/native-backup-roundtrip.test.ts
git commit -m "feat: restore complete learning workspaces"
```

### Task 29: Add Developer Diagnostics Without Default UI Overload

**Files:**
- Create: `apps/web/src/features/developer-settings/`
- Create: `packages/contracts/src/diagnostics.ts`
- Test: `tests/e2e/developer-settings.spec.ts`

**Step 1: Write failing tests**

Default UI hides weights/events/model internals. Developer mode shows strategy inheritance, event evidence, model versions, task ranking, AI provenance, and export diagnostics. Parameter editing remains disabled until a later approved task.

**Step 2: Run tests**

Expected: FAIL.

**Step 3: Implement read-only diagnostics**

Use the same result objects as user-facing explanations.

**Step 4: Run tests**

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/web/src/features/developer-settings packages/contracts/src/diagnostics.ts tests/e2e/developer-settings.spec.ts
git commit -m "feat: expose advanced learning diagnostics on demand"
```

### Task 30: Run the First-Phase Acceptance Suite

**Files:**
- Create: `tests/e2e/acceptance/final-exam-user.spec.ts`
- Create: `tests/e2e/acceptance/multi-goal-user.spec.ts`
- Create: `tests/e2e/acceptance/research-user.spec.ts`
- Create: `tests/e2e/acceptance/lifelong-user.spec.ts`
- Create: `tests/e2e/acceptance/cross-course-assets.spec.ts`
- Create: `docs/releases/phase-1-acceptance.md`

**Step 1: Write all failing acceptance scenarios**

Scenarios must match Section 14 of the approved design.

**Step 2: Run suite**

Command: `npm run test:e2e -- acceptance`  
Expected: Any unresolved design behavior fails visibly.

**Step 3: Fix only first-phase gaps**

Do not add Phase 2/3 features to make tests pass.

**Step 4: Run full verification**

```bash
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run test:e2e
npm run build
```

Expected: PASS.

**Step 5: Record results and commit**

```bash
git add tests/e2e/acceptance docs/releases/phase-1-acceptance.md
git commit -m "test: verify the lifelong learning phase one experience"
```

---

## Phase 7: Second-Phase Extensions

These tasks require fresh design approval before implementation. They are ordered here to preserve data-model continuity.

### Task 31: PDF/EPUB Reading and Annotation

- Validate parser and rendering libraries.
- Extend Source/Snapshot/Annotation using existing Block and Relation identities.
- Support page/quote/structure/source-only anchor levels.
- Add regression corpus and degraded-anchor tests.

### Task 32: Zotero and Professional Reading Adapters

- Define connector contracts.
- Import metadata, attachments, annotations, and stable external IDs.
- Detect updates and duplicates; never silently overwrite user edits.

### Task 33: Mock Exams, Rubrics, and Artifacts

- Add timed exam events and expression/project rubrics.
- Keep timed stability separate from other ability slices.
- Feed artifact feedback into exploration and future practice.

### Task 34: Resource Marketplace and Teacher Distribution

- Publish/version/fork resource packages.
- Keep personal states private and separate.
- Support teacher assignments and aggregate errors.

### Task 35: Database Views and Query Blocks

- Render existing Property and Relation data as table/list/board views.
- Do not create a separate database content model.

### Task 36: Whiteboard and Mind Map Views

- Add spatial coordinates and edges as views over existing assets.
- Preserve links to documents, blocks, sources, explorations, and courses.

### Task 37: Self-Hosting, Client, Offline Events, and Plugin SDK

- Publish Docker Compose and compatibility matrix.
- Add client cache and append-only offline event sync.
- Define stable plugin permission and API contracts.

---

## Final Verification Matrix

| Invariant | Required evidence |
|---|---|
| Equal entry points | Navigation component + E2E at desktop/mobile |
| Goal-free use | Exploration and library E2E without course/goal |
| One asset across courses | Integration invariant test |
| Exploration is selective | Promotion acceptance/rejection E2E |
| AI cannot overwrite | Revision conflict test |
| Multiple goals share history | Course/goal integration test |
| Plan can be disabled | Guidance and today-plan E2E |
| SRS state not duplicated | Card multi-goal test |
| Strategy changes preserve history | Goal/time-window replay test |
| External export is honest | Markdown/Anki loss-report tests |
| Native backup is complete | Fresh-database round-trip |
| AI outage is survivable | Integration degradation test |
| Default UI stays concise | Component and screenshot assertions |

## Implementation Handoff

Recommended execution is subagent-driven, one task at a time, with:

1. implementer using TDD;
2. spec compliance review;
3. code quality review;
4. fixes and re-review;
5. green tests and atomic commit;
6. next task only after approval.
