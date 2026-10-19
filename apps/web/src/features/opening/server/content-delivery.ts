import { createOpeningContentDeliveryRepository } from "@aistudy/database";
import type { Sql } from "postgres";

/** Application delivery boundary, distinct from read-only openingQueries. */
export function openingContentDelivery(sql: Sql) {
  return createOpeningContentDeliveryRepository(sql);
}
