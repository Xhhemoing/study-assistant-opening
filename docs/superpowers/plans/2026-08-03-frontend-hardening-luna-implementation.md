# Frontend Hardening Luna Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. The user will switch the active model to `luna (tokenfree, Max)` for implementation. Do not create commits unless the user explicitly authorizes commits.

**Goal:** Harden the existing AIstudy workspace UI and mock-backed learning flow so user identity, browser data, plans, async recovery, and overlay accessibility remain correct under reloads, failures, stale requests, and repeated actions.

**Architecture:** Keep the current hybrid provider boundary unchanged. Server-backed auth, workspace preferences, and documents remain on their existing routes; the browser-side `MockStudyDataProvider` remains localStorage-backed and namespaced by `userId`. Fix behavior at the smallest owning layer: identity/cache in `react.ts`, persistence and seed decisions in `mock/storage.ts` and `mock/provider-state.ts`, plan invariants in `mock/provider-plan.ts`, UI loading/retry behavior in feature components, and focus semantics in existing overlay components.

**Tech Stack:** TypeScript, React 19, Next.js App Router, Tailwind CSS utilities, `lucide-react`, Vitest 4 with the repository `unit` project, and Playwright only for the available browser smoke path.

## Global Constraints

- Do not change the `StudyDataProvider` interface or add backend routes.
- Preserve all existing uncommitted user changes. In particular, do not revert or overwrite `.learnings/ERRORS.md`, `apps/web/src/features/search/command-palette.tsx`, `apps/web/src/lib/data/mock/provider-plan.ts`, `apps/web/src/lib/data/mock/provider.test.ts`, or the untracked command-palette test.
- Do not commit. The user has requested a plan first and will switch models for implementation.
- New or changed UI must use Tailwind utility classes only; do not edit `apps/web/src/app/globals.css` and do not add inline `style` props.
- Use `lucide-react` for icons and keep semantic labels, keyboard access, focus-visible states, and non-color status text intact.
- Keep mock domains isolated by `userId`; never allow one user to read, seed, reset, or mutate another user’s data.
- Treat malformed persisted JSON as recoverable data loss: remove the broken domain key and return the requested fallback.
- Seed mock data only when the `goals` domain is absent; a valid empty goals array means the user intentionally has no goals and must not be reseeded.
- Clear stale async data before a reload and after a failed load unless the component explicitly needs stale data to remain visible while showing an inline error.
- Candidate status changes and attempt submissions must remain idempotent.
- Do not use arbitrary sleeps in tests. Prefer controllable promises, events, and deterministic injected clocks.
- Files should remain under 200 lines when practical; split only when needed to preserve focused ownership.
- Every behavior change requires a nearby `*.test.ts` regression test. Component tests use `createElement` and `renderToStaticMarkup` unless a browser test is necessary.

## Existing Workspace Baseline

The workspace is already dirty before implementation. These changes are part of the baseline and must be reviewed in place:

- `useAsyncData` currently clears data on load start and failure.
- `loadDomain` currently removes malformed JSON.
- `provider-plan.ts` currently chooses a non-archived goal and prunes overlays for omitted plan tasks.
- `provider.test.ts` already covers malformed goals, stale overlays, archived-goal carryover, idempotent attempts, candidate promotion idempotency, and document tag normalization.
- `command-palette.tsx` already contains the user’s ARIA combobox additions and has an untracked `command-palette.test.ts`.

Do not duplicate these tests blindly. First run them, identify missing assertions, and extend them only where the approved design is not yet covered.

## File Map

### Identity, persistence, and plan ownership

- Modify: `apps/web/src/lib/data/react.ts` — lifecycle-scoped `/api/auth/me` request behavior and async load state.
- Modify: `apps/web/src/lib/data/mock/storage.ts` — storage fallback and malformed-entry recovery, preserving current API.
- Modify: `apps/web/src/lib/data/mock/provider-state.ts` — seed only on an absent goals domain and avoid coercing valid empty data.
- Modify: `apps/web/src/lib/data/mock/provider-plan.ts` — active-goal selection and date snapshot/overlay invariants, preserving current dirty changes.
- Modify: `apps/web/src/features/goals/goal-detail.tsx` — ignore stale goal responses and unmounted request completions.
- Modify: `apps/web/src/lib/data/react.test.ts` — pure fetch helper/cache tests if the implementation exposes a testable helper.
- Modify: `apps/web/src/lib/data/mock/storage.test.ts` — key, round-trip, malformed JSON, storage failure, and reset tests.
- Modify: `apps/web/src/features/goals/goal-components.test.ts` — static surface regression coverage.
- Modify: `apps/web/src/lib/data/mock/provider.test.ts` — provider-level identity/seed/plan regressions.

### Learning workflow

- Inspect and modify only the owning files that are required: `apps/web/src/features/learn/today-plan-model.ts`, `apps/web/src/features/learn/today-plan-view.tsx`, `apps/web/src/app/(workspace)/learn/page.tsx`, and the closest goal/practice/review components.
- Modify: `apps/web/src/lib/data/mock/provider-explore.ts` only for candidate terminal-state idempotency if existing behavior is incomplete.
- Add or extend: `apps/web/src/features/learn/today-plan-model.test.ts` and the nearest component/provider test.

### Library, settings, and async recovery

- Modify: `apps/web/src/features/workspace/library-document-list.tsx` — Tailwind-only loading/error/empty states and editor links.
- Modify: `apps/web/src/features/settings/settings-view.tsx` and `apps/web/src/app/(workspace)/settings/page.tsx` only if the route or retry/reset lifecycle has a concrete gap.
- Modify: `apps/web/src/features/search/command-palette.tsx` only for missing focus/keyboard/error semantics; preserve existing user edits.
- Inspect existing drawer implementation under `packages/ui/src` and `apps/web/src/features/assessment/reason-drawer.tsx`, `apps/web/src/features/editor/version-history-drawer.tsx`, and any shared focus helper before changing overlay behavior.
- Add focused tests adjacent to each changed model/component; add one Playwright smoke assertion only if the existing browser setup can run without unavailable services.

## Task 1: Identity, Storage, and Plan Correctness

**Deliverable:** Auth reloads do not share stale results across hook lifecycles; mock data survives valid empty states and recovers from corruption; plans never use archived goals or stale task overlays; goal detail never displays a response for an old id or an unmounted request.

**Files:**
- Modify: `apps/web/src/lib/data/react.ts`
- Modify: `apps/web/src/lib/data/mock/storage.ts`
- Modify: `apps/web/src/lib/data/mock/provider-state.ts`
- Modify: `apps/web/src/lib/data/mock/provider-plan.ts`
- Modify: `apps/web/src/features/goals/goal-detail.tsx`
- Test: `apps/web/src/lib/data/react.test.ts` if test environment supports the helper without rendering hooks
- Test: `apps/web/src/lib/data/mock/storage.test.ts`
- Test: `apps/web/src/lib/data/mock/provider.test.ts`
- Test: `apps/web/src/features/goals/goal-components.test.ts` or a new `goal-detail.test.ts` if a behavior cannot be tested in the existing file

**Interfaces:**
- Preserve `useAsyncData<T>(load, deps): AsyncData<T>`.
- Preserve `fetchCurrentUserId(): Promise<string | null>`.
- Preserve `useCurrentUserId(): string | null` and `useStudyProvider(): StudyDataProvider | null`.
- Preserve `loadDomain`, `saveDomain`, `resetDomains`, `browserStorage`, `ensureSeed`, `getTodayPlan`, `setTaskStatus`, and `toggleTaskLock` signatures.

- [ ] **Step 1: Establish the baseline.**

Run:

```bash
npx vitest run --project unit apps/web/src/lib/data/mock/storage.test.ts apps/web/src/lib/data/mock/provider.test.ts apps/web/src/features/goals/goal-components.test.ts
```

Expected: the current focused suite passes, or any pre-existing failure is recorded before edits. Do not attribute failures from unrelated dirty changes to this task without checking the diff.

- [ ] **Step 2: Add regression tests before implementation.**

Add tests for these exact cases:

```ts
it("does not seed over a valid empty goals collection", async () => {
  const storage = createMemoryStorage();
  storage.setItem(mockKey(USER_ID, "goals"), "[]");
  const provider = createMockProvider({ userId: USER_ID, now: NOW, delayMs: 0, storage });
  await expect(provider.listGoals()).resolves.toEqual([]);
  expect(storage.getItem(mockKey(USER_ID, "practiceItems"))).toBeNull();
});

it("removes malformed JSON before returning the fallback", () => {
  const storage = createMemoryStorage();
  storage.setItem(mockKey(USER_ID, "goals"), "{bad json");
  expect(loadDomain(storage, USER_ID, "goals", [])).toEqual([]);
  expect(storage.getItem(mockKey(USER_ID, "goals"))).toBeNull();
});

it("does not use an archived goal to create a plan", async () => {
  const provider = createProvider();
  const [goal] = await provider.listGoals();
  expect(goal).toBeDefined();
  if (!goal) return;
  await provider.archiveGoal(goal.id);
  await expect(provider.getTodayPlan("2026-08-02")).rejects.toThrow("请先创建一个学习目标");
});
```

Also add a deterministic stale-response test for `GoalDetail` using controlled promises or an extracted pure request-version helper. The assertion must prove that an older `getGoal(oldId)` result cannot replace the current draft after the id changes, and that a completion after unmount does not update state.

For auth, test the chosen lifecycle behavior at the smallest testable boundary: two independent `fetchCurrentUserId()` calls must each issue the intended request, and no module-global resolved Promise may retain the first user. If React hook rendering is required, use the repository’s existing component-test conventions and controlled fetch mocks rather than adding a DOM dependency.

- [ ] **Step 3: Run the new tests and confirm RED.**

Run the same focused command. Expected: at least each uncovered behavior fails before the implementation change. If a test already passes because of current dirty work, keep it as a regression and identify the remaining missing branch.

- [ ] **Step 4: Implement the smallest fixes.**

Use these invariants:

1. `useAsyncData` starts every load with `loading=true`, `error=null`, and no stale `data` unless an existing caller explicitly depends on stale display. Failed loads must leave `data` undefined and expose the existing Chinese retry error.
2. `useCurrentUserId` must not retain a module-global Promise or user id beyond the hook lifecycle. A lifecycle may deduplicate its own request if implemented with a local ref, but a new lifecycle must be able to observe a changed authenticated user.
3. `loadDomain` must return fallback on storage read/parse failure and remove only the malformed key when removal is possible. Do not remove valid JSON merely because it is an empty array/object.
4. `ensureSeed` must distinguish absent `goals` (`null` from storage) from present valid `[]`. Do not infer validity from `Array.isArray` alone if malformed or wrong-shaped values need recovery; preserve the current provider behavior and contract validation boundaries.
5. Plan generation must select the first non-archived goal explicitly, reject when none exists, discard overlays whose task ids are absent from the regenerated plan, and never carry locked tasks across a goal id change.
6. Goal detail request state must be guarded by both request version and component lifecycle. A stale response or stale error must not overwrite the current goal, error, loading, or draft.

Do not change business copy, provider method names, or unrelated routes.

- [ ] **Step 5: Verify the task.**

Run:

```bash
npx vitest run --project unit apps/web/src/lib/data/mock/storage.test.ts apps/web/src/lib/data/mock/provider.test.ts apps/web/src/features/goals/goal-components.test.ts
npm run lint
npm run typecheck
```

Expected: focused tests, lint, and typecheck pass. Report any environment failure separately from code failures.

- [ ] **Step 6: Main-model review gate.**

Before moving on, review the diff against the design. Check that no module-global auth cache remains, valid empty goals are preserved, stale plan data is pruned, and no dirty baseline files were reverted. If a gap exists, keep it in Task 1 and rerun the focused tests.

## Task 2: Complete the Learn Workflow

**Deliverable:** `/learn` has a coherent loading/error/empty path, reads the mock TodayPlan through the existing provider, and exposes actionable task links. Goal selection, task overlays, and result/reload behavior do not show stale data.

**Files:**
- Inspect/modify: `apps/web/src/app/(workspace)/learn/page.tsx`
- Modify: `apps/web/src/features/learn/today-plan-view.tsx`
- Modify: `apps/web/src/features/learn/today-plan-model.ts`
- Inspect/modify: `apps/web/src/features/practice/practice-player.tsx`, `apps/web/src/features/practice/practice-result.tsx`, `apps/web/src/features/review/review-session.tsx` only when required for a broken route, retry, or stale state in the learn loop
- Test: `apps/web/src/features/learn/today-plan-model.test.ts`
- Test: nearest component/provider test for changed UI behavior

**Interfaces:**
- Preserve `getPlanCompletion(plan): { done: number; total: number; percent: number }`.
- Preserve `taskHref(task, date): string` and current route shapes.
- Preserve provider calls `getTodayPlan`, `setTaskStatus`, and `toggleTaskLock`.

- [ ] **Step 1: Add or extend tests.**

Cover:

```ts
it("counts only done tasks and returns zero for an empty plan", () => {
  expect(getPlanCompletion(emptyPlan)).toEqual({ done: 0, total: 0, percent: 0 });
  expect(getPlanCompletion(planWithDoneAndPending)).toEqual({ done: 1, total: 2, percent: 50 });
});

it("routes practice, review, and non-action tasks to their owning workflows", () => {
  expect(taskHref(practiceTask, DATE)).toContain("/learn/practice/");
  expect(taskHref(reviewTask, DATE)).toContain("/learn/review?");
  expect(taskHref(exploreTask, DATE)).toBe("/explore");
});
```

Add static-render tests for loading, retryable failure, no-goal CTA, empty plan CTA, task reason text, and status updates if the current testing approach can mock `useStudyProvider`. For practice/review changes, assert the failed load exposes a retry action and does not discard user-entered answer content on submit failure.

- [ ] **Step 2: Run tests and confirm RED for uncovered behavior.**

```bash
npx vitest run --project unit apps/web/src/features/learn/today-plan-model.test.ts
```

Then run the closest component tests. Do not introduce tests for already-correct behavior solely to inflate scope.

- [ ] **Step 3: Implement the workflow fixes.**

Ensure:

1. The learn page renders the existing `TodayPlanView` as the primary workflow, without introducing a second provider or direct localStorage access.
2. Loading state is announced with `role=status`; failure state is announced with `role=alert` and has a visible retry button with `RefreshCw`.
3. A missing active goal links to `/learn/goals/new`; an empty task list offers the existing exploration path. Keep the default page information budget within the UX policy.
4. Task action URLs preserve `date` and `taskId`; practice and review routes remain encoded and actionable.
5. Task updates disable conflicting controls while pending, clear errors before retrying, and retain the last valid plan when an inline update fails.
6. Reloads do not resurrect a previous goal’s plan or overlay. Use provider behavior from Task 1 rather than bypassing it in the component.

- [ ] **Step 4: Verify the task.**

```bash
npx vitest run --project unit apps/web/src/features/learn apps/web/src/features/practice apps/web/src/features/review
npm run lint
npm run typecheck
npm run build
```

The build is required because the route surface is involved. If the build fails due to unavailable database or environment configuration, capture the exact failure and still distinguish it from unit/type/lint results.

- [ ] **Step 5: Main-model review gate.**

Review route correctness, retry behavior, preservation of user input, and compliance with the UX information budget. Reject any implementation that duplicates provider logic in UI, silently mutates plans, or changes unrelated navigation.

## Task 3: Library, Settings, and Candidate Reliability

**Deliverable:** Library rows reliably open the editor route; settings can load/retry and reset only current-user mock data; candidate terminal states are idempotent; tag and link operations remain normalized and recoverable.

**Files:**
- Modify: `apps/web/src/features/workspace/library-document-list.tsx`
- Modify: `apps/web/src/features/settings/settings-view.tsx` only for concrete loading/save/reset gaps
- Modify: `apps/web/src/lib/data/mock/provider-explore.ts` only for candidate terminal-state or normalization gaps
- Inspect: `apps/web/src/features/editor/properties-panel.tsx`, `apps/web/src/features/editor/backlinks-panel.tsx`, `apps/web/src/features/settings/diagnostics-panel.tsx`
- Test: `apps/web/src/lib/data/mock/provider.test.ts`
- Test: add `apps/web/src/features/workspace/library-document-list.test.ts` only if the existing component test convention can mock fetch cleanly
- Test: add the nearest settings/candidate tests for any changed branch

**Interfaces:**
- Preserve document route `/library/{encodedDocumentId}`.
- Preserve `getDocumentTags`, `setDocumentTags`, `indexDocumentLinks`, and `listBacklinks`.
- Preserve `setCandidateStatus(candidateId, status, promotedTargetId?)` and its current terminal-state return semantics.

- [ ] **Step 1: Add regression tests.**

Cover:

```ts
it("returns the existing candidate unchanged after it reaches a terminal state", async () => {
  const promoted = await provider.setCandidateStatus(candidate.id, "promoted", "target-1");
  await expect(provider.setCandidateStatus(candidate.id, "promoted", "target-2")).resolves.toEqual(promoted);
  await expect(provider.setCandidateStatus(candidate.id, "rejected")).resolves.toEqual(promoted);
});

it("normalizes tags before persistence and search", async () => {
  await provider.setDocumentTags("doc-1", [" 标签 ", "标签", "ＴＯＰＩＣ", "topic"]);
  await expect(provider.getDocumentTags("doc-1")).resolves.toEqual(["标签", "TOPIC"]);
});
```

For the library list, test success links use `/library/<encoded id>`, failure renders a retry button, and an empty response renders the existing empty state. For settings, test failed preference/provider loading offers retry and reset calls only the current provider; do not add a second persistence mechanism.

- [ ] **Step 2: Run the focused tests and confirm RED where appropriate.**

```bash
npx vitest run --project unit apps/web/src/lib/data/mock/provider.test.ts apps/web/src/features/workspace apps/web/src/features/settings
```

Record unrelated baseline failures before changing code.

- [ ] **Step 3: Implement the smallest fixes.**

1. Replace legacy non-Tailwind classes in `library-document-list.tsx` with the established Tailwind utility language used by neighboring workspace features. Keep semantic `ul`/`li`/`Link`, visible loading status, alert role, and retry icon button.
2. Keep document ids encoded exactly once in the link construction.
3. In settings, preserve radio/select semantics, retry behavior, and current-user reset confirmation. A save failure must not claim success or lose the selected value.
4. In `provider-explore.ts`, ensure a candidate with `promoted` or `rejected` status is returned unchanged for all later status calls, including attempts to replace `promotedTargetId`.
5. Keep tag normalization Unicode-aware and case-insensitive for deduplication; do not mutate unrelated document links or remote document data.
6. Keep diagnostics read-only and retryable; avoid exposing raw event logs in default surfaces outside the existing developer details panel.

- [ ] **Step 4: Verify the task.**

```bash
npx vitest run --project unit apps/web/src/lib/data/mock/provider.test.ts apps/web/src/features/workspace apps/web/src/features/settings apps/web/src/features/editor
npm run lint
npm run typecheck
```

- [ ] **Step 5: Main-model review gate.**

Check that only Tailwind utilities were introduced in changed UI, all links are correctly encoded, candidate transitions are truly terminal and idempotent, and settings errors cannot leave misleading success notices.

## Task 4: Async Recovery and Overlay Accessibility

**Deliverable:** Search, drawers, command menus, tag panels, and other changed async surfaces have deterministic retry paths, correct focus movement/return, keyboard operation, and semantic roles without regressions.

**Files:**
- Modify: `apps/web/src/features/search/command-palette.tsx` only for gaps remaining after the existing dirty ARIA/focus changes
- Inspect/modify: `packages/ui/src` shared drawer/focus helpers and `apps/web/src/features/assessment/reason-drawer.tsx`, `apps/web/src/features/editor/version-history-drawer.tsx`
- Inspect/modify: `apps/web/src/features/editor/properties-panel.tsx`, `apps/web/src/features/settings/diagnostics-panel.tsx`, and other touched async surfaces only where a missing retry or stale update is demonstrated
- Test: `apps/web/src/features/search/command-palette.test.ts`
- Test: existing drawer tests and any new focused tests beside changed components
- Browser test: extend an existing `tests/e2e/*.spec.ts` only if the local browser setup and auth fixture support this flow

**Interfaces:**
- Preserve existing drawer props and `getFocusTrapTarget` behavior.
- Preserve `CommandPalette` props `{ open, onOpen, onClose }`.
- Preserve current search debounce constant and command model APIs.

- [ ] **Step 1: Add focused accessibility/regression assertions.**

The command palette test must assert the current user additions plus:

```ts
expect(html).toContain('role="dialog"');
expect(html).toContain('role="combobox"');
expect(html).toContain('aria-expanded="true"');
expect(html).toContain('aria-controls="command-palette-options"');
expect(html).toContain('aria-label="关闭搜索"');
```

For drawers, assert `role="dialog"`, `aria-modal="true"`, a labelled heading/description, and a close control. For behavior tests, use controlled focus helpers or Playwright to verify: opening focuses the input/first meaningful control, `Escape` closes, `Tab` does not leave the dialog, and closing returns focus to the trigger when that is the existing contract.

Add a failure-path test for search/tag/diagnostics load that shows retry and clears the error on a subsequent successful attempt. Use controlled promises; avoid timing-based sleeps.

- [ ] **Step 2: Run tests and confirm RED for missing branches.**

```bash
npx vitest run --project unit apps/web/src/features/search apps/web/src/features/assessment apps/web/src/features/editor apps/web/src/features/settings packages/ui/src
```

- [ ] **Step 3: Implement accessibility and recovery fixes.**

1. Keep command palette focus in the dialog while open. Make focus return happen only after close and only when the prior element is still connected.
2. Ensure keyboard navigation does not select an empty option list, does not move outside bounds, and preserves `aria-activedescendant` consistency.
3. Make search request cleanup ignore late results/errors from an older query or closed palette. Retry must issue a new request and clear the previous error.
4. For drawers, use existing shared helpers and local patterns. Do not introduce a global state library or duplicate a full focus-trap abstraction if one exists.
5. Every changed async data surface must expose a visible retry action with an icon and must not overwrite current valid data with a late failed request.
6. Do not remove existing `aria-live`, `role=status`, `role=alert`, or focus-visible classes.

- [ ] **Step 4: Verify the task.**

```bash
npx vitest run --project unit apps/web/src/features/search apps/web/src/features/assessment apps/web/src/features/editor apps/web/src/features/settings packages/ui/src
npm run lint
npm run typecheck
```

If browser dependencies are available, also run the narrow existing browser smoke test. If not, report the exact prerequisite rather than weakening unit tests to compensate.

- [ ] **Step 5: Main-model review gate.**

Review keyboard and focus behavior from the DOM contract, not only static markup. Check for focus leaks, stale promise updates, missing labels, and regressions in the user’s existing command-palette changes.

## Task 5: Integrated Verification and Graph Update

**Deliverable:** All approved hardening slices pass the available repository gates, and the knowledge graph reflects the coherent implementation slice.

**Files:**
- No production file changes are authorized by this task.
- Generated Graphify output is expected to be dirty and must not be manually curated or committed.

- [ ] **Step 1: Inspect the final diff.**

Run:

```bash
git status --short
git diff --stat
git diff --check
git diff --name-only
```

Confirm every changed file belongs to the hardening plan or was already dirty before implementation. Do not revert unrelated changes.

- [ ] **Step 2: Run focused unit tests.**

```bash
npx vitest run --project unit apps/web/src/lib/data apps/web/src/features/goals apps/web/src/features/learn apps/web/src/features/practice apps/web/src/features/review apps/web/src/features/search apps/web/src/features/settings apps/web/src/features/workspace apps/web/src/features/editor apps/web/src/features/assessment packages/ui/src
```

Expected: all selected tests pass.

- [ ] **Step 3: Run repository gates.**

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

The build may require the repository’s environment and local services. Distinguish code failures from unavailable PostgreSQL, Redis, environment variables, or Chromium; never claim a gate passed without fresh output.

- [ ] **Step 4: Run Graphify once after the coherent implementation.**

```bash
graphify update .
```

Do this once after all implementation slices are complete, not after individual edits. Keep generated graph artifacts out of the implementation diff unless repository policy explicitly tracks them.

- [ ] **Step 5: Final main-model review.**

Review the whole diff against `docs/superpowers/specs/2026-08-03-frontend-hardening-design.md`:

- Identity requests are lifecycle-correct and cannot leak one user into another.
- Storage corruption is recoverable and valid empty domains remain empty.
- Plans use only active goals and prune stale overlays.
- Learn, library, exploration, settings, and search surfaces have usable retry/error states.
- Candidate terminal transitions and attempts are idempotent.
- Overlay focus, roles, labels, keyboard navigation, and focus return are preserved.
- No backend boundary, unrelated route, legacy global CSS, or user dirty change was unnecessarily altered.

Record findings first by severity. Any correctness or accessibility finding blocks completion and must be fixed and retested before handoff.

## Handoff To Luna

Start Luna with one task at a time. Include the complete task section, the approved design path, the current dirty-file list, and the rule that Luna must not commit or revert unrelated changes. After Luna reports completion:

1. Run the task’s focused tests yourself.
2. Review the diff for specification compliance.
3. Review code quality, types, error paths, and test quality.
4. Return only concrete defects to Luna for correction.
5. Re-run the focused tests after each correction.
6. Continue to the next task only after both review gates pass.

Suggested first dispatch message:

```text
Implement Task 1 from docs/superpowers/plans/2026-08-03-frontend-hardening-luna-implementation.md.

Read the approved design at docs/superpowers/specs/2026-08-03-frontend-hardening-design.md first.
Preserve all current dirty changes; do not reset, checkout, or commit. Work test-first, run the focused tests, lint, and typecheck, then report changed files, tests, and any concerns. Stay within Task 1’s file scope.
```

The next task should not be dispatched until the main model has completed the two review gates for the previous task.

## Plan Self-Review

- **Spec coverage:** Identity/storage risks map to Task 1; incomplete learn entry points map to Task 2; library/settings/candidate recovery maps to Task 3; async/accessibility maps to Task 4; verification and one Graphify update map to Task 5.
- **Placeholder scan:** No `TODO`, `TBD`, or unspecified “appropriate handling” steps are used; commands, files, interfaces, and expected outcomes are explicit.
- **Type consistency:** Existing provider, plan, tag, candidate, and command-palette interfaces are preserved; no task introduces a new cross-module contract.
- **Scope check:** This is one coherent frontend-hardening project. Task 5 is verification-only and must not create unrelated production changes.
