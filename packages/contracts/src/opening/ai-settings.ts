import { z } from "zod";

const modelId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);

/** Optional workspace budget fields stored inside ai_settings JSON (no migration). */
const workspaceBudgetFields = {
  dailyCapCents: z.number().int().nonnegative().max(2_147_483_647).nullable().optional(),
  budgetConfirmedAt: z.string().datetime().nullable().optional(),
};

export const openingAiSettingsSchema = z.object({
  mode: z.enum(["manual", "automatic"]),
  defaultModelId: modelId.nullable(),
  manualModelId: modelId.nullable().optional(),
  routes: z.object({
    listen: modelId.nullable(), hint: modelId.nullable(),
    explain: modelId.nullable(), think_together: modelId.nullable(),
  }).strict(),
  ...workspaceBudgetFields,
}).strict().transform(settings => ({
  ...settings,
  // Compatibility with this feature's earlier saved shape, not a runtime fallback.
  manualModelId: !("manualModelId" in settings) && settings.mode === "manual"
    ? settings.defaultModelId : settings.manualModelId ?? null,
  dailyCapCents: settings.dailyCapCents ?? null,
  budgetConfirmedAt: settings.budgetConfirmedAt ?? null,
})).superRefine((settings, ctx) => {
  if (settings.mode === "manual" && settings.manualModelId === null) ctx.addIssue({ code: "custom", path: ["manualModelId"], message: "manual routing requires an explicit model" });
});
export type OpeningAiSettings = z.infer<typeof openingAiSettingsSchema>;
export const DEFAULT_OPENING_AI_SETTINGS: OpeningAiSettings = {
  mode: "automatic", defaultModelId: null, manualModelId: null,
  routes: { listen: null, hint: null, explain: null, think_together: null },
  dailyCapCents: null, budgetConfirmedAt: null,
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

export const openingEffectiveCapSourceSchema = z.enum(["env", "workspace", "min", "disabled"]);

export const openingAiSettingsResponseSchema = z.object({
  models: z.array(openingModelSummarySchema).max(32),
  defaultModelId: modelId.nullable(),
  /** Effective daily cap used by catalog availability and budget reserve. */
  dailyCapCents: z.number().int().nonnegative(),
  envDailyCapCents: z.number().int().nonnegative(),
  workspaceDailyCapCents: z.number().int().nonnegative().nullable(),
  budgetConfirmedAt: z.string().datetime().nullable(),
  effectiveCapSource: openingEffectiveCapSourceSchema,
  settings: openingAiSettingsSchema,
  saved: z.boolean(),
  invalidStoredSettings: z.boolean(),
});
export type OpeningAiSettingsResponse = z.infer<typeof openingAiSettingsResponseSchema>;

export const openingAiReadinessItemSchema = z.object({
  key: z.string().min(1).max(64),
  ok: z.boolean(),
  detail: z.string().max(500),
});
export const openingAiReadinessResponseSchema = z.object({
  items: z.array(openingAiReadinessItemSchema).max(32),
});
export type OpeningAiReadinessResponse = z.infer<typeof openingAiReadinessResponseSchema>;
