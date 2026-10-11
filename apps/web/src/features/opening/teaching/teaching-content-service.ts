import {
  activitySpecPublishInputSchema,
  teachingDraftAnchorsSaveInputSchema,
  teachingUnitCreateInputSchema,
  uuidSchema,
  type Scope,
} from "@aistudy/contracts";
import { createOpeningTeachingContentRepository } from "@aistudy/database";
import type { Sql } from "postgres";
import { ApiError } from "../../auth/service";

function mapError(error: unknown): never {
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code: string }).code);
    const message = error instanceof Error ? error.message : "teaching content error";
    if (code === "NOT_FOUND") throw new ApiError("NOT_FOUND", message, 404);
    if (code === "VALIDATION") throw new ApiError("VALIDATION", message, 400);
    if (code === "CONFLICT") throw new ApiError("CONFLICT", message, 409);
  }
  throw error;
}

/** Thin Data-owned teaching content service. Experience render stays separate. */
export function createOpeningTeachingContentService(sql: Sql) {
  const repo = createOpeningTeachingContentRepository(sql);
  return {
    async createUnit(scope: Scope, raw: unknown) {
      const input = teachingUnitCreateInputSchema.parse(raw);
      try {
        return await repo.createUnit(scope, input);
      } catch (error) {
        mapError(error);
      }
    },
    async getUnit(scope: Scope, unitIdRaw: string) {
      const unitId = uuidSchema.parse(unitIdRaw);
      try {
        const unit = await repo.getUnit(scope, unitId);
        if (!unit) throw new ApiError("NOT_FOUND", "teaching unit not found", 404);
        return unit;
      } catch (error) {
        mapError(error);
      }
    },
    async listUnits(scope: Scope) {
      try {
        return await repo.listUnits(scope);
      } catch (error) {
        mapError(error);
      }
    },
    async publishActivitySpec(scope: Scope, raw: unknown) {
      const input = activitySpecPublishInputSchema.parse(raw);
      try {
        return await repo.publishActivitySpec(scope, input);
      } catch (error) {
        mapError(error);
      }
    },
    async getActivitySpec(scope: Scope, activityIdRaw: string) {
      const activityId = uuidSchema.parse(activityIdRaw);
      try {
        const spec = await repo.getActivitySpec(scope, activityId);
        if (!spec) throw new ApiError("NOT_FOUND", "activity spec not found", 404);
        return spec;
      } catch (error) {
        mapError(error);
      }
    },
    /**
     * M1: only current ActivitySpec row; mismatch → 404.
     * Past body via readRevision / library revision_number.
     */
    async getActivitySpecAtVersion(scope: Scope, activityIdRaw: string, versionRaw: number) {
      const activityId = uuidSchema.parse(activityIdRaw);
      if (!Number.isInteger(versionRaw) || versionRaw < 0) {
        throw new ApiError("VALIDATION", "version must be a non-negative integer", 400);
      }
      try {
        const spec = await repo.getActivitySpecAtVersion(scope, activityId, versionRaw);
        if (!spec) {
          throw new ApiError(
            "NOT_FOUND",
            "activity spec version not available (M1 retains current row only; use library revision for past body)",
            404,
          );
        }
        return spec;
      } catch (error) {
        mapError(error);
      }
    },
    async getClientInit(scope: Scope, activityIdRaw: string) {
      const activityId = uuidSchema.parse(activityIdRaw);
      try {
        const init = await repo.getClientInit(scope, activityId);
        if (!init) throw new ApiError("NOT_FOUND", "activity spec not found", 404);
        return init;
      } catch (error) {
        mapError(error);
      }
    },
    async saveDraftAnchors(scope: Scope, activityIdRaw: string, raw: unknown) {
      const activityId = uuidSchema.parse(activityIdRaw);
      const input = teachingDraftAnchorsSaveInputSchema.parse(raw);
      try {
        return await repo.saveDraftAnchors(scope, activityId, input);
      } catch (error) {
        mapError(error);
      }
    },
    async readRevision(scope: Scope, documentIdRaw: string, revisionNumber: number) {
      const documentId = uuidSchema.parse(documentIdRaw);
      try {
        return await repo.readRevision(scope, documentId, revisionNumber);
      } catch (error) {
        mapError(error);
      }
    },
  };
}

export type OpeningTeachingContentService = ReturnType<
  typeof createOpeningTeachingContentService
>;
