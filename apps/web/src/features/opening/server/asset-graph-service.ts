import "server-only";
import {
  OpeningAssetGraphError,
  createOpeningAssetGraphRepository,
  type OpeningAssetGraphOptions,
  type OpeningAssetGraphRepository,
} from "@aistudy/database";
import type { Sql } from "postgres";

export { OpeningAssetGraphError };

/**
 * Type guard for asset-graph repository errors so route handlers can map them
 * to HTTP responses without importing @aistudy/database directly (plan §7.4).
 */
export function isOpeningAssetGraphError(error: unknown): error is OpeningAssetGraphError {
  return error instanceof OpeningAssetGraphError;
}

/** Opening server adapter wrapping the read-only learning asset graph repository. */
export function createAssetGraphService(
  sql: Sql,
  options?: OpeningAssetGraphOptions,
): OpeningAssetGraphRepository {
  return createOpeningAssetGraphRepository(sql, options);
}
