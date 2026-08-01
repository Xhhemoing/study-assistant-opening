# Task 9: Workspace Default Entry Preferences

> **For implementer:** Use TDD throughout. Write one failing test first, observe the expected failure, then implement the smallest change that makes it pass.

**Status:** approved for implementation

**Goal:** Persist each workspace's default application entry on the server so the root route can redirect an authenticated user to Learn, Explore, or Library across browsers and devices.

**Architecture:** The existing three-entry shell, responsive navigation, and entry pages remain the UI baseline. A new `workspace_preferences` row keyed by `workspace_id` is the source of truth. The authenticated preference handler derives `workspaceId` exclusively from the session principal; no client-supplied workspace identifier is accepted as authority. The root redirect reads that handler instead of browser storage.

**Tech Stack:** PostgreSQL migration and repository, Drizzle schema, Zod contracts, Next.js route handlers/client components, Vitest integration/handler tests, and Playwright browser E2E.

## Approved Decisions

- Add the forward-only migration `0005_workspace_preferences.sql`; do not change recorded migrations `0001` through `0004`.
- Store one row per workspace, with `workspace_id` as primary key and `default_entry` constrained to `learn`, `explore`, or `library`.
- Missing preference means redirect the authenticated user from `/` to `/learn`. This preserves a usable default for existing users while registration continues to enter `/onboarding` directly.
- The onboarding choice persists through the authenticated handler. Delete the localStorage preference implementation and its tests.
- This task does not add a post-onboarding preference settings control. The onboarding copy must not imply an unimplemented control.
- The known standalone start warning remains out of scope because the production-server browser suite already proves current behavior.

## Task 1: Preference persistence foundation

**Files:**
- Create: `packages/contracts/src/workspace-preferences.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/workspace-preferences.test.ts`
- Create: `packages/database/src/migrations/0005_workspace_preferences.sql`
- Create: `packages/database/src/schema/preferences.ts`
- Create: `packages/database/src/repositories/preferences.ts`
- Test: `tests/integration/workspace-preferences-repository.test.ts`
- Modify: `packages/database/src/index.ts`
- Modify: `scripts/db-reset-e2e.ts`
- Modify only as made necessary by the migration: `tests/integration/identity-migration-compatibility.test.ts`

**RED:** Add contract/repository tests for valid entries, no stored value, upsert, workspace isolation, and invalid entry validation. Run:

```bash
DATABASE_URL=postgres://aistudy:aistudy@127.0.0.1:5432/aistudy_e2e \
  npm run test:integration -- workspace-preferences-repository
```

Expected: fail because the preference contract/repository does not exist.

**GREEN:** Add the contract, migration, Drizzle schema, repository, exports, and E2E reset truncation. Update migration compatibility expectations only for the new forward migration. Run the focused test, then the whole integration project.

**Commit:** `feat: persist workspace default entry preference`

## Task 2: Session-scoped preference API

**Files:**
- Create: `apps/web/src/app/api/workspace/preferences/route.ts`
- Modify: `apps/web/src/features/auth/service.ts`
- Test: `tests/integration/handler/workspace-preferences.test.ts`

**RED:** Cover unauthenticated GET/PUT, no preference returning `null`, valid PUT/GET round-trip, invalid entry rejection, and a request body carrying another workspace ID that still only updates the principal workspace.

```bash
DATABASE_URL=postgres://aistudy:aistudy@127.0.0.1:5432/aistudy_e2e \
  npm run test:handler -- workspace-preferences
```

Expected: fail because the handler and runtime repository boundary do not exist.

**GREEN:** Add the repository to `AuthRuntime`, map repository validation to API validation, and use `requirePrincipal` plus `boundWorkspaceId` for both methods. Run the focused handler project.

**Commit:** `feat: add authenticated workspace preference API`

## Task 3: Replace browser-local redirect preference

**Files:**
- Modify: `apps/web/src/features/workspace/onboarding.tsx`
- Modify: `apps/web/src/features/workspace/root-redirect.tsx`
- Delete: `apps/web/src/features/workspace/entry-preference.ts`
- Delete: `apps/web/src/features/workspace/entry-preference.test.ts`

**RED:** Extend browser coverage before changing client code; the new test must prove a selected entry survives `localStorage.clear()` and a later visit to `/`.

**GREEN:** Onboarding PUTs the selected entry and reports failure without navigating. Root redirect calls the preference API once, handles 401 through login, and maps a missing entry explicitly to `/learn` without using the UI fallback helper. Update onboarding copy to avoid claiming an unbuilt settings control.

**Commit:** `feat: redirect workspace root from server preference`

## Task 4: Browser acceptance and release

**Files:**
- Modify: `tests/e2e/workspace-navigation.spec.ts` or create `tests/e2e/workspace-default-entry.spec.ts`
- Modify: `README.md`
- Modify: `docs/plans/2026-07-24-phase1-tasks-9-30-superpowers-plan.md`

**Acceptance:**
- Registration reaches onboarding, selecting Explore reaches `/explore`, and after clearing localStorage a new visit to `/` still reaches `/explore`.
- An authenticated workspace with no stored preference reaches `/learn` at `/`.
- Learn, Explore, and Library remain reachable at 320, 768, and 1440 px without horizontal overflow or primary-region overlap.
- Browser E2E uses the isolated `_e2e` database, a real production server, and one worker.

**Verification:**

```bash
flock -w 180 /tmp/hermes-project-heavy.lock bash -c "
  export DATABASE_URL='postgres://aistudy:aistudy@127.0.0.1:5432/aistudy_e2e'
  export E2E_DATABASE_URL='postgres://aistudy:aistudy@127.0.0.1:5432/aistudy_e2e'
  export E2E_BASE_URL='http://127.0.0.1:3000'
  export REDIS_URL='redis://127.0.0.1:6379'
  export HERMES_HEAVY_LOCK_HELD=1
  npm run lint && npm run typecheck && npm test && npm run test:handler && \
    npm run test:integration && npm run test:browser && npm run build && npm run verify:ci
"
```

Review the diff, stage only Task 9 files, commit without pushing, then refresh and verify `/home/ubuntu/aistudy-gates.bundle`.
