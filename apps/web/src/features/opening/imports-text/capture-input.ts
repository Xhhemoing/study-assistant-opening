import { z } from "zod";
import { resolveWorkspaceTimeZone } from "@aistudy/domain";

export const captureInputSchema = z.object({
  title: z.string().trim().max(180).optional(),
  providerHint: z.enum(["doubao", "chatgpt", "claude", "kimi", "deepseek", "other"]).optional(),
  content: z.string().min(1),
  keyStepSummary: z.string().max(8000).optional(),
  courseId: z.string().uuid().transform(id => id.toLowerCase()).nullish(),
  timeZone: z.string().trim().min(1).max(100).refine(zone => {
    try { resolveWorkspaceTimeZone(zone); return true; } catch { return false; }
  }).optional(),
  scheduleNextDayRetell: z.boolean().default(true),
  clientKey: z.string().trim().min(1).max(200).optional(),
}).strict();
