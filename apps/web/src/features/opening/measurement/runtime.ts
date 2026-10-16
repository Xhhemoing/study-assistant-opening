import "server-only";
import { createOpeningMeasurementRepository } from "@aistudy/database";
import type { Sql } from "postgres";

/** The measurement plugin keeps its facts separate from production learning decisions. */
export const getMeasurementService = (sql: Sql) => createOpeningMeasurementRepository(sql);
