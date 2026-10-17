import { z } from "zod";
import { uuidSchema } from "./foundation";

/** Execution preference; it never changes what counts as independent evidence. */
export const goalLearningModeSchema = z.enum(["auto", "understand", "exam"]);

/** Server-derived policy captured with a teaching activity. */
export const goalLearningContextSchema = z.object({
  mode: z.enum(["understand", "exam"]),
  reasonCode: z.enum(["selected_exam", "selected_understand", "deadline_near", "long_term"]),
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  daysRemaining: z.number().int().nonnegative().nullable(),
  priority: z.number().int().min(0).max(5),
  prerequisiteBudgetMinutes: z.number().int().min(1).max(30),
}).strict();

/** One bounded prerequisite prelude, followed by the original target in the same activity. */
export const prerequisiteRepairSchema = z.object({
  nodeId: uuidSchema,
  targetNodeId: uuidSchema,
  skillLabel: z.string().min(1).max(200),
  returnToSkillLabel: z.string().min(1).max(200),
  maxMinutes: z.number().int().min(1).max(30),
  reason: z.string().min(1).max(500),
  stopCondition: z.string().min(1).max(500),
}).strict();

export type GoalLearningMode = z.infer<typeof goalLearningModeSchema>;
export type GoalLearningContext = z.infer<typeof goalLearningContextSchema>;
export type PrerequisiteRepair = z.infer<typeof prerequisiteRepairSchema>;
