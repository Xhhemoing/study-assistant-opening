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

/** Course study plan: material split into lessons, `lessonsPerDay` of them a day from `startDate`. */
export const studyPlanSettingsSchema = z
  .object({
    lessonsPerDay: z.number().int().min(1).max(8),
    lessonMinutes: z.number().int().min(10).max(180),
    startDate: localDateSchema,
  })
  .strict();

export const courseGoalSchema = z
  .object({
    /** Exam or deadline; null = no fixed date. */
    targetDate: localDateSchema.nullable(),
    weeklyMinutes: z.number().int().min(0).max(3000),
    /** Omitted = the course has no study plan; the planner then never adds its lessons. */
    studyPlan: studyPlanSettingsSchema.optional(),
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
export type StudyPlanSettings = z.infer<typeof studyPlanSettingsSchema>;

/** PUT body for a course's study plan; `plan: null` stops it (existing tasks stay). */
export const courseStudyPlanInputSchema = z
  .object({
    plan: studyPlanSettingsSchema.nullable(),
    targetDate: localDateSchema.nullable(),
  })
  .strict();

export const courseStudyPlanLessonSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string().max(240),
    pageFrom: z.number().int().positive().nullable(),
    pageTo: z.number().int().positive().nullable(),
    status: z.enum(["taught", "today", "planned", "unscheduled"]),
    /** Taught or planned local date. */
    date: localDateSchema.nullable(),
  })
  .strict();

/** What the course page shows: the lessons, when each is (or was) taught, and whether the pace fits. */
export const courseStudyPlanViewSchema = z
  .object({
    courseId: uuidSchema,
    plan: studyPlanSettingsSchema.nullable(),
    targetDate: localDateSchema.nullable(),
    lessons: z.array(courseStudyPlanLessonSchema).max(500),
    reviewDates: z.array(localDateSchema).max(200),
    finishDate: localDateSchema.nullable(),
    behind: z.boolean(),
    /** No ready, unexcluded material yet: nothing to plan. */
    noMaterial: z.boolean(),
  })
  .strict();

export type CourseStudyPlanInput = z.infer<typeof courseStudyPlanInputSchema>;
export type CourseStudyPlanLesson = z.infer<typeof courseStudyPlanLessonSchema>;
export type CourseStudyPlanView = z.infer<typeof courseStudyPlanViewSchema>;
export type OpeningAdaptivePrefs = z.infer<typeof openingAdaptivePrefsSchema>;
export type OpeningAdaptivePrefsPatch = z.infer<typeof openingAdaptivePrefsPatchSchema>;
export type OpeningAdaptivePrefsResponse = z.infer<typeof openingAdaptivePrefsResponseSchema>;
