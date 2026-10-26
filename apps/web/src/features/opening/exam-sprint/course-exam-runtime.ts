import "server-only";
import type { Sql } from "postgres";
import { loadOpeningModelCatalog } from "@aistudy/config";
import { createOpeningBudgetRepository, createOpeningCourseExamRepository } from "@aistudy/database";
import { createDbModelGateway, scopeBudget } from "../../../../../worker/src/runtime/model-gateway";
import { createCourseExamService } from "./course-exam-service";

export function getCourseExamService(sql: Sql) {
  const catalog = loadOpeningModelCatalog();
  const budget = createOpeningBudgetRepository(sql, { envCapCents: catalog.dailyCapCents, dailyQuotaMode: catalog.dailyQuotaMode, parentCapCents: catalog.parentCapCents,
    pricingConfigured: catalog.models.some(model => model.inputCentsPerMillion > 0 && model.outputCentsPerMillion > 0) });
  return createCourseExamService({ repository: createOpeningCourseExamRepository(sql), gateway: createDbModelGateway(sql),
    budget: scope => scopeBudget(budget, scope) });
}
