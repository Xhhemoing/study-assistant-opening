import { uuidSchema, type Scope } from "@aistudy/contracts";
import { createOpeningStudyExposureRepository } from "@aistudy/database";
import type { Sql } from "postgres";

export function createOpeningStudyExposureService(sql: Sql) {
  const exposures = createOpeningStudyExposureRepository(sql);
  return { acknowledge: (scope: Scope, receiptId: unknown) => exposures.acknowledge(scope, uuidSchema.parse(receiptId)) };
}
