import { z } from "zod";

export const workspaceDefaultEntrySchema = z.enum(["learn", "explore", "library"]);

export const workspacePreferenceUpdateSchema = z.object({
  defaultEntry: workspaceDefaultEntrySchema,
});

export const learningPreferencesSchema = z.object({
  assessmentEnabled: z.boolean(),
  retestSuggestionsEnabled: z.boolean(),
  automaticRemindersEnabled: z.boolean(),
});

export const courseLearningPreferencesUpdateSchema = learningPreferencesSchema.partial();

export const workspacePreferenceResponseSchema = z.object({
  defaultEntry: workspaceDefaultEntrySchema.nullable(),
});

export type WorkspaceDefaultEntry = z.infer<typeof workspaceDefaultEntrySchema>;
export type WorkspacePreferenceUpdate = z.infer<typeof workspacePreferenceUpdateSchema>;
export type WorkspacePreferenceResponse = z.infer<typeof workspacePreferenceResponseSchema>;
export type LearningPreferences = z.infer<typeof learningPreferencesSchema>;
export type CourseLearningPreferencesUpdate = z.infer<typeof courseLearningPreferencesUpdateSchema>;
