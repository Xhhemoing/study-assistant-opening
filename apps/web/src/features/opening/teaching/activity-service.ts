import {
  teachingActivityAssociateCourseInputSchema,
  teachingActivityCreateInputSchema,
  uuidSchema,
  type Scope,
  type TeachingActivity,
} from "@aistudy/contracts";
import { isTeachingCompilerEnabled } from "@aistudy/ai";
import { createOpeningTeachingActivitiesRepository } from "@aistudy/database";
import type { Sql } from "postgres";
import { z } from "zod";
import { ApiError } from "../../auth/service";
import { teachingActivityGenerateStatusLabel } from "./today-activity";

/** UI label for a freshly created activity — never claims 已就绪 when cv is 0. */
export function teachingCreateGenerateStatusLabel(
  activity: Pick<TeachingActivity, "generateStatus" | "contentVersion">,
): string {
  return teachingActivityGenerateStatusLabel(activity.generateStatus, {
    contentVersion: activity.contentVersion,
  });
}

const compileRequestSchema = z.object({ clientKey: z.string().min(8).max(160) }).strict();

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

/**
 * Minimal Data-owned teaching activity service (create/get/associate/compile).
 * When the teaching compiler is on, a new activity is created `queued` with its
 * first compile job, so it is never `ready` without published content.
 */
export function createOpeningTeachingActivityService(
  sql: Sql,
  env: Record<string, string | undefined> = process.env,
) {
  const repo = createOpeningTeachingActivitiesRepository(sql);
  return {
    async create(scope: Scope, raw: unknown) {
      const input = teachingActivityCreateInputSchema.parse(raw);
      try {
        return await repo.create(scope, input, { enqueueCompile: isTeachingCompilerEnabled(env) });
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
    /** Queue generation for an activity without usable content (never compiled, failed, stale). */
    async requestCompile(scope: Scope, activityIdRaw: string, raw: unknown) {
      const activityId = uuidSchema.parse(activityIdRaw);
      const input = compileRequestSchema.parse(raw);
      if (!isTeachingCompilerEnabled(env)) {
        throw new ApiError("CONFIGURATION", "主讲内容生成未开启", 503);
      }
      try {
        return await repo.requestCompile(scope, activityId, input.clientKey);
      } catch (error) {
        mapError(error);
      }
    },
  };
}

export type OpeningTeachingActivityService = ReturnType<
  typeof createOpeningTeachingActivityService
>;
