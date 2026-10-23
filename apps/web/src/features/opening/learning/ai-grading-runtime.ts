import "server-only";
import type { Sql } from "postgres";
import { createOpeningAiGradingJobRepository } from "@aistudy/database";

/** HTTP can only enqueue/read. Paid execution is never tied to request lifetime. */
export function getAiGradingService(sql: Sql) {
  return createOpeningAiGradingJobRepository(sql);
}
