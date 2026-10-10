import { z } from "zod";

const modelId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
/**
 * Schema upper bound for stored workspace dailyCapCents.
 * Matches OPENING_MODEL_DAILY_CAP_CENTS env max so a large ops env cap (e.g. 1_000_000)
 * can be mirrored in ai_settings without Zod wiping the whole preference blob.
 * Write-time ceilings stay in validateBudgetFields: <= env cap when env > 0,
 * else <= OPENING_PERSONAL_DAILY_CAP_CEILING_CENTS (2000).
 */
export const OPENING_AI_SETTINGS_DAILY_CAP_SCHEMA_MAX_CENTS = 2_147_483_647;
export const openingAiSettingsSchema = z.object({
  mode: z.enum(["manual", "automatic"]),
  defaultModelId: modelId.nullable(),
  manualModelId: modelId.nullable().optional(),
  routes: z.object({
    listen: modelId.nullable(), hint: modelId.nullable(),
    explain: modelId.nullable(), think_together: modelId.nullable(),
  }).strict(),
  /** Optional per-workspace daily budget in cents; absent/null means unset. */
  dailyCapCents: z.number().int().nonnegative().max(OPENING_AI_SETTINGS_DAILY_CAP_SCHEMA_MAX_CENTS).nullable().optional(),
  /** ISO timestamp when the owner confirmed enabling a personal daily cap. */
  budgetConfirmedAt: z.string().datetime({ offset: true }).nullable().optional(),
}).strict().transform(settings => ({
  ...settings,
  // Compatibility with this feature's earlier saved shape, not a runtime fallback.
  manualModelId: !("manualModelId" in settings) && settings.mode === "manual"
    ? settings.defaultModelId : settings.manualModelId ?? null,
})).superRefine((settings, ctx) => {
  if (settings.mode === "manual" && settings.manualModelId === null) ctx.addIssue({ code: "custom", path: ["manualModelId"], message: "manual routing requires an explicit model" });
});
export type OpeningAiSettings = z.infer<typeof openingAiSettingsSchema>;
export const DEFAULT_OPENING_AI_SETTINGS: OpeningAiSettings = {
  mode: "automatic", defaultModelId: null, manualModelId: null,
  routes: { listen: null, hint: null, explain: null, think_together: null },
};

export const openingModelSnapshotSchema = z.object({
  id: modelId,
  providerId: modelId,
  modelName: z.string().min(1).max(200),
  inputCentsPerMillion: z.number().finite().nonnegative(),
  outputCentsPerMillion: z.number().finite().nonnegative(),
}).strict();
export type OpeningModelSnapshot = z.infer<typeof openingModelSnapshotSchema>;

export const openingModelSummarySchema = openingModelSnapshotSchema.extend({
  label: z.string().min(1).max(120),
  providerLabel: z.string().min(1).max(120),
  availability: z.enum(["available", "missing_key", "budget_disabled", "pricing_missing", "vault_disabled"]),
  supportsVision: z.boolean().optional(),
  /** Absent for the server env catalog; "workspace" marks a web-managed custom model. */
  source: z.enum(["server", "workspace"]).optional(),
});
export type OpeningModelSummary = z.infer<typeof openingModelSummarySchema>;
export const openingAiSettingsResponseSchema = z.object({
  models: z.array(openingModelSummarySchema).max(32),
  defaultModelId: modelId.nullable(),
  /** Effective daily cap after resolveEffectiveDailyCap. */
  dailyCapCents: z.number().int().nonnegative(),
  /** Env/ops ceiling the UI may not exceed when env cap > 0; otherwise personal ceiling. */
  envCapCents: z.number().int().nonnegative(),
  personalCeilingCents: z.number().int().nonnegative(),
  settings: openingAiSettingsSchema,
  saved: z.boolean(),
  invalidStoredSettings: z.boolean(),
});
export type OpeningAiSettingsResponse = z.infer<typeof openingAiSettingsResponseSchema>;
