# Fix Plan: Effective Requirements Dead Code + Intervention Review Issues

> Review findings from 2026-08-14. TDD: red → green → commit per task.

## Findings

1. **P1 dead code**: `planForDate` computes `effective` but `buildTodayPlan` never consumes it (`PlannerInput` has no such field; spread hides the excess-property error). `effective` is silently discarded.
2. **Duplicate/ineffective test**: `computes effective requirements for multiple active goals` is identical to `combines daily budgets of multiple active goals`; asserts nothing about effective requirements.
3. **Repeated ternary**: `(g.courseId ? "final-exam" : "custom")` computed twice.
4. **Stem truncation**: `item.stem.slice(0, 12)` always appends `…`, wrong for stems ≤ 12 chars.
5. **Redundant `as never`** in intervention test.
6. **Inline action type**: `action` union should be a named `InterventionAction` export.
7. **Loose assertions**: test asserts only "non-empty message" instead of the cause→action mapping.

## Decision

Wire the **assessment mode** (评估开关) for real — it has clear semantics (`disabled` = no assessment = no practice tasks) and does not depend on the missing course↔syllabus mapping. **Ability weights** (能力权重) consumption still needs product rules, so we keep the domain `computeEffectiveRequirements` (already tested) but stop pretending the mock consumes it. This makes the wiring honest and testable.

## Tasks

### Task A: Planner consumes assessmentMode (red → green)

- `packages/domain/src/planning/planner.ts`: add `assessmentMode?: AssessmentMode` to `PlannerInput`; `buildTodayPlan` skips practice-task queueing when `disabled` (reviews still queue).
- `packages/domain/src/planning/planner.test.ts`: add two tests (disabled skips practice but keeps review; default = basic).

### Task B: Mock provider wires assessmentMode

- `apps/web/src/lib/data/types.ts`: `MockProviderOptions` gains `assessmentMode?: AssessmentMode`.
- `apps/web/src/lib/data/mock/provider-state.ts`: `MockProviderState` gains `assessmentMode`, default `"basic"`.
- `apps/web/src/lib/data/mock/provider-plan.ts`: remove `computeEffectiveRequirements`/`defaultGoalAbilities`/`getRequirementProfile`/`GoalKind` imports and the dead `effective` block; pass `assessmentMode: state.assessmentMode`.
- `apps/web/src/lib/data/mock/provider.test.ts`: remove duplicate test; add test injecting `assessmentMode: "disabled"` asserting no practice tasks and reviews still present.

### Task C: intervention.ts + test fixes

- `packages/domain/src/practice/intervention.ts`: export `InterventionAction`; fix stem truncation.
- `packages/domain/src/practice/intervention.test.ts`: drop `as never`; assert exact cause→action mapping.

## Verification

- `npx vitest run packages/domain/src/planning packages/domain/src/practice apps/web/src/lib/data/mock --run`
- `npx tsc -p packages/domain/tsconfig.json --noEmit`
- Commit each task with Conventional Commit.
