import "server-only";
import {
  OpeningWritingError,
  createOpeningWritingWorkspaceRepository,
  type OpeningWritingErrorCode,
  type OpeningWritingWorkspaceRepository,
  type WritingCommandResult,
} from "@aistudy/database";
import type { Sql } from "postgres";

export { OpeningWritingError, type OpeningWritingErrorCode, type WritingCommandResult };

/**
 * Type guard for writing workspace repository errors so route handlers can map
 * them to HTTP responses without importing @aistudy/database directly (plan §7.4).
 */
export function isOpeningWritingError(error: unknown): error is OpeningWritingError {
  return error instanceof OpeningWritingError;
}

/** Opening server adapter wrapping the writing workspace repository. */
export function createWritingWorkspaceService(
  sql: Sql,
): OpeningWritingWorkspaceRepository {
  return createOpeningWritingWorkspaceRepository(sql);
}

export function mapOpeningWritingErrorToResponse(
  error: OpeningWritingError,
): Response {
  const status = error.code === "NOT_FOUND"
    ? 404
    : error.code === "VALIDATION"
      ? 400
      : error.code === "WORKSPACE_MISMATCH"
        ? 403
        : 409;
  const code = error.code === "WORKSPACE_MISMATCH" ? "WORKSPACE_FORBIDDEN" : error.code;
  const response = Response.json({ error: { code, message: error.message } }, { status });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
