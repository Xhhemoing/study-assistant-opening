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
  expect(captured).not.toHaveProperty("teachingOverride");
});

it("路线受助订正覆盖：回执同时记录规范候选与覆盖结果，不冒充显式巩固请求", async () => {
  const requirement = { id: "r", courseId: "c", stableSkillId: "s", knowledgeNodeId: null, requirementKey: "key", title: "秩", position: 0,
    mandatory: true, goalIds: [], prerequisiteIds: [], sourceRefs: [{ sourceId: "source", sourceVersion: 1 }],
    verification: { kind: "exact" as const, status: "ready" as const, exerciseKeys: ["q"], rubric: null, missingReasons: [] }, revision: 1, lifecycle: "active" as const, origin: "confirmed" as const, approvedAt: null };
  const observation = (id: string, attemptedAt: string, assistance: "hinted" | "independent") => ({ id, skillLabel: "秩", requirementKey: "key", problemId: null, attemptedAt,
    usableForCurrentVersion: "yes" as const, verifiedCorrect: "yes" as const, independentAttempt: assistance === "independent" ? "yes" as const : "no" as const, assistance });
  const input: Parameters<typeof captureOpeningCourseRouteDecision>[2] = {
    courseId: "c", goal: { id: "g", revision: 1 }, entry: "next", requestedId: "r", excluded: [],
    request: { goalId: "g", expectedGoalRevision: 1, activityId: "a", expectedPathVersion: 1, observationId: "helped", clientKey: "next", minutes: 20 },
    progress: [{ requirement, status: "assisted", observationId: "helped", missingReasons: [], sourcesAvailable: true }],
    initialStep: { requirementId: "r", action: "reduced_help_practice", focusObservationId: null },
    context: { goalId: "g", goalRevision: 1, requirementId: "r", requirementRevision: 1, stableSkillId: "s", requirementKey: "key", action: "reduced_help_practice",
      originActivityId: "a", originObservationId: "helped" },
    decisionInput: { status: "needs_check", wantsFullExplanation: false,
      observations: [observation("helped", "2026-10-27T00:00:00Z", "hinted"), observation("prior", "2026-10-26T00:00:00Z", "independent")] },
  };
  const receipt = await captureOpeningCourseRouteDecision({} as Sql as unknown as TransactionSql, { workspaceId: "w", ownerUserId: "u" } as Scope, input);
  expect(() => validateLearningDecision({ ...receipt, targetId: "activity" })).not.toThrow();
  expect(receipt.selectedAction).toBe("reduced_help_practice");
  expect(receipt.reasonCodes).toEqual(expect.arrayContaining(["teaching:needs_check", "teaching_override:route_assisted_correction"]));
  expect(receipt.reasonCodes.some(code => code.includes("consolidate"))).toBe(false);
  expect(receipt.candidates).toContainEqual({ action: "diagnose", eligible: false,
    reasonCodes: ["teaching:needs_check", "overridden_by_route_assisted_correction"], evidenceRefs: ["observation:helped"] });
  // origin and decision-input references to the same observation appear once.
  expect(receipt.evidenceRefs.filter(ref => ref === "observation:helped")).toHaveLength(1);
  const captured = JSON.parse(receipt.intentVersion);
  expect(captured.decisionInput).toEqual(input.decisionInput);
  expect(captured.teaching.decision).toEqual({ activityKind: "diagnose", reasonCode: "needs_check", focusObservationId: null });
  expect(captured.teachingOverride).toEqual({ rule: "route_assisted_correction", observationId: "helped",
    from: { activityKind: "diagnose", reasonCode: "needs_check", focusObservationId: null },
    to: { activityKind: "reduced_help_practice", reasonCode: "route_assisted_correction", focusObservationId: null } });
});
