import { z } from "zod";
import { spanLessonSnapshotSchema, spanHintLevelSchema, studyIntentEventSchema, learningAttemptSchema, learningObservationSchema } from "@aistudy/contracts";
import { createSessionFetch } from "../../../auth/session-expiry";
const originChangeSchema = z.object({
  reason: z.enum(["evidence_changed", "source_unavailable"]),
  originSession: spanLessonSnapshotSchema.nullable(),
  observationId: z.string().uuid().nullable(),
}).strict();
export const spanExecutionPhaseSchema = z.object({ phase: z.enum(["explore", "new_learning", "consolidate", "maintain"]), source: z.enum(["automatic", "explicit"]) });
export type SpanExecutionPhase = z.infer<typeof spanExecutionPhaseSchema>;
export const spanLessonDetailsSchema = z.object({ targetedFocus: z.string().min(1).max(100).optional(), estimateMinutes: z.number().int().positive().max(1440).nullable().optional(), session: spanLessonSnapshotSchema.nullable(), executionPhase: spanExecutionPhaseSchema.nullish(), attempts: z.array(learningAttemptSchema), observations: z.array(learningObservationSchema), assistance: z.record(z.string(), z.enum(["none", "hinted", "revealed"])), hintLevels: z.record(z.string(), z.array(spanHintLevelSchema)).default({}), intentEvent: studyIntentEventSchema.nullable().default(null), originChange: originChangeSchema.nullish() });
export type SpanLessonDetails = z.infer<typeof spanLessonDetailsSchema>;
export async function spanLessonRequest<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  const response = await createSessionFetch(fetch)(path, { ...init, headers: { "content-type": "application/json", ...init?.headers }, cache: "no-store" });
  const body: unknown = await response.json();
  if (!response.ok) {
    const error = z.object({ error: z.object({ message: z.string() }) }).safeParse(body);
    throw new Error(error.success ? error.data.error.message : "学习进度暂未确认；原题和答案保留，请重新读取。");
  }
  return schema.parse(body);
}
