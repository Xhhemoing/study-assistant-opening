import {
  knowledgeSnapshotSchema,
  sourceVersionsSchema,
  uuidSchema,
  type KnowledgeSnapshot,
  type Scope,
} from "@aistudy/contracts";
import {
  createOpeningKnowledgeRepository,
  OpeningKnowledgeError,
  type OpeningKnowledgeRecord,
} from "@aistudy/database";
import type { Sql } from "postgres";
import { z } from "zod";
import { ApiError } from "../../auth/service";

const replaceBodySchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    snapshot: knowledgeSnapshotSchema,
    sourceVersions: sourceVersionsSchema.default({}),
  })
  .strict();

const rebuildBodySchema = z
  .object({
    clientKey: z.string().min(8).max(200),
  })
  .strict();

function emptyRecord(courseId: string): OpeningKnowledgeRecord {
  return {
    version: 0,
    snapshot: { courseId, version: 0, nodes: [], edges: [] },
    sourceVersions: {},
  };
}

function mapError(error: unknown): never {
  if (error instanceof OpeningKnowledgeError) {
    if (error.code === "NOT_FOUND") throw new ApiError("NOT_FOUND", error.message, 404);
    if (error.code === "VALIDATION") throw new ApiError("VALIDATION", error.message, 400);
    throw new ApiError("CONFLICT", error.message, 409);
  }
  throw error;
}

export function createOpeningKnowledgeService(sql: Sql) {
  const repo = createOpeningKnowledgeRepository(sql);
  return {
    async get(scope: Scope, courseIdRaw: string) {
      const courseId = uuidSchema.parse(courseIdRaw);
      try {
        const record = await repo.get(scope, courseId);
        return record ?? emptyRecord(courseId);
      } catch (error) {
        mapError(error);
      }
    },

    async replace(scope: Scope, courseIdRaw: string, body: unknown) {
      const courseId = uuidSchema.parse(courseIdRaw);
      const input = replaceBodySchema.parse(body);
      try {
        return await repo.replace(scope, courseId, {
          expectedVersion: input.expectedVersion,
          snapshot: input.snapshot as KnowledgeSnapshot,
          sourceVersions: input.sourceVersions,
        });
      } catch (error) {
        mapError(error);
      }
    },

    async rebuild(scope: Scope, courseIdRaw: string, body: unknown) {
      const courseId = uuidSchema.parse(courseIdRaw);
      const input = rebuildBodySchema.parse(body);
      try {
        return await repo.enqueueRebuild(scope, courseId, input);
      } catch (error) {
        mapError(error);
      }
    },
  };
}

export type OpeningKnowledgeService = ReturnType<typeof createOpeningKnowledgeService>;
