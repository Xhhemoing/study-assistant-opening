import "server-only";
import type { Sql } from "postgres";
import { loadFeatureSwitches } from "@aistudy/config";
import { loopMetricsQuerySchema, type Scope } from "@aistudy/contracts";
import { readOpeningLoopMetrics } from "@aistudy/database";
import { ApiError } from "../../auth/service";

/** Read-only application boundary; route authentication supplies the workspace scope. */
export async function getOpeningLoopMetrics(sql: Sql, scope: Scope, days: unknown) {
  if (!loadFeatureSwitches().adaptivePlanning) throw new ApiError("NOT_FOUND", "学习闭环诊断尚未启用。", 404);
  const parsed = loopMetricsQuerySchema.parse({ days });
  return readOpeningLoopMetrics(sql, scope, parsed);
}
