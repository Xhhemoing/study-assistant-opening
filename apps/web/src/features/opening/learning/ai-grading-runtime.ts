import "server-only";
import type { Sql } from "postgres";
import { createOpeningAiGradingRepository, createOpeningBudgetRepository } from "@aistudy/database";
import { loadOpeningModelCatalog } from "@aistudy/config";
import { createDbModelGateway, scopeBudget } from "../../../../../worker/src/runtime/model-gateway";
import { createSourcePageImages, openingPageStorage } from "../../../../../worker/src/runtime/source-page-images";
import { createOpeningAiGradingService } from "./ai-grading-service";

export function getAiGradingService(sql: Sql) {
  const budget = createOpeningBudgetRepository(sql, { envCapCents: loadOpeningModelCatalog().dailyCapCents });
  return createOpeningAiGradingService({ repository: createOpeningAiGradingRepository(sql),
    gateway: createDbModelGateway(sql), budget: scope => scopeBudget(budget, scope),
    images: createSourcePageImages(sql, openingPageStorage()),
  });
}
