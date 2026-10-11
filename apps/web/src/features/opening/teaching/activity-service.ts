import {
  teachingActivityAssociateCourseInputSchema,
  teachingActivityCreateInputSchema,
  uuidSchema,
  type Scope,
} from "@aistudy/contracts";
import { createOpeningTeachingActivitiesRepository } from "@aistudy/database";
import type { Sql } from "postgres";
import { ApiError } from "../../auth/service";

function mapError(error: unknown): never {
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code: string }).code);
    const message = error instanceof Error ? error.message : "teaching activity error";
    if (code === "NOT_FOUND") throw new ApiError("NOT_FOUND", message, 404);
    if (code === "VALIDATION") throw new ApiError("VALIDATION", message, 400);
    if (code === "CONFLICT") throw new ApiError("CONFLICT", message, 409);
  }
  throw error;
}

/** Minimal Data-owned teaching activity service (create/get/associate). Experience owns Today UI later. */
export function createOpeningTeachingActivityService(sql: Sql) {
  const repo = createOpeningTeachingActivitiesRepository(sql);
  return {
    async create(scope: Scope, raw: unknown) {
      const input = teachingActivityCreateInputSchema.parse(raw);
      try {
        return await repo.create(scope, input);
      } catch (error) {
        mapError(error);
      }
    },
    async get(scope: Scope, activityIdRaw: string) {
      const activityId = uuidSchema.parse(activityIdRaw);
      try {
        const activity = await repo.get(scope, activityId);
        if (!activity) throw new ApiError("NOT_FOUND", "teaching activity not found", 404);
        return activity;
      } catch (error) {
        mapError(error);
      }
    },
    async list(scope: Scope) {
      try {
        return await repo.listByOwner(scope);
      } catch (error) {
        mapError(error);
      }
    },
    async associateCourse(scope: Scope, activityIdRaw: string, raw: unknown) {
      const activityId = uuidSchema.parse(activityIdRaw);
      const input = teachingActivityAssociateCourseInputSchema.parse(raw);
      try {
        return await repo.associateCourse(scope, activityId, input);
      } catch (error) {
        mapError(error);
      }
    },
  };
}

export type OpeningTeachingActivityService = ReturnType<
  typeof createOpeningTeachingActivityService
>;
