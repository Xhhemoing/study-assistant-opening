import { z } from "zod";
import { spanPrerequisiteRepairContextSchema, spanPrerequisiteRefusalReasonSchema, spanRepairContextSchema, spanLessonSnapshotSchema, spanHintLevelSchema, studyIntentEventSchema, learningAttemptSchema, learningObservationSchema } from "@aistudy/contracts";
import { createSessionFetch } from "../../../auth/session-expiry";
const originChangeSchema = z.object({
  reason: z.enum(["evidence_changed", "source_unavailable"]),
  originSession: spanLessonSnapshotSchema.nullable(),
  observationId: z.string().uuid().nullable(),
}).strict();
export const spanExecutionPhaseSchema = z.object({ phase: z.enum(["explore", "new_learning", "consolidate", "maintain"]), source: z.enum(["automatic", "explicit"]) });
export type SpanExecutionPhase = z.infer<typeof spanExecutionPhaseSchema>;
export const spanLessonDetailsSchema = z.object({ repair: spanRepairContextSchema.optional(), prerequisiteRepair: spanPrerequisiteRepairContextSchema.optional(), executionUnavailable: z.object({ reasonCode: spanPrerequisiteRefusalReasonSchema, message: z.string().min(1) }).strict().optional(), targetedFocus: z.string().min(1).max(100).optional(), estimateMinutes: z.number().int().positive().max(1440).nullable().optional(), session: spanLessonSnapshotSchema.nullable(), executionPhase: spanExecutionPhaseSchema.nullish(), attempts: z.array(learningAttemptSchema), observations: z.array(learningObservationSchema), assistance: z.record(z.string(), z.enum(["none", "hinted", "revealed"])), hintLevels: z.record(z.string(), z.array(spanHintLevelSchema)).default({}), intentEvent: studyIntentEventSchema.nullable().default(null), originChange: originChangeSchema.nullish() }).superRefine((details, context) => {
  if (details.prerequisiteRepair && details.executionUnavailable) context.addIssue({ code: "custom", message: "学习依据暂不可执行，请重新读取；未回退普通学习。" });
  if (details.repair && details.prerequisiteRepair) context.addIssue({ code: "custom", message: "学习依据冲突，请重新读取；未回退普通学习。" });
});
// Bound locally only after a successful lesson read/create confirms the route reference.
export type SpanLessonDetails = z.infer<typeof spanLessonDetailsSchema> & { continuityRetestId?: string };
export class SpanLessonRequestError extends Error {
  constructor(readonly status: number, readonly code: string | undefined, message: string) {
    super(message);
    this.name = "SpanLessonRequestError";
  }
}
export async function spanLessonRequest<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  const response = await createSessionFetch(fetch)(path, { ...init, headers: { "content-type": "application/json", ...init?.headers }, cache: "no-store" });
  const body: unknown = await response.json();
  if (!response.ok) {
    const error = z.object({ error: z.object({ message: z.string(), code: z.string().optional() }) }).safeParse(body);
    throw new SpanLessonRequestError(response.status, error.success ? error.data.error.code : undefined,
      error.success ? error.data.error.message : "学习进度暂未确认；原题和答案保留，请重新读取。");
  }
  return schema.parse(body);
}
