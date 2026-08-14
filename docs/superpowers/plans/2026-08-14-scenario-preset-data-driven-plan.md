# Scenario Preset Data-Driven Decoupling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> 
> **Model instruction for all implementation subagents:** Use `gpt-5.6-terra` for writing and editing all code in this plan. The coordinator (you) will perform staged reviews after each task.

**Goal:** Replace the hardcoded `z.enum(["final","gaokao","kaoyan","custom"])` with a data-driven `ScenarioPreset` model so that tier ordering, planner behavior, and future strategy parameters live in versioned preset definitions instead of code branches or enum extensions.

**Architecture:** `ScenarioPreset` becomes a branded string type (`string & { __brand: "ScenarioPreset" }`). A `ScenarioPresetRegistry` in `@aistudy/domain` holds the known presets with their `tierOrder`, `reasonMap`, and other planner params. `buildTodayPlan` receives or resolves a `ScenarioPresetDefinition` instead of switching on string literals. Mock providers, seeds, contracts, and UI labels continue to work via the registry. New presets can be added by extending the registry without touching planner logic.

**Tech Stack:** TypeScript 5.8, Zod 3.x (for runtime validation of preset ids), existing Vitest suite.

## Global Constraints

- TDD mandatory: write failing test, watch it fail, implement, watch it pass, commit.
- Backward compatible for existing values "final" | "gaokao" | "kaoyan" | "custom".
- Do not expand the Zod enum; do not add new enum members for new scenarios.
- All tier-order and reason logic must come from the preset definition, not hardcoded if/else on scenario value.
- Update `packages/domain/src/planning/planner.ts`, its test, contracts, mock seeds, goal UI, and integration tests that assert on scenario.
- Preserve exact same plan output for the four existing presets.
- Every task ends with `git add` + `git commit` using Conventional Commit.

---

### Task 1: Design Decision Record and Registry Shape

**Files:**
- Create: `docs/decisions/ADR-014-scenario-preset-registry.md`
- Create: `packages/domain/src/planning/scenario-presets.ts` (new module)
- Test: `packages/domain/src/planning/scenario-presets.test.ts`

**Interfaces:**
- Produces: `ScenarioPresetDefinition` type with `id`, `version`, `tierOrder: StatusWord[]`, `reasonByStatus`, `displayName`.
- Produces: `getScenarioPresetDefinition(preset: ScenarioPreset): ScenarioPresetDefinition` (throws on unknown).
- Produces: `listKnownScenarioPresets(): ScenarioPresetDefinition[]`.

- [ ] **Step 1: Write the failing test for registry lookup**

```ts
import { describe, it, expect } from "vitest";
import { getScenarioPresetDefinition } from "./scenario-presets";
import type { ScenarioPreset } from "@aistudy/contracts";

describe("scenario-presets registry", () => {
  it("returns definition for 'final'", () => {
    const def = getScenarioPresetDefinition("final" as ScenarioPreset);
    expect(def.id).toBe("final");
    expect(def.tierOrder).toEqual(["weak", "untested", "usable"]);
  });

  it("throws on unknown preset", () => {
    expect(() => getScenarioPresetDefinition("unknown" as ScenarioPreset)).toThrow(/unknown scenario preset/i);
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

Run: `npm test -- packages/domain/src/planning/scenario-presets.test.ts -t "registry lookup" --run`

Expected: FAIL with "getScenarioPresetDefinition is not a function" or module not found.

- [ ] **Step 3: Create the registry module with the four known presets**

Write the minimal implementation that makes the test pass (hardcode the four definitions inside the module for now).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- packages/domain/src/planning/scenario-presets.test.ts --run`

Expected: PASS.

- [ ] **Step 5: Write ADR-014**

Document the decision: why branded string + registry instead of enum expansion or DB table in Phase 1; migration path for future data-driven storage; risk that UI labels still need a place (kept in domain for now).

- [ ] **Step 6: Commit**

```bash
git add docs/decisions/ADR-014-scenario-preset-registry.md packages/domain/src/planning/scenario-presets.ts packages/domain/src/planning/scenario-presets.test.ts
git commit -m "feat(planning): introduce ScenarioPresetDefinition registry (ADR-014)"
```

---

### Task 2: Update Planner to Consume Preset Definition

**Files:**
- Modify: `packages/domain/src/planning/planner.ts:22-80` (replace tierOrder and REASON_BY_STATUS with registry lookup)
- Modify: `packages/domain/src/planning/planner.test.ts` (update scenario strings to use new registry if needed, keep assertions identical)
- Test: `packages/domain/src/planning/planner.test.ts`

**Interfaces:**
- Consumes: `getScenarioPresetDefinition` from Task 1.
- Produces: `buildTodayPlan` signature unchanged (still takes `scenario: ScenarioPreset`); internally resolves definition.

- [ ] **Step 1: Write a failing test that asserts tier order comes from registry (add inside existing planner.test.ts)**

Add a test that spies on the registry or checks that changing the registry definition changes the produced queue order.

- [ ] **Step 2: Run the new test to watch it fail**

Run the specific test.

Expected: FAIL because planner still has the old `tierOrder(scenario)` function.

- [ ] **Step 3: Refactor planner.ts to import and use `getScenarioPresetDefinition(input.scenario).tierOrder` and the reason map from the definition**

Delete the old `tierOrder` and `REASON_BY_STATUS` constants. Keep `buildTodayPlan` public signature identical.

- [ ] **Step 4: Run full planner test suite**

Run: `npm test -- packages/domain/src/planning/planner.test.ts --run`

Expected: All tests still PASS with identical output for the four presets.

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/planning/planner.ts packages/domain/src/planning/planner.test.ts
git commit -m "refactor(planning): planner reads tierOrder and reasons from ScenarioPresetDefinition"
```

---

### Task 3: Update Contracts to Support Branded Preset Type (Non-Breaking)

**Files:**
- Modify: `packages/contracts/src/goals.ts` (keep enum for now but export branded alias and a narrow schema; add JSDoc deprecation note on the enum)
- Modify: `packages/contracts/src/index.ts` if re-exports change
- Test: `packages/contracts/src/frontend-domains.test.ts` (ensure existing scenario values still validate)

**Note:** We keep the enum in contracts for type safety in the current phase, but the registry in domain is the source of truth for behavior. Future task can promote the branded string.

- [ ] **Step 1: Add branded type and narrow schema alongside the enum**

```ts
export type ScenarioPreset = z.infer<typeof scenarioPresetSchema>;
export const ScenarioPresetBrand = Symbol("ScenarioPreset");
```

Keep the enum as the source for now; the registry task already ensures no new enum members are needed.

- [ ] **Step 2: Run contract tests**

Run: `npm test -- packages/contracts/src/frontend-domains.test.ts --run`

Expected: PASS (no behavior change).

- [ ] **Step 3: Commit**

```bash
git add packages/contracts/src/goals.ts
git commit -m "docs(contracts): document ScenarioPreset as registry-backed (no enum expansion)"
```

---

### Task 4: Update Mock Seeds and Provider to Use Registry

**Files:**
- Modify: `apps/web/src/lib/data/mock/seeds.ts` (import registry, use `getScenarioPresetDefinition` for any scenario-specific data)
- Modify: `apps/web/src/lib/data/mock/provider-plan.ts:116` (ensure scenario passed to planner comes from goal, no hard-coded assumptions)
- Test: `apps/web/src/lib/data/mock/provider.test.ts`

- [ ] **Step 1: Add a test in provider.test.ts that creates a goal with each of the four scenarios and verifies plan is generated without crash**

- [ ] **Step 2: Run to watch fail if any import or assumption breaks**

- [ ] **Step 3: Update seeds/provider-plan to import from the new registry module (no functional change)**

- [ ] **Step 4: Run provider tests**

Run: `npm test -- apps/web/src/lib/data/mock/provider.test.ts --run`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/data/mock/seeds.ts apps/web/src/lib/data/mock/provider-plan.ts apps/web/src/lib/data/mock/provider.test.ts
git commit -m "refactor(mock): provider and seeds resolve scenario via registry"
```

---

### Task 5: Update Goal UI Labels (Defensive)

**Files:**
- Modify: `apps/web/src/features/goals/goal-model.ts` (SCENARIO_LABELS can stay as a map, or source from registry displayName in future)
- No behavior change required for this task; labels remain hardcoded strings for the four known presets.

- [ ] **Step 1: Add a comment in goal-model.ts pointing to the registry as future source of truth**

- [ ] **Step 2: Run goal-related tests**

Run: `npm test -- apps/web/src/features/goals/ --run`

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/features/goals/goal-model.ts
git commit -m "docs(goals): note that scenario labels will migrate to registry displayName"
```

---

### Task 6: Integration Test Guard

**Files:**
- Modify or verify: `tests/integration/multi-goal-course.test.ts` (ensure scenario is still passed correctly)

- [ ] **Step 1: Run the integration test that exercises planning**

Run: `npm run test:integration -- tests/integration/multi-goal-course.test.ts`

Expected: PASS.

- [ ] **Step 2: Commit**

```bash
git add tests/integration/multi-goal-course.test.ts
git commit -m "test(integration): confirm scenario presets still work end-to-end"
```

---

## Verification After All Tasks

Run the full quality gate:

```bash
npm run lint
npm run typecheck
npm run test
npm run build
```

All must pass with zero new failures.

## Staged Review Protocol (for coordinator)

After each task commit, the coordinator runs:

1. `git show --stat` of the commit.
2. `npm test -- <changed test files> --run` and records output.
3. Opens the changed files and confirms no leftover hardcoded tierOrder or REASON_BY_STATUS.
4. Confirms the registry is the single source for scenario behavior.
5. Only then approves the next task or requests fix.

If any gate fails, the subagent must repair before proceeding.

## Risks & Mitigations

- Risk: UI or other modules still import the old enum directly for type narrowing. Mitigation: keep the enum export; the registry adds behavior, does not remove the type.
- Risk: Future DB-backed presets. Mitigation: the registry can later read from a `strategy_presets` table; current in-memory map is the Phase-1 seam.
- Risk: Label strings drift between registry and goal-model. Mitigation: Task 5 adds the pointer; a later polish task can centralize labels.

---

**Plan saved.** Subagent instruction embedded: every implementation subagent dispatched for this plan **must** be told to operate under the `gpt-5.6-terra` model.

**Next action for user / coordinator:** Choose execution mode (subagent-driven or inline) and confirm the first task dispatch.