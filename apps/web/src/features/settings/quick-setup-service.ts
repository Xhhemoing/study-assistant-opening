import { DEFAULT_OPENING_AI_SETTINGS, openingAiSettingsSchema, openingModelQuickSetupInputSchema, type OpeningAiSettings, type Scope } from "@aistudy/contracts";
import { loadOpeningModelCatalog } from "@aistudy/config";
import { CredentialVaultError, insertModel, insertProvider, lockModelProviderOwner, OpeningModelProviderError, setOpeningAiSettingsInTx } from "@aistudy/database";
import type { Sql } from "postgres";
import { ApiError } from "../auth/service";
import { readAiSettings, validateBudgetFields } from "./ai-settings-service";

/** All writes share the owner lock and one transaction; retries never create another provider. */
export async function quickSetupModel(sql: Sql, scope: Scope, raw: unknown) {
  const parsed = openingModelQuickSetupInputSchema.safeParse(raw);
  if (!parsed.success) throw new ApiError("VALIDATION", "请填写有效的模型信息，并确认预算或每日免费请求上限。", 422);
  const input = parsed.data;
  try {
    await sql.begin(async tx => {
      await lockModelProviderOwner(tx, scope);
      const [existing] = await tx`SELECT id FROM opening_model_providers
        WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND quick_setup_key=${input.clientKey}`;
      if (existing) return;
      const billing = input.billing ?? "metered";
      const [stored] = await tx`SELECT ai_settings FROM workspace_preferences WHERE workspace_id=${scope.workspaceId}`;
      const parsedCurrent = openingAiSettingsSchema.safeParse(stored?.ai_settings ?? null);
      const current = parsedCurrent.success ? parsedCurrent.data : DEFAULT_OPENING_AI_SETTINGS;
      // The new model becomes the primary everywhere. Explicit fallbacks and the
      // transcription engine survive, and a free model never clears the cents cap that
      // the workspace's paid models depend on.
      const fallbacks = Object.fromEntries(Object.entries(current.taskRoutes ?? {})
        .flatMap(([task, route]) => route.fallback ? [[task, { primary: null, fallback: route.fallback }]] : []));
      const settings: OpeningAiSettings = {
        ...DEFAULT_OPENING_AI_SETTINGS,
        ...(Object.keys(fallbacks).length ? { taskRoutes: fallbacks } : {}),
        ...(current.transcription ? { transcription: current.transcription } : {}),
        dailyCapCents: billing === "free_tier" ? current.dailyCapCents ?? 0 : input.dailyCapCents!,
        budgetConfirmedAt: billing === "free_tier" ? current.budgetConfirmedAt ?? null : new Date().toISOString(),
      };
      // A preserved cap was validated when it was saved; only a new paid cap is checked here.
      if (billing === "metered") validateBudgetFields(settings, loadOpeningModelCatalog().dailyCapCents, true);
      const provider = await insertProvider(tx, scope, input);
      const model = await insertModel(tx, scope, provider.id, input);
      await tx`UPDATE opening_model_providers SET quick_setup_key=${input.clientKey} WHERE id=${provider.id}`;
      await setOpeningAiSettingsInTx(tx, scope, { ...settings, defaultModelId: model.id });
    });
  } catch (error) {
    if (error instanceof CredentialVaultError) throw new ApiError("CONFIGURATION", "模型密钥加密未配置或暂不可用。", 503);
    if (error instanceof OpeningModelProviderError) throw new ApiError(error.code === "NOT_FOUND" ? "NOT_FOUND" : "CONFLICT", error.code === "NOT_FOUND" ? "工作区不存在。" : "服务商名称已存在或已达到模型数量上限。", error.code === "NOT_FOUND" ? 404 : 409);
    throw error;
  }
  return readAiSettings(sql, scope);
}
