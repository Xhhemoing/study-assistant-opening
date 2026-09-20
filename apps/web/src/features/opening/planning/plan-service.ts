import {
  acceptPlanInputSchema,
  taskCreateInputSchema,
  weekSessionSchema,
  type PlanDraft,
  type Scope,
  type TaskItem,
  type TimeBlock,
  type WeekSession,
} from "@aistudy/contracts";
import { planDay } from "@aistudy/domain";
import {
  createOpeningPlansRepository,
  OpeningPlanError,
  type OpeningPlansRepository,
} from "@aistudy/database";
import type { Sql } from "postgres";
import { z } from "zod";
import { ApiError } from "../../auth/service";

const proposeBodySchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    free: z.array(
      z.object({
        start: z.string(),
        end: z.string(),
        kind: z.enum(["class", "sleep", "meal", "locked", "free"]),
      }),
    ),
    clientKey: z.string().min(8).max(200).optional(),
  })
  .strict();

export function createOpeningPlanService(sql: Sql) {
  const repo: OpeningPlansRepository = createOpeningPlansRepository(sql);

  return {
    listTasks(scope: Scope) {
      return repo.listTasks(scope);
    },

    async createTask(scope: Scope, raw: unknown): Promise<TaskItem> {
      const input = taskCreateInputSchema.parse(raw);
      try {
        return await repo.createTask(scope, input);
      } catch (error) {
        throw mapRepoError(error);
      }
    },

    listTimetable(scope: Scope) {
      return repo.listTimetable(scope);
    },

    async saveTimetable(scope: Scope, raw: unknown): Promise<WeekSession[]> {
      const sessions = z.array(weekSessionSchema).parse(raw);
      return repo.replaceTimetable(scope, sessions);
    },

    async getToday(scope: Scope, date: string) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new OpeningPlanError("VALIDATION", "date must be YYYY-MM-DD");
      }
      const state = await repo.getToday(scope, date);
      const hard = await repo.listHardBlocks(scope, date);
      return {
        date,
        acceptedVersion: state?.acceptedVersion ?? 0,
        blocks: state?.blocks ?? [],
        hardBlocks: hard,
      };
    },

    async proposePlan(scope: Scope, raw: unknown): Promise<PlanDraft> {
      const body = proposeBodySchema.parse(raw);
      const tasks = await repo.listTasks(scope);
      const planned = planDay(tasks, body.free as TimeBlock[]);
      await repo.upsertHardBlocks(scope, body.date, body.free as TimeBlock[]);
      try {
        return await repo.proposePlan(scope, {
          date: body.date,
          tasks,
          free: body.free as TimeBlock[],
          blocks: planned.blocks,
          unscheduledTaskIds: planned.unscheduledTaskIds,
          clientKey: body.clientKey ?? null,
        });
      } catch (error) {
        throw mapRepoError(error);
      }
    },

    async acceptPlan(scope: Scope, raw: unknown): Promise<PlanDraft> {
      const input = acceptPlanInputSchema.parse(raw);
      try {
        return await repo.acceptPlan(scope, input);
      } catch (error) {
        throw mapRepoError(error);
      }
    },

    async rejectPlan(scope: Scope, draftId: string): Promise<PlanDraft> {
      try {
        return await repo.rejectPlan(scope, draftId);
      } catch (error) {
        throw mapRepoError(error);
      }
    },
  };
}

function mapRepoError(error: unknown): Error {
  if (error instanceof OpeningPlanError) {
    if (error.code === "NOT_FOUND") return new ApiError("NOT_FOUND", error.message, 404);
    if (error.code === "VALIDATION") return new ApiError("VALIDATION", error.message, 400);
    return new ApiError("CONFLICT", error.message, 409);
  }
  return error instanceof Error ? error : new Error(String(error));
}

export type OpeningPlanService = ReturnType<typeof createOpeningPlanService>;
