import { z } from "zod";
import { calendarDateSchema, isoDateTimeSchema, uuidSchema } from "./foundation";
import { courseGoalSchema, courseMilestoneSchema, courseMilestoneUpdateSchema } from "./adaptive-planning";
import { goalLearningModeSchema } from "./goal-learning";

export const learningGoalKindSchema = z.enum(["final-exam", "entrance-exam", "interest", "maintenance", "custom"]);
export const learningGoalLifecycleSchema = z.enum(["active", "maintenance", "reduced", "paused", "archived", "stopped"]);
const definition = {
  courseIds: z.array(uuidSchema).min(1).max(50).refine(ids => new Set(ids).size === ids.length, "Courses must be unique"),
  title: z.string().trim().min(1).max(160), kind: learningGoalKindSchema,
  targetDate: calendarDateSchema.nullable(), examDate: calendarDateSchema.nullable(),
  weeklyMinutes: z.number().int().min(0).max(3000), priority: z.number().int().min(0).max(5),
  learningMode: goalLearningModeSchema, successCriteria: z.string().trim().max(2000),
};
export const learningGoalSchema = z.object({ ...definition, id: uuidSchema, workspaceId: uuidSchema,
  revision: z.number().int().positive(), lifecycle: learningGoalLifecycleSchema,
  maintenanceIntervalDays: z.number().int().min(1).max(365).nullable(), milestones: z.array(courseMilestoneSchema).max(8),
  createdAt: isoDateTimeSchema, updatedAt: isoDateTimeSchema,
}).strict();
export const learningGoalCreateSchema = z.object({ ...definition, clientKey: z.string().min(8).max(160) }).strict()
  .refine(value => value.examDate === null || ["final-exam", "entrance-exam"].includes(value.kind), "Only an exam goal has an exam date");
export const learningGoalUpdateSchema = z.object({ ...z.object(definition).partial().shape,
  expectedRevision: z.number().int().positive(), lifecycle: learningGoalLifecycleSchema.optional(),
  maintenanceIntervalDays: z.number().int().min(1).max(365).nullable().optional(),
  milestones: z.array(courseMilestoneUpdateSchema).max(8).optional(),
}).strict();
export const learningGoalListSchema = z.object({ goals: z.array(learningGoalSchema), selectedGoalIds: z.record(uuidSchema, uuidSchema),
  legacyConflicts: z.array(z.object({ courseId: uuidSchema, legacyGoal: courseGoalSchema, candidateGoalIds: z.array(uuidSchema) }).strict()),
}).strict();
export const learningGoalSelectSchema = z.object({ courseId: uuidSchema, goalId: uuidSchema,
  expectedRevision: z.number().int().positive(), expectedSelectedGoalId: uuidSchema.nullable(), resolveLegacy: z.boolean().optional(),
}).strict();
export type LearningGoal = z.infer<typeof learningGoalSchema>;
export type LearningGoalCreate = z.infer<typeof learningGoalCreateSchema>;
export type LearningGoalUpdate = z.infer<typeof learningGoalUpdateSchema>;
export type LearningGoalList = z.infer<typeof learningGoalListSchema>;
