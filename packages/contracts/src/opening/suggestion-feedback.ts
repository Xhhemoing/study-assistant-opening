import { z } from "zod";
import { uuidSchema } from "./foundation";
import { planDraftSchema } from "./planning";
import { taskFeedbackReasonSchema } from "./planning-tasks";

export const suggestionFeedbackInputSchema = z.object({
  draftId: uuidSchema,
  expectedDraftVersion: z.number().int().nonnegative(),
  suggestionKey: z.string().min(8).max(200),
  reason: taskFeedbackReasonSchema.optional(),
  clientKey: z.string().min(8).max(200),
}).strict();
export const suggestionFeedbackResultSchema = z.object({ feedbackId: uuidSchema, draft: planDraftSchema }).strict();
export type SuggestionFeedbackInput = z.infer<typeof suggestionFeedbackInputSchema>;
export type SuggestionFeedbackResult = z.infer<typeof suggestionFeedbackResultSchema>;
