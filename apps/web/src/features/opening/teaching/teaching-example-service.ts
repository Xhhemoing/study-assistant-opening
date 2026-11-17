import type { Sql } from "postgres";
import type { Scope, TeachingExampleTarget } from "@aistudy/contracts";
import { teachingExampleRequestSchema, teachingExampleTargetSchema, teachingExampleEstimateSchema, TEACHING_EXAMPLE_CONSENT_VERSION, TEACHING_EXAMPLE_CONSENT_TEXT } from "@aistudy/contracts";
import { buildWorkedExampleProviderInput, reservationTerms, isTeachingCompilerEnabled } from "@aistudy/ai";
import { loadOpeningModelCatalog } from "@aistudy/config";
import { createOpeningTeachingExamplesRepository, checkOpeningBudgetAvailable } from "@aistudy/database";
import { createDbModelGateway } from "../../../../../worker/src/runtime/model-gateway";
import { ApiError } from "../../auth/service";

export function createTeachingExampleService(sql: Sql) {
  const repository = createOpeningTeachingExamplesRepository(sql), gateway = createDbModelGateway(sql);
  async function estimate(scope: Scope, raw: unknown) {
    if (!isTeachingCompilerEnabled()) throw new ApiError("CONFIGURATION", "AI 例题生成当前已关闭，未创建请求。", 503);
    const target: TeachingExampleTarget = teachingExampleTargetSchema.parse(raw);
    const context = await repository.context(scope, target);
    const input = buildWorkedExampleProviderInput({ originalExample: context.originalExample });
    let cents: number;
    try {
      const models = [await gateway.resolve(scope, "practice.grade-text"), await gateway.resolveFallback(scope, "practice.grade-text")].filter(model => model !== null);
      const catalog = loadOpeningModelCatalog();
      const options = { envCapCents: catalog.dailyCapCents, dailyQuotaMode: catalog.dailyQuotaMode, parentCapCents: catalog.parentCapCents };
      const terms = models.map(model => ({ model, terms: reservationTerms(model, input) }));
      cents = Math.max(...terms.map(item => item.terms.reservedCents));
      for (const item of terms) {
        const available = await checkOpeningBudgetAvailable(sql, scope, { amountCents: item.terms.reservedCents,
          modelSnapshot: item.model.modelSnapshot, requestCapPerDay: item.terms.requestCapPerDay }, options);
        if (!available.allowed) throw new ApiError("CONFLICT", "当前模型预算或请求额度不足，未创建例题请求。", 409);
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError("CONFIGURATION", "例题费用暂不可预估，请先检查模型配置；未创建请求或发送模型。", 503);
    }
    return teachingExampleEstimateSchema.parse({ target, estimatedCents: cents, isCap: false,
      consentVersion: TEACHING_EXAMPLE_CONSENT_VERSION, consentText: TEACHING_EXAMPLE_CONSENT_TEXT });
  }
  return {
    estimate,
    read: repository.read,
    find: repository.find,
    findTarget: repository.findTarget,
    async request(scope: Scope, raw: unknown) {
      const request = teachingExampleRequestSchema.parse(raw);
      const existing = await repository.existing(scope, request); if (existing) return existing;
      const quoted = await estimate(scope, request.target);
      return repository.request(scope, request, quoted.estimatedCents);
    },
  };
}
