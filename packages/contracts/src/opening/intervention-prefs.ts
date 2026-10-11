import { z } from "zod";
import { isoDateTimeSchema, uuidSchema } from "./foundation";

export const interventionProactivitySchema = z.enum([
  "off",
  "minimal",
  "balanced",
  "high",
]);
export type InterventionProactivity = z.infer<typeof interventionProactivitySchema>;

export const interventionDepthSchema = z.enum([
  "hint_only",
  "hint_then_offer",
  "full_ok_on_request",
]);
export type InterventionDepth = z.infer<typeof interventionDepthSchema>;

export const interventionNodesSchema = z
  .object({
    allowOnTeach: z.boolean(),
    allowOnPrompt: z.boolean(),
    // NO allowOnDwell — forbidden (dwell-time stuck signal)
    allowOnLowEvidence: z.boolean(),
  })
  .strict();
export type InterventionNodes = z.infer<typeof interventionNodesSchema>;

export const interventionPrefsSchema = z
  .object({
    proactivity: interventionProactivitySchema,
    nodes: interventionNodesSchema,
    depth: interventionDepthSchema,
    quietMode: z.boolean(),
  })
  .strict();
export type InterventionPrefs = z.infer<typeof interventionPrefsSchema>;

/** PM-locked defaults (Plan ACCEPT / §9). */
export const DEFAULT_OPENING_INTERVENTION_PREFS: InterventionPrefs = {
  proactivity: "balanced",
  nodes: {
    allowOnTeach: true,
    allowOnPrompt: true,
    allowOnLowEvidence: false,
  },
  depth: "hint_then_offer",
  quietMode: false,
};

/**
 * Deep-partial overlay for course + session (Zod 4 has no deepPartial).
 * Missing keys inherit from lower layers at resolve time.
 */
export const interventionPrefsPatchSchema = z
  .object({
    proactivity: interventionProactivitySchema.optional(),
    nodes: z
      .object({
        allowOnTeach: z.boolean().optional(),
        allowOnPrompt: z.boolean().optional(),
        allowOnLowEvidence: z.boolean().optional(),
      })
      .strict()
      .optional(),
    depth: interventionDepthSchema.optional(),
    quietMode: z.boolean().optional(),
  })
  .strict();
export type InterventionPrefsPatch = z.infer<typeof interventionPrefsPatchSchema>;

export const interventionDecisionKindSchema = z.enum([
  "none",
  "defer",
  "offer",
  "respond",
]);
export type InterventionDecisionKind = z.infer<typeof interventionDecisionKindSchema>;

export const interventionTriggerSchema = z.enum([
  "user_help_ask",
  "system_proactive",
  "tutor_recommend",
]);
export type InterventionTrigger = z.infer<typeof interventionTriggerSchema>;

export const interventionDecisionReasonSchema = z.string().min(1).max(500);
export type InterventionDecisionReason = z.infer<typeof interventionDecisionReasonSchema>;

export const interventionDecisionRecordSchema = z
  .object({
    id: uuidSchema,
    at: isoDateTimeSchema,
    activityId: uuidSchema,
    sessionId: uuidSchema.nullable().optional(),
    trigger: interventionTriggerSchema,
    decision: interventionDecisionKindSchema,
    reason: interventionDecisionReasonSchema,
    proposedKind: z.string().min(1).max(80).nullable().optional(),
    prefsSnapshot: z
      .object({
        proactivity: interventionProactivitySchema,
        quietMode: z.boolean(),
        depth: interventionDepthSchema,
      })
      .strict()
      .optional(),
  })
  .strict();
export type InterventionDecisionRecord = z.infer<typeof interventionDecisionRecordSchema>;

export const INTERVENTION_DECISION_RING_MAX = 20;
export const CONSECUTIVE_PROACTIVE_REJECT_LIMIT = 2;

export const interventionSettingsResponseSchema = z
  .object({
    settings: interventionPrefsSchema,
    courseOverride: interventionPrefsPatchSchema.nullable(),
    sessionOverride: interventionPrefsPatchSchema.nullable(),
    effective: interventionPrefsSchema,
    saved: z.boolean(),
    invalidStoredSettings: z.boolean(),
  })
  .strict();
export type InterventionSettingsResponse = z.infer<
  typeof interventionSettingsResponseSchema
>;
