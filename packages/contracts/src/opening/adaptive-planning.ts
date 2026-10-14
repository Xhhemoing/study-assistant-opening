import { z } from "zod";
import { uuidSchema } from "./foundation";

/**
 * UX policy §3 intervention modes for the daily plan.
 * manual: the system never proposes or changes the plan;
 * copilot (default): proposes a draft, the learner confirms;
 * coach: confirms within `coachBudgetMinutes`, with a one-click undo.
 */
export const planningAutonomySchema = z.enum(["manual", "copilot", "coach"]);

const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const courseGoalSchema = z
  .object({
    /** Exam or deadline; null = no fixed date. */
    targetDate: localDateSchema.nullable(),
    weeklyMinutes: z.number().int().min(0).max(3000),
  })
  .strict();

/** Stored in workspace_preferences.adaptive_planning, apart from semester settings. */
export const openingAdaptivePrefsSchema = z
  .object({
    autonomy: planningAutonomySchema,
    coachBudgetMinutes: z.number().int().min(10).max(600),
    courseGoals: z.record(uuidSchema, courseGoalSchema),
  })
  .strict();

export const DEFAULT_OPENING_ADAPTIVE_PREFS: OpeningAdaptivePrefs = {
  autonomy: "copilot",
  coachBudgetMinutes: 60,
  courseGoals: {},
};

/** Partial update merged under a row lock; `courseGoal.goal: null` removes that course's goal. */
export const openingAdaptivePrefsPatchSchema = z
  .object({
    autonomy: planningAutonomySchema.optional(),
    coachBudgetMinutes: z.number().int().min(10).max(600).optional(),
    courseGoal: z
      .object({ courseId: uuidSchema, goal: courseGoalSchema.nullable() })
      .strict()
      .optional(),
  })
  .strict();

export const openingAdaptivePrefsResponseSchema = z
  .object({
    prefs: openingAdaptivePrefsSchema,
    saved: z.boolean(),
    invalidStoredPrefs: z.boolean(),
  })
  .strict();

export type PlanningAutonomy = z.infer<typeof planningAutonomySchema>;
export type CourseGoal = z.infer<typeof courseGoalSchema>;
export type OpeningAdaptivePrefs = z.infer<typeof openingAdaptivePrefsSchema>;
export type OpeningAdaptivePrefsPatch = z.infer<typeof openingAdaptivePrefsPatchSchema>;
export type OpeningAdaptivePrefsResponse = z.infer<typeof openingAdaptivePrefsResponseSchema>;
