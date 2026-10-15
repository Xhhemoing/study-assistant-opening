import { loadOpeningModelCatalog } from "@aistudy/config";
import { createOpeningBudgetRepository, createOpeningModelProvidersRepository } from "@aistudy/database";
import type { Scope } from "@aistudy/contracts";
import type { Sql } from "postgres";
import { probeDbModel, scopeBudget } from "../../../../worker/src/runtime/model-gateway";
import { ApiError } from "../auth/service";

function failureReason(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  switch (code) {
    case "BUDGET_EXCEEDED": return "每日预算不足。";
    case "REQUEST_CAP_EXCEEDED": return "已达到每日免费请求上限。";
    case "PROVIDER_AUTH": return "供应商未接受密钥，请检查配置。";
    case "PROVIDER_RATE_LIMIT": return "供应商当前限流，请稍后再主动测试。";
    case "AI_ROUTE_UNAVAILABLE": return "模型配置、定价或额度暂不可用。";
    case "PROVIDER_RESPONSE": return "供应商返回了无法识别的确认。";
    default: return "请检查模型配置、额度及服务器网络；结果未知时不会自动重发。";
  }
}

export async function probeModel(sql: Sql, scope: Scope, ids: { id: string; modelId: string }, clientKey: string) {
  // Verify ownership before the gateway, without constructing a provider here.
  const models = await createOpeningModelProvidersRepository(sql).listModels(scope);
  if (!models.some(model => model.id === ids.modelId && model.providerId === ids.id)) throw new ApiError("NOT_FOUND", "模型不存在。", 404);
  const budget = createOpeningBudgetRepository(sql, { envCapCents: loadOpeningModelCatalog().dailyCapCents });
  try {
    const output = await probeDbModel(sql, scope, ids.id, ids.modelId, {
      budget: scopeBudget(budget, scope), operationId: `probe:${clientKey}`, resultRef: "settings:probe",
      input: { instruction: 'Return exactly {"ok":true}.', text: "Connectivity test", mode: "listen", chunks: [], imageParts: [], mediaCapability: "text_only", outputFormat: "json", maxOutputTokens: 16 },
    });
    const parsed: unknown = JSON.parse(output.text);
    const ok = typeof parsed === "object" && parsed !== null && "ok" in parsed && parsed.ok === true;
    return { ok, message: ok ? "本次请求成功。" : "本次请求失败：模型未返回有效确认。" };
  } catch (error) {
    return { ok: false, message: `本次请求失败：${failureReason(error)}` };
  }
}
