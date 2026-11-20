import "server-only";
import type { Sql } from "postgres";
import {
  createOpeningDayAdjustmentRepository,
  type OpeningDayAdjustmentOptions,
} from "@aistudy/database";

export function createOpeningDayAdjustmentService(
  sql: Sql,
  options?: OpeningDayAdjustmentOptions,
) {
  return createOpeningDayAdjustmentRepository(sql, options);
}
