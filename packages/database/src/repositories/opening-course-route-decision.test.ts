import { expect, it, vi } from "vitest";
import type { Scope } from "@aistudy/contracts";
import type { Sql, TransactionSql } from "postgres";
import { validateLearningDecision } from "@aistudy/domain";
vi.mock("./opening-learner-state-read", () => ({ readOpeningLearnerState: vi.fn(async () => ({ stateVersion: "state", sourceVersions: {}, dataAsOf: "2026-10-27T00:00:00Z" })) }));
import { captureOpeningCourseRouteDecision } from "./opening-course-route-decision";

it("持久回执保留规范输入和真实候选原因，而不是误记为综合覆盖覆盖了动作", async () => {
  const input: Parameters<typeof captureOpeningCourseRouteDecision>[2] = {
    courseId: "c", goal: { id: "g", revision: 1 }, entry: "start", requestedId: "r", excluded: [],
    request: { goalId: "g", expectedGoalRevision: 1, requirementId: "r", expectedRequirementRevision: 1, clientKey: "request", minutes: 20 },
    progress: [{ requirement: { id: "r", courseId: "c", stableSkillId: "s", knowledgeNodeId: null, requirementKey: "key", title: "秩", position: 0,
      mandatory: true, goalIds: [], prerequisiteIds: [], sourceRefs: [{ sourceId: "source", sourceVersion: 0 }],
      verification: { kind: "exact", status: "ready", exerciseKeys: ["q"], rubric: null, missingReasons: [] }, revision: 1, lifecycle: "active", origin: "confirmed", approvedAt: null },
      status: "needs_verification", observationId: "unknown", missingReasons: [], sourcesAvailable: true }],
    initialStep: { requirementId: "r", action: "transfer_check", focusObservationId: "unknown" },
    context: { goalId: "g", goalRevision: 1, requirementId: "r", requirementRevision: 1, stableSkillId: "s", requirementKey: "key", action: "diagnose" },
    decisionInput: { status: "needs_check", wantsFullExplanation: false, observations: [{ id: "unknown", skillLabel: "秩", requirementKey: "key", problemId: null,
      attemptedAt: "2026-10-27T00:00:00Z", usableForCurrentVersion: "yes", verifiedCorrect: "unknown", independentAttempt: "unknown", assistance: "unknown" }] },
  };
  const receipt = await captureOpeningCourseRouteDecision({} as Sql as unknown as TransactionSql, { workspaceId: "w", ownerUserId: "u" } as Scope, input);
  expect(() => validateLearningDecision({ ...receipt, targetId: "activity" })).not.toThrow();
  expect(receipt).toMatchObject({ selectedAction: "diagnose", sourceVersions: { source: [0] }, reasonCodes: expect.arrayContaining(["teaching:unverified_only"]), evidenceRefs: expect.arrayContaining(["observation:unknown"]) });
  expect(receipt.candidates).toContainEqual({ action: "transfer_check", eligible: false, reasonCodes: ["overridden_by_current_evidence_policy"], evidenceRefs: ["requirement:r", "observation:unknown"] });
  const captured = JSON.parse(receipt.intentVersion);
  expect(captured.decisionInput).toEqual(input.decisionInput);
  expect(captured.teaching.decision).toEqual({ activityKind: "diagnose", reasonCode: "unverified_only", focusObservationId: null });
});
