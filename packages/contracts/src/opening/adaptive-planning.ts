import { z } from "zod";
import { isoDateTimeSchema, uuidSchema } from "./foundation";
import { goalLearningModeSchema } from "./goal-learning";

/**
 * UX policy §3 intervention modes for the daily plan.
 * manual: the system never proposes or changes the plan;
 * copilot (default): proposes a draft, the learner confirms;
 * coach: confirms within `coachBudgetMinutes`, with a one-click undo.
 */
export const planningAutonomySchema = z.enum(["manual", "copilot", "coach"]);

const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const instant = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === value;
}, "Invalid calendar date");

export const courseMilestoneEvidenceRefSchema = z.object({
  kind: z.enum(["attempt", "observation", "teaching_activity"]),
  id: uuidSchema,
}).strict();

const milestoneDefinition = {
  id: uuidSchema,
  title: z.string().trim().min(1).max(120),
  successCriteria: z.string().trim().min(1).max(500),
  targetDate: localDateSchema.nullable(),
  evidenceRefs: z.array(courseMilestoneEvidenceRefSchema).max(8),
};

const milestoneVersionSchema = z.object({
  ...milestoneDefinition,
  revision: z.number().int().positive(),
  status: z.enum(["planned", "confirmed_by_learner"]),
  confirmedAt: isoDateTimeSchema.nullable(),
}).strict();

/** Self-assessment only. No milestone status establishes independent mastery. */
export const courseMilestoneSchema = milestoneVersionSchema.extend({
  history: z.array(milestoneVersionSchema).max(50),
}).strict();

export const courseMilestoneUpdateSchema = z.object({
  ...milestoneDefinition,
  /** Confirmation is explicit and separate from changing the success criteria. */
  confirm: z.boolean().optional(),
}).strict();

export const courseGoalSchema = z
  .object({
    /** Exam or deadline; null = no fixed date. */
    targetDate: localDateSchema.nullable(),
    weeklyMinutes: z.number().int().min(0).max(3000),
    learningMode: goalLearningModeSchema.optional(),
    priority: z.number().int().min(0).max(5).optional(),
    revision: z.number().int().nonnegative().optional(),
    milestones: z.array(courseMilestoneSchema).max(8).optional(),
    goalId: uuidSchema.optional(),
    kind: z.enum(["final-exam", "entrance-exam", "interest", "maintenance", "custom"]).optional(),
    examDate: localDateSchema.nullable().optional(),
    lifecycle: z.enum(["active", "maintenance", "reduced", "paused", "archived", "stopped"]).optional(),
    successCriteria: z.string().max(2000).optional(),
  })
  .strict();

/** Public writes cannot supply stored revisions, history or confirmation timestamps. */
export const courseGoalUpdateSchema = z.object({
  targetDate: localDateSchema.nullable(),
  weeklyMinutes: z.number().int().min(0).max(3000),
  learningMode: goalLearningModeSchema.optional(),
  priority: z.number().int().min(0).max(5).optional(),
  milestones: z.array(courseMilestoneUpdateSchema).max(8).optional(),
}).strict();

/** An explicit course-local span opt-in; account switches remain authoritative. */
export const spanTutorGrantSchema = z.object({
  enabled: z.boolean(),
  dailyMinutes: z.number().int().min(10).max(180),
  revision: z.number().int().positive(),
  confirmedAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  expiresOn: localDateSchema.nullable(),
}).strict();
export const spanTutorGrantUpdateSchema = z.object({
  courseId: uuidSchema.transform(value => value.toLowerCase()),
  enabled: z.boolean(),
  dailyMinutes: z.number().int().min(10).max(180),
  expiresOn: localDateSchema.nullable(),
  expectedRevision: z.number().int().nonnegative(),
}).strict();
export type SpanTutorGrant = z.infer<typeof spanTutorGrantSchema>;
export type SpanTutorGrantUpdate = z.infer<typeof spanTutorGrantUpdateSchema>;
/** Stored in workspace_preferences.adaptive_planning, apart from semester settings. */
export const openingAdaptivePrefsSchema = z
  .object({
    autonomy: planningAutonomySchema,
    coachBudgetMinutes: z.number().int().min(10).max(600),
    /** Explicit automation opt-in; absent historical coach preferences remain advisory. */
    coachAutoAcceptEnabled: z.boolean().optional(),
    courseGoals: z.record(uuidSchema, courseGoalSchema),
    /** Persisted selections only; formal course_goals own the selected definitions. */
    courseGoalRefs: z.record(uuidSchema, uuidSchema).optional(),
    spanTutorGrants: z.record(uuidSchema.refine(value => value === value.toLowerCase(), "Course grant keys must be canonical UUIDs"), spanTutorGrantSchema).optional(),
    /** Server-owned monotonic revisions survive explicit goal removal. */
    courseGoalRevisions: z.record(uuidSchema, z.number().int().nonnegative()).optional(),
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
    coachAutoAcceptEnabled: z.boolean().optional(),
    spanTutorGrant: spanTutorGrantUpdateSchema.optional(),
    courseGoal: z
      .object({
        courseId: uuidSchema,
        goal: courseGoalUpdateSchema.nullable(),
        expectedRevision: z.number().int().nonnegative().optional(),
      })
      .strict()
      .superRefine((value, ctx) => {
        if (value.goal?.milestones !== undefined && value.expectedRevision === undefined) {
          ctx.addIssue({ code: "custom", path: ["expectedRevision"], message: "Milestone updates require the current goal revision" });
        }
        const ids = value.goal?.milestones?.map(item => item.id) ?? [];
        if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", path: ["goal", "milestones"], message: "Milestone ids must be unique" });
      })
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
export type CourseGoalUpdate = z.infer<typeof courseGoalUpdateSchema>;
export type CourseMilestone = z.infer<typeof courseMilestoneSchema>;
export type CourseMilestoneUpdate = z.infer<typeof courseMilestoneUpdateSchema>;
export type CourseMilestoneEvidenceRef = z.infer<typeof courseMilestoneEvidenceRefSchema>;
export type OpeningAdaptivePrefs = z.infer<typeof openingAdaptivePrefsSchema>;
export type OpeningAdaptivePrefsPatch = z.infer<typeof openingAdaptivePrefsPatchSchema>;
export type OpeningAdaptivePrefsResponse = z.infer<typeof openingAdaptivePrefsResponseSchema>;
