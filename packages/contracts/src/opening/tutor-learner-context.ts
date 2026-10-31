import { z } from "zod";
import { isoDateTimeSchema, uuidSchema } from "./foundation";
import { courseGoalSchema } from "./adaptive-planning";
import { learningPreferencesSchema } from "../workspace-preferences";

const configuredSwitches = learningPreferencesSchema.partial().strict();
const goalDefinition = courseGoalSchema.omit({ milestones: true, goalId: true, revision: true, lifecycle: true });
const goalPreferenceProfileSchema = z.object({
  version: z.literal(1),
  goal: z.discriminatedUnion("source", [
    z.object({ source: z.literal("course_goals"), goalId: uuidSchema, revision: z.number().int().positive(),
      lifecycle: courseGoalSchema.shape.lifecycle.unwrap(), definition: goalDefinition }).strict(),
    z.object({ source: z.literal("legacy"), revision: z.number().int().nonnegative().nullable(),
      lifecycle: z.literal("unknown"), definition: goalDefinition }).strict(),
    z.object({ source: z.literal("unknown"), reason: z.enum(["missing", "invalid", "cleared", "unresolved"]) }).strict(),
  ]),
  learningPreferences: z.object({
    effective: learningPreferencesSchema,
    /** Only stored switches appear here; defaults are not confirmed preferences. */
    account: configuredSwitches,
    course: configuredSwitches.omit({ autoGradeOnSave: true }),
  }).strict(),
}).strict();

/** Server-only, course-scoped facts consumed by one tutoring request. */
export const tutorLearnerContextSchema = z.object({
  courseId: uuidSchema, title: z.string().max(200), asOf: isoDateTimeSchema,
  privacyEpoch: z.number().int().nonnegative(),
  goalPreferenceProfile: goalPreferenceProfileSchema.optional(),
  goal: z.object({ description: z.string().max(1000), targetDate: z.string().nullable(), weeklyMinutes: z.number().nonnegative().nullable() }).strict(),
  weaknesses: z.array(z.object({ skillLabel: z.string().max(200), requirementKey: z.string().nullable(),
    incorrect: z.number().int().nonnegative(), assisted: z.number().int().nonnegative(), samples: z.number().int().positive(),
  }).strict()).max(5),
  recentMistakes: z.array(z.object({ observationId: uuidSchema, skillLabel: z.string().max(200), feedback: z.string().max(1200),
    unmetCriteria: z.array(z.string().max(240)).max(6), assistance: z.enum(["independent", "hinted", "revealed", "unknown"]),
  }).strict()).max(3),
  observationIds: z.array(uuidSchema).max(30),
  sourceRefs: z.array(z.object({ sourceId: uuidSchema, sourceVersion: z.number().int().nonnegative() }).strict()).max(960),
}).strict();
export type TutorLearnerContext = z.infer<typeof tutorLearnerContextSchema>;
