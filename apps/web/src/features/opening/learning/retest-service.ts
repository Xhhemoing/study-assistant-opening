import type { Scope } from "@aistudy/contracts";
import { createOpeningPlansRepository, createOpeningRetestRepository, OpeningPlanError } from "@aistudy/database";
import type { Sql } from "postgres";
import { ApiError } from "../../auth/service";

const DEFAULT_RETEST_MINUTES = 20;

export function createOpeningRetestService(sql: Sql) {
  const repo = createOpeningRetestRepository(sql);
  const plans = createOpeningPlansRepository(sql);
  return {
    async accept(scope: Scope, id: string, clientKey: string) {
      const rows = await sql`
        SELECT payload FROM opening_jobs
        WHERE id = ${id}
          AND workspace_id = ${scope.workspaceId}
          AND owner_user_id = ${scope.ownerUserId}
          AND kind = ${"retest"}
        LIMIT 1`;
      if (!rows.length) {
        throw new ApiError("NOT_FOUND", "retest candidate not found", 404);
      }
      const payload = rows[0]!.payload as {
        kind?: string;
        courseId?: string;
        skillLabel?: string;
        prompt?: string;
        sourceIds?: string[];
        dueAt?: string;
        accepted?: boolean;
        taskId?: string;
        acceptClientKey?: string;
        acceptPayloadHash?: string;
      };
      if (payload.kind !== "task") {
        throw new ApiError("VALIDATION", "retest candidate payload.kind must be task", 400);
      }
      if (!payload.prompt) {
        throw new ApiError("VALIDATION", "retest candidate is missing a prompt", 400);
      }
      try {
        const task = await plans.createTask(scope, {
          title: payload.prompt.slice(0, 240),
          minutes: DEFAULT_RETEST_MINUTES,
          dueAt: null,
          priority: 1,
          candidateId: id,
          clientKey,
          baseVersion: 0,
          inputSnapshot: {
            kind: "retest",
            candidateId: id,
            courseId: payload.courseId,
            skillLabel: payload.skillLabel,
            prompt: payload.prompt,
            sourceIds: payload.sourceIds,
            dueAt: payload.dueAt ?? null,
            heuristic: true,
          },
        });
        return { ...payload, accepted: true, taskId: task.id, dueAt: task.dueAt };
      } catch (error) {
        if (error instanceof OpeningPlanError) {
          if (error.code === "NOT_FOUND") throw new ApiError("NOT_FOUND", error.message, 404);
          if (error.code === "VALIDATION") throw new ApiError("VALIDATION", error.message, 400);
          throw new ApiError("CONFLICT", error.message, 409);
        }
        throw error;
      }
    },
    saveCandidates(scope: Scope, candidates: Parameters<typeof repo.saveCandidates>[1]) {
      return repo.saveCandidates(scope, candidates);
    },
    listAcceptedSkillLabels(scope: Scope, courseId: string) {
      return repo.listAcceptedSkillLabels(scope, courseId);
    },
  };
}

export type OpeningRetestService = ReturnType<typeof createOpeningRetestService>;
