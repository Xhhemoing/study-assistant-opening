import { z } from "zod";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, "must use HH:mm");

const clockRangeSchema = z
  .object({
    start: hhmm,
    end: hhmm,
  })
  .strict();

/** Same-day range: end must be strictly after start. */
const sameDayRangeSchema = clockRangeSchema.superRefine((value, ctx) => {
  if (value.end <= value.start) {
    ctx.addIssue({
      code: "custom",
      message: "end must be after start on the same day",
      path: ["end"],
    });
  }
});

/**
 * Sleep may cross midnight (e.g. 23:00–07:00). Same-day sleep (end > start)
 * is also allowed.
 */
const sleepRangeSchema = clockRangeSchema;

const periodClockSchema = z
  .object({
    start: hhmm,
    end: hhmm,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.end <= value.start) {
      ctx.addIssue({
        code: "custom",
        message: "period end must be after period start",
        path: ["end"],
      });
    }
  });

export const openingPlanningSettingsSchema = z
  .object({
    weekOneMonday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    periodTimes: z.record(z.string().regex(/^\d+$/), periodClockSchema),
    dailyWindow: sameDayRangeSchema,
    lunch: sameDayRangeSchema,
    dinner: sameDayRangeSchema,
    sleep: sleepRangeSchema,
    timeZone: z.string().min(1).max(80),
  })
  .strict();

export type OpeningPlanningSettings = z.infer<typeof openingPlanningSettingsSchema>;

/** Form / recovery defaults; weekOneMonday and periodTimes must be set before derive. */
export const DEFAULT_OPENING_PLANNING_SETTINGS: OpeningPlanningSettings = {
  weekOneMonday: "1970-01-05",
  periodTimes: {},
  dailyWindow: { start: "07:30", end: "22:30" },
  lunch: { start: "12:00", end: "13:00" },
  dinner: { start: "17:30", end: "18:30" },
  sleep: { start: "23:00", end: "07:00" },
  timeZone: "Asia/Shanghai",
};

export const openingPlanningSettingsResponseSchema = z
  .object({
    settings: openingPlanningSettingsSchema.nullable(),
    saved: z.boolean(),
    invalidStoredSettings: z.boolean(),
  })
  .strict();

export type OpeningPlanningSettingsResponse = z.infer<
  typeof openingPlanningSettingsResponseSchema
>;
