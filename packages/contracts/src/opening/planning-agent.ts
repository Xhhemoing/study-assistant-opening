import { z } from "zod";
import { uuidSchema } from "./foundation";
import { planDraftSchema } from "./planning";
import { taskItemSchema } from "./planning-tasks";

export const planningAgentInputSchema = z.object({
  clientKey: z.string().min(8).max(160),
  text: z.string().trim().min(1).max(2000),
  courseId: uuidSchema.nullable().default(null),
}).strict();

// Same actions for native-tool and JSON transports. Never accept a model's scope,
// SQL, timestamps, write approval, user identity, or arbitrary tool names.
export const planningAgentActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("read"), tool: z.enum(["schedule", "learning", "memory"]) }).strict(),
  z.object({ kind: z.literal("propose"), taskIds: z.array(uuidSchema).min(1).max(50)
    .refine(ids => new Set(ids).size === ids.length, "duplicate task IDs"),
    explanation: z.string().trim().min(1).max(1200) }).strict(),
  z.object({ kind: z.literal("finish"), message: z.string().trim().min(1).max(1200) }).strict(),
]);
export const planningAgentResultSchema = z.object({
  runId: uuidSchema,
  message: z.string().max(1600),
  draft: planDraftSchema.nullable(),
  tasks: z.array(taskItemSchema).max(200),
  timeZone: z.string().min(1).max(100),
  modelCalls: z.number().int().min(0).max(4),
}).strict();
export type PlanningAgentInput = z.infer<typeof planningAgentInputSchema>;
export type PlanningAgentAction = z.infer<typeof planningAgentActionSchema>;
export type PlanningAgentResult = z.infer<typeof planningAgentResultSchema>;
