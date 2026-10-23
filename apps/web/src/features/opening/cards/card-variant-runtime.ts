import "server-only";
import type { Scope } from "@aistudy/contracts";
import type { Sql } from "postgres";
import { loadOpeningModelCatalog } from "@aistudy/config";
import { createOpeningBudgetRepository, createOpeningCardVariantRepository, gradeCardVariant } from "@aistudy/database";
import { createDbModelGateway, scopeBudget } from "../../../../../worker/src/runtime/model-gateway";
import { createCardVariantService } from "./card-variant-service";

export function getCardVariantService(sql: Sql) {
  const catalog = loadOpeningModelCatalog();
  const budget = createOpeningBudgetRepository(sql, { envCapCents: catalog.dailyCapCents,
    pricingConfigured: catalog.models.some(model => model.inputCentsPerMillion > 0 && model.outputCentsPerMillion > 0) });
  return createCardVariantService({ repository: createOpeningCardVariantRepository(sql), gateway: createDbModelGateway(sql),
    budget: scope => scopeBudget(budget, scope) });
}

export const classifyCardVariant = (sql: Sql, scope: Scope, cardId: string, kind: "question" | "concept") =>
  createOpeningCardVariantRepository(sql).classify(scope, cardId, kind);
export const completeCardVariant = (sql: Sql, scope: Scope, cardId: string, observationId: string) =>
  gradeCardVariant(sql, scope, cardId, observationId);
