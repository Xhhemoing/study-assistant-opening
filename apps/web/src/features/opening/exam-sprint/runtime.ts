import "server-only";
import { createOpeningBudgetRepository, createOpeningExamSprintRepository, createOpeningExamIntegrationRepository,
  createOpeningExamForecastRepository, createOpeningExamReviewsRepository } from "@aistudy/database";
import { loadOpeningModelCatalog, loadOpeningUploadQuota } from "@aistudy/config";
import { EXAM_SPRINT_PACK } from "@aistudy/domain/exam-sprint-catalog";
import type { Sql } from "postgres";
import { createDbModelGateway, scopeBudget } from "../../../../../worker/src/runtime/model-gateway";
import { createSourcePageImages, openingPageStorage } from "../../../../../worker/src/runtime/source-page-images";
import { createExamPhotoReviewService } from "./review-service";

// The complete answer bank is reachable only through this server adapter.
export const getExamSprintService = (sql: Sql) => createOpeningExamSprintRepository(sql, EXAM_SPRINT_PACK);
export const getExamIntegrationService = (sql: Sql) => {
  const storage = openingPageStorage();
  return createOpeningExamIntegrationRepository(sql, EXAM_SPRINT_PACK, {
    quota: loadOpeningUploadQuota(),
    writePublicSource: source => storage.putObject(storage.finalKey(source.sourceId, source.version), source.body, { mime: source.mime }),
  });
};
export const getExamForecastService = (sql: Sql) => createOpeningExamForecastRepository(sql, EXAM_SPRINT_PACK);
export const getExamReviewService = (sql: Sql) => {
  const budget = createOpeningBudgetRepository(sql, { envCapCents: loadOpeningModelCatalog().dailyCapCents });
  return createExamPhotoReviewService({ repository: createOpeningExamReviewsRepository(sql), gateway: createDbModelGateway(sql),
    budget: scope => scopeBudget(budget, scope), images: createSourcePageImages(sql, openingPageStorage()) });
};
