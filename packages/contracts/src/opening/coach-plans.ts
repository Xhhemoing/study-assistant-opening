import { z } from "zod";
import { calendarDateSchema, uuidSchema } from "./foundation";
import { planDraftSchema, plannedBlockSchema } from "./planning";

const date = calendarDateSchema;
const key = z.string().min(8).max(200);
export const coachPlanAcceptInputSchema = z.object({ draftId: uuidSchema, expectedDraftVersion: z.number().int().nonnegative(), clientKey: key }).strict();
export const coachPlanUndoInputSchema = z.object({ date, acceptanceClientKey: key, expectedAcceptedVersion: z.number().int().positive(), clientKey: key }).strict();
export const coachPlanAcceptanceSchema = z.object({ clientKey: key, date, acceptedVersion: z.number().int().positive(),
  createdTaskIds: z.array(uuidSchema).max(10), scheduledMinutes: z.number().nonnegative(), undoAvailable: z.boolean(), undone: z.boolean() }).strict();
export const coachPlanAcceptResultSchema = z.object({ draft: planDraftSchema, acceptance: coachPlanAcceptanceSchema }).strict();
export const coachPlanUndoResultSchema = z.object({ acceptedVersion: z.number().int().positive(), blocks: z.array(plannedBlockSchema).max(200),
  closedTaskIds: z.array(uuidSchema).max(10), replayed: z.boolean() }).strict();
export type CoachPlanAcceptInput = z.infer<typeof coachPlanAcceptInputSchema>;
export type CoachPlanUndoInput = z.infer<typeof coachPlanUndoInputSchema>;
export type CoachPlanAcceptance = z.infer<typeof coachPlanAcceptanceSchema>;
export type CoachPlanUndoResult = z.infer<typeof coachPlanUndoResultSchema>;
