import { expect, it } from "vitest";
import { spanRepairPlanSchema } from "./span-repair";
import { spanPrerequisiteRepairPlanSchema, spanPrerequisiteReturnInputSchema, spanPrerequisiteIssueInputSchema } from "./span-prerequisite-runtime";
const p = "11111111-1111-4111-8111-111111111111", t = "22222222-2222-4222-8222-222222222222";
const prerequisite = { id: p, revision: 1, stableSkillId: p, requirementKey: "span:linear-combination:v1" };
const target = { id: t, revision: 2, stableSkillId: t, requirementKey: "requirement:target" };
export const runtimePlan = () => ({ version: 1, contentVersion: 1, status: "ready", targetSkill: "equation",
  qualification: { status: "verified_weak", courseId: p, targetRequirement: target, prerequisiteRequirement: prerequisite,
    relationSource: "confirmed_course_requirement", returnToRequirementId: t,
    basis: { observationId: p, rootObservationId: p, attemptId: p, problemId: p, itemVersionId: p,
      sourceRefs: [{ sourceId: p, sourceVersion: 1 }], evaluatorVersion: "span-exact-v1", specVersion: "span-v1" },
    evaluatedContent: { problemId: "span-example-2d", version: "1" } },
  courseBinding: { version: 1, origin: "confirmed_course_route", courseId: p, routeActivityId: p, goalId: p, goalRevision: 1,
    requirement: prerequisite, returnTarget: target, relationSource: "confirmed_course_requirement" },
  teachingExample: { problemId: "example", version: "1" }, practiceVariant: { problemId: "variant", version: "1" }, returnToRequirementId: t });
it("accepts one internally consistent B plan without broadening strict A v1", () => {
  expect(spanPrerequisiteRepairPlanSchema.safeParse(runtimePlan()).success).toBe(true);
  expect(spanRepairPlanSchema.safeParse(runtimePlan()).success).toBe(false);
});
it.each(["basis", "target", "return", "unknown_version", "ambiguous_plan"])("rejects %s disagreement instead of reinterpreting it", kind => {
  const plan = runtimePlan();
  if (kind === "basis") plan.qualification.status = "unknown";
  if (kind === "target") plan.courseBinding.returnTarget = { ...target, revision: 3 };
  if (kind === "return") plan.returnToRequirementId = p;
  if (kind === "unknown_version") plan.version = 2;
  const raw = kind === "ambiguous_plan" ? { ...plan, repair: {} } : plan;
  expect(spanPrerequisiteRepairPlanSchema.safeParse(raw).success).toBe(false);
});
it("accepts no nullable confirmation or client target/boolean authority on explicit return", () => {
  const input = { prerequisiteRepairVersion: 1, activityId: p, expectedRevision: 3, observationId: t, clientKey: "explicit-return" };
  expect(spanPrerequisiteReturnInputSchema.parse(input)).toEqual(input);
  for (const extra of [{ observationId: null }, { returnToRequirementId: p }, { repairVersion: 1 }, { trusted: true }])
    expect(spanPrerequisiteReturnInputSchema.safeParse({ ...input, ...extra }).success).toBe(false);
});
it("limits same-item retry to the variant stage", () => {
  const input = { prerequisiteRepairVersion: 1, activityId: p, expectedRevision: 3, clientKey: "explicit-issue", retryAfterAttemptId: t };
  expect(spanPrerequisiteIssueInputSchema.safeParse({ ...input, stage: "variant" }).success).toBe(true);
  expect(spanPrerequisiteIssueInputSchema.safeParse({ ...input, stage: "confirmation" }).success).toBe(false);
});
