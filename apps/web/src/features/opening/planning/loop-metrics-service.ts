import "server-only";
import type { Sql } from "postgres";
import { loopMetricsQuerySchema, type Scope } from "@aistudy/contracts";
import { readOpeningLoopMetrics } from "@aistudy/database";

/** Read-only application boundary; route authentication supplies the workspace scope. */
export async function getOpeningLoopMetrics(sql: Sql, scope: Scope, days: unknown) {
  const parsed = loopMetricsQuerySchema.parse({ days });
  return readOpeningLoopMetrics(sql, scope, parsed);
}
