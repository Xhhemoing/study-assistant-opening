import { z } from "zod";
import { uuidSchema } from "./foundation";
import { courseRequirementBindingSchema } from "./learning-attempts";

/** Server-owned snapshot, not an HTTP authorization credential. Readers must verify its receipt and live scope. */
export const spanCourseBindingSchema = z.object({
  version: z.literal(1), origin: z.literal("confirmed_course_route"),
  courseId: uuidSchema, routeActivityId: uuidSchema,
  goalId: uuidSchema, goalRevision: z.number().int().positive(),
  requirement: courseRequirementBindingSchema,
  // Reserved for R2. R1 does not create or execute a return target.
  returnTarget: courseRequirementBindingSchema.optional(),
  relationSource: z.literal("confirmed_course_requirement").optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.returnTarget === undefined) !== (value.relationSource === undefined))
    ctx.addIssue({ code: "custom", path: ["returnTarget"], message: "Return target and confirmed relation must be supplied together" });
  if (value.returnTarget && (value.returnTarget.id === value.requirement.id || value.returnTarget.stableSkillId === value.requirement.stableSkillId))
    ctx.addIssue({ code: "custom", path: ["returnTarget"], message: "Return target must have a distinct requirement and skill" });
});
export type SpanCourseBinding = z.infer<typeof spanCourseBindingSchema>;
