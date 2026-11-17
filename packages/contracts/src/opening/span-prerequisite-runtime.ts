import { z } from "zod";
import { uuidSchema } from "./foundation";
import { spanCourseBindingSchema } from "./span-course-binding";
import { spanPrerequisiteQualificationSchema, spanRepairTargetSchema, spanRepairRequirementIdentitySchema } from "./span-repair";

const item = z.object({ problemId: z.string().min(1).max(100), version: z.string().min(1).max(30) }).strict();
/** Separate B authority; A's strict v1 prerequisite remains unknown. Never expose this plan. */
export const spanPrerequisiteRepairPlanSchema = z.object({
  version: z.literal(1), contentVersion: z.literal(1), status: z.literal("ready"),
  qualification: spanPrerequisiteQualificationSchema.refine(value => value.status === "verified_weak"),
  courseBinding: spanCourseBindingSchema, targetSkill: spanRepairTargetSchema,
  teachingExample: item, practiceVariant: item, returnToRequirementId: uuidSchema,
}).strict().superRefine((plan, ctx) => {
  const q = plan.qualification, b = plan.courseBinding;
  const same = (a: z.infer<typeof spanRepairRequirementIdentitySchema>, b: z.infer<typeof spanRepairRequirementIdentitySchema>) =>
    a.id === b.id && a.revision === b.revision && a.stableSkillId === b.stableSkillId && a.requirementKey === b.requirementKey;
  if (q.status !== "verified_weak" || b.courseId !== q.courseId || !b.returnTarget
    || !same(b.requirement, q.prerequisiteRequirement) || !same(b.returnTarget, q.targetRequirement)
    || b.relationSource !== q.relationSource || plan.returnToRequirementId !== q.returnToRequirementId
    || plan.returnToRequirementId !== b.returnTarget.id)
    ctx.addIssue({ code: "custom", message: "Qualification, direct relation and return target must share one exact identity" });
  if (plan.teachingExample.problemId === plan.practiceVariant.problemId)
    ctx.addIssue({ code: "custom", path: ["practiceVariant"], message: "Two distinct teaching identities are required" });
});
export type SpanPrerequisiteRepairPlan = z.infer<typeof spanPrerequisiteRepairPlanSchema>;
export const spanPrerequisiteRepairContextSchema = z.object({ version: z.literal(1), status: z.literal("ready"),
  targetSkill: spanRepairTargetSchema, focusSummary: z.string().min(1),
  prerequisiteRequirement: spanRepairRequirementIdentitySchema, targetRequirement: spanRepairRequirementIdentitySchema,
  returnToRequirementId: uuidSchema,
}).strict();
export const spanPrerequisiteRefusalReasonSchema = z.enum([
  "SPAN_COURSE_BINDING_CHANGED", "SPAN_PREREQUISITE_RELATION_CHANGED", "SPAN_PREREQUISITE_EVIDENCE_CHANGED",
  "SPAN_PREREQUISITE_SOURCE_UNAVAILABLE", "SPAN_PREREQUISITE_CONTENT_UNSUPPORTED", "SPAN_PREREQUISITE_PLAN_UNSUPPORTED",
  "SPAN_PREREQUISITE_RECEIPT_MISMATCH",
]);
export type SpanPrerequisiteRefusalReason = z.infer<typeof spanPrerequisiteRefusalReasonSchema>;
export const spanPrerequisitePresentationInputSchema = z.object({ activityId: uuidSchema, prerequisiteRepairVersion: z.literal(1),
  stage: z.literal("example"), clientKey: z.string().min(8).max(160),
}).strict();
export const spanPrerequisiteIssueInputSchema = z.object({ activityId: uuidSchema, prerequisiteRepairVersion: z.literal(1),
  expectedRevision: z.number().int().positive(), stage: z.enum(["variant", "confirmation"]),
  clientKey: z.string().min(8).max(160), retryAfterAttemptId: uuidSchema.optional(),
}).strict().superRefine((input, ctx) => {
  if (input.retryAfterAttemptId && input.stage !== "variant")
    ctx.addIssue({ code: "custom", path: ["retryAfterAttemptId"], message: "Only the current variant accepts a retry" });
});
export const spanPrerequisiteReturnInputSchema = z.object({ activityId: uuidSchema, prerequisiteRepairVersion: z.literal(1),
  expectedRevision: z.number().int().positive(), observationId: uuidSchema, clientKey: z.string().min(8).max(160),
}).strict();
export type SpanPrerequisiteReturnInput = z.infer<typeof spanPrerequisiteReturnInputSchema>;
