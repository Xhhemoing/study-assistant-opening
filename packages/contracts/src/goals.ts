import { z } from "zod";

export const scenarioPresetSchema = z.enum(["final", "gaokao", "kaoyan", "custom"]);

export const studyGoalSchema = z.object({
  id: z.string().uuid(),
  ownerUserId: z.string().uuid(),
  title: z.string().min(1).max(80),
  scenario: scenarioPresetSchema,
  examDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  subjects: z.array(z.string().min(1)).max(12),
  dailyMinutes: z.number().int().min(5).max(600),
  courseId: z.string().uuid().nullable(),
  archivedAt: z.string().datetime().nullable(),
  strategyVersion: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const studyGoalInputSchema = z.object({
  title: z.string().min(1).max(80).default("未命名目标"),
  scenario: scenarioPresetSchema.default("final"),
  examDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .default(null),
  subjects: z.array(z.string().min(1)).max(12).default([]),
  dailyMinutes: z.number().int().min(5).max(600).default(45),
  courseId: z.string().uuid().nullable().default(null),
});

export type ScenarioPreset = z.infer<typeof scenarioPresetSchema>;
export type StudyGoal = z.infer<typeof studyGoalSchema>;
export type StudyGoalInput = z.input<typeof studyGoalInputSchema>;
