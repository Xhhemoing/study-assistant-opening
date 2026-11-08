import { expect, it, vi } from "vitest";
import type { Scope } from "@aistudy/contracts";
import type { Sql, TransactionSql } from "postgres";
import { validateLearningDecision } from "@aistudy/domain";
vi.mock("./opening-learner-state-read", () => ({ readOpeningLearnerState: vi.fn(async () => ({ stateVersion: "state", sourceVersions: {}, dataAsOf: "2026-10-27T00:00:00Z" })) }));
import { captureOpeningCourseRouteDecision } from "./opening-course-route-decision";
import { spanTutorReceiptDecision } from "./opening-span-tutor-context";
import { readOpeningTeachingCompilerFocus } from "./opening-teaching-focus";

it.each([
  { policyVersion: "next-learning-step-1/span-tutor-execution-1", reasonCode: "assistance_dependent", activityKind: "reduced_help_practice" },
  { policyVersion: "next-learning-step-2/span-tutor-execution-2", reasonCode: "needs_check", activityKind: "diagnose" },
  { policyVersion: "next-learning-step-3/span-tutor-execution-2", reasonCode: "assisted_success", activityKind: "reduced_help_practice" },
])("reads the captured $policyVersion decision without applying today's rules", ({ policyVersion, ...ruleDecision }) => {
  const decision = { ...ruleDecision, focusObservationId: null };
  const receipt = { policyVersion, intentVersion: JSON.stringify({ ruleDecision: decision }) };
  const before = structuredClone(receipt);
  expect(spanTutorReceiptDecision(receipt)).toEqual(decision);
  expect(receipt).toEqual(before);
  expect(spanTutorReceiptDecision({ ...receipt, policyVersion: "unknown-policy" })).toBeNull();
});

it("keeps a historical route-assisted-correction teaching snapshot readable without rewriting its reason", async () => {
  const learnerFocus = { skillLabel: "秩", requirementKey: "key", activityKind: "reduced_help_practice", reasonCode: "route_assisted_correction",
    focusObservationId: null, recentAssistance: ["hinted", "independent"], strategyVersion: "course-route-1" };
  const query = vi.fn(async () => [{ course_id: "c", goal_json: { learnerFocus } }]);
  expect(await readOpeningTeachingCompilerFocus(query as unknown as Sql, { workspaceId: "w", ownerUserId: "u" }, "a"))
    .toEqual({ learnerFocus });
  expect(query).toHaveBeenCalledTimes(1);
});

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

it("共享受助成功：回执记录规范策略而非路线覆盖，不冒充显式巩固请求", async () => {
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
  expect(receipt.reasonCodes).toContain("teaching:assisted_success");
  expect(receipt.reasonCodes.some(code => code.startsWith("teaching_override:"))).toBe(false);
  expect(receipt.reasonCodes.some(code => code.includes("consolidate"))).toBe(false);
  expect(receipt.candidates).not.toContainEqual(expect.objectContaining({ reasonCodes: expect.arrayContaining(["overridden_by_route_assisted_correction"]) }));
  // origin and decision-input references to the same observation appear once.
  expect(receipt.evidenceRefs.filter(ref => ref === "observation:helped")).toHaveLength(1);
  const captured = JSON.parse(receipt.intentVersion);
  expect(captured.decisionInput).toEqual(input.decisionInput);
  expect(captured.teaching.decision).toEqual({ activityKind: "reduced_help_practice", reasonCode: "assisted_success", focusObservationId: null });
  expect(captured.teaching.candidates.at(-1)).toEqual({ action: "reduced_help_practice", eligible: true,
    reasonCodes: ["assisted_success"], evidenceRefs: ["observation:helped"] });
  expect(captured).not.toHaveProperty("teachingOverride");
});
