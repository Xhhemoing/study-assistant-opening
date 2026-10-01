import { z } from "zod";
import { uuidSchema } from "./foundation";
import { learningObservationSchema } from "./learning";

export const courseLearningHistoryInputSchema = z.object({
  courseId: uuidSchema,
  // Absent means all requirements; null means unassigned. Empty keys remain distinct.
  requirementKey: z.string().max(200).nullable().optional(),
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.number().int().min(1).max(200).default(50),
}).strict();

export const courseLearningHistoryPageSchema = z.object({
  observations: z.array(learningObservationSchema).max(200),
  snapshotRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  nextCursor: z.string().min(1).max(2048).nullable(),
  totalCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  visibilityChanged: z.boolean(),
}).strict();

export type CourseLearningHistoryInput = z.infer<typeof courseLearningHistoryInputSchema>;
export type CourseLearningHistoryPage = z.infer<typeof courseLearningHistoryPageSchema>;
