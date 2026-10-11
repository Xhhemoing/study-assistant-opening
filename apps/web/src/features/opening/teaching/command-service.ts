import {
  teachingCommandRequestSchema,
  teachingCommandResponseSchema,
  uuidSchema,
  type Scope,
  type TeachingCommandResponse,
} from "@aistudy/contracts";
import { createOpeningTeachingCommandsRepository } from "@aistudy/database";
import type { Sql } from "postgres";
import { ApiError } from "../../auth/service";

function mapError(error: unknown): never {
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code: string }).code);
    const message = error instanceof Error ? error.message : "teaching command error";
    if (code === "NOT_FOUND") throw new ApiError("NOT_FOUND", message, 404);
    if (code === "VALIDATION") throw new ApiError("VALIDATION", message, 400);
    if (code === "CONFLICT") throw new ApiError("CONFLICT", message, 409);
  }
  throw error;
}

/** Data-owned teaching commands (why/rephrase/expand/example/skip/branch/return). */
export function createOpeningTeachingCommandService(sql: Sql) {
  const repo = createOpeningTeachingCommandsRepository(sql);
  return {
    async execute(scope: Scope, activityIdRaw: string, raw: unknown): Promise<TeachingCommandResponse> {
      const activityId = uuidSchema.parse(activityIdRaw);
      const request = teachingCommandRequestSchema.parse(raw);
      try {
        // Ownership: other owner → NOT_FOUND (no cross-workspace leak).
        await repo.assertOwned(scope, activityId);
        const result = await repo.executeCommand(scope, activityId, request);
        return teachingCommandResponseSchema.parse(result);
      } catch (error) {
        mapError(error);
      }
    },
  };
}

export type OpeningTeachingCommandService = ReturnType<
  typeof createOpeningTeachingCommandService
>;
