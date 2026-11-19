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

const confirmBodySchema = z.object({
  nodeId: uuidSchema,
  expectedVersion: z.number().int().nonnegative(),
  sourceVersions: sourceVersionsSchema,
}).strict();

const rebuildBodySchema = z
  .object({
    clientKey: z.string().min(8).max(200),
  })
  .strict();

function mapError(error: unknown): never {
  if (error instanceof OpeningKnowledgeError) {
    if (error.code === "NOT_FOUND") throw new ApiError("NOT_FOUND", error.message, 404);
    if (error.code === "VALIDATION") throw new ApiError("VALIDATION", error.message, 400);
    const conflict = new ApiError("CONFLICT", error.message, 409);
    throw error.reason ? Object.assign(conflict, { reason: error.reason }) : conflict;
  }
  throw error;
}

export function createOpeningKnowledgeService(sql: Sql) {
  const repo = createOpeningKnowledgeRepository(sql);
  return {
    async get(scope: Scope, courseIdRaw: string, options?: { syncDetails?: boolean; jobId?: string }) {
      const courseId = uuidSchema.parse(courseIdRaw);
      const requestedJobId = options?.jobId !== undefined ? uuidSchema.parse(options.jobId) : undefined;
      try {
        return await repo.getWithSync(scope, courseId, {
          includeDetails: Boolean(options?.syncDetails),
          ...(requestedJobId !== undefined ? { requestedJobId } : {}),
        });
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

    async confirmNode(scope: Scope, courseIdRaw: string, body: unknown) {
      const courseId = uuidSchema.parse(courseIdRaw);
      const input = confirmBodySchema.parse(body);
      try {
        return await repo.confirmNode(scope, courseId, input.nodeId, input);
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
