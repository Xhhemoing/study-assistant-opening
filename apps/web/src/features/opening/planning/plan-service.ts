import {
  acceptPlanInputSchema,
  openingPlanningSettingsSchema,
  taskCreateInputSchema,
  weekSessionSchema,
  type PlanDraft,
  type PlannedBlock,
  type Scope,
  type TaskCreateResult,
  type TaskItem,
  type TimeBlock,
  type WeekSession,
  taskStatusUpdateInputSchema,
  uuidSchema,
} from "@aistudy/contracts";
import {
  addLocalDays,
  buildDailyDraftInput,
  dailyDraftClientKey,
  deriveDayBlocks,
  planDay,
} from "@aistudy/domain";
import {
  createOpeningPlansRepository,
  createOpeningPlanningSettingsRepository,
  OpeningPlanError,
  type OpeningPlansRepository,
} from "@aistudy/database";
import type { Sql } from "postgres";
import { z } from "zod";
import { ApiError } from "../../auth/service";

const proposeBodySchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    free: z
      .array(
        z.object({
          start: z.string(),
          end: z.string(),
          kind: z.enum(["class", "sleep", "meal", "locked", "free"]),
        }),
      )
      .optional(),
    clientKey: z.string().min(8).max(200).optional(),
  })
  .strict();

/** P04 source-revision re-plan adapter input — delta task ids only. */
const proposeDeltaBodySchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    taskIds: z.array(uuidSchema).min(1).max(50),
    free: z
      .array(
        z.object({
          start: z.string(),
          end: z.string(),
          kind: z.enum(["class", "sleep", "meal", "locked", "free"]),
        }),
      )
      .optional(),
    clientKey: z.string().min(8).max(200),
  })
  .strict();

export type DailyDraftSkippedReason = "accepted" | "rejected" | "no_settings";

export type EnsureDailyDraftResult = {
  draft: PlanDraft | null;
  skippedBecauseAccepted: boolean;
  dailyDraftSkippedReason: DailyDraftSkippedReason | null;
  unplannedPendingCount?: number;
};

export type TodayPlanResult = {
  date: string;
  acceptedVersion: number;
  blocks: PlannedBlock[];
  hardBlocks: TimeBlock[];
  dailyDraft?: PlanDraft | null;
  dailyDraftSkippedReason?: DailyDraftSkippedReason | null;
  unplannedPendingCount?: number;
};

function applyDraftReasons(
  blocks: PlannedBlock[],
  reasons: Record<string, { code: string; label: string }>,
): PlannedBlock[] {
  return blocks.map((block) => {
    const reason = reasons[block.taskId];
    if (!reason) return block;
    if (reason.code === "carry_over_yesterday") {
      return { ...block, reason: reason.label };
    }
    return block;
  });
}

function countUnplannedPending(tasks: TaskItem[], acceptedBlocks: PlannedBlock[]): number {
  const planned = new Set(acceptedBlocks.map((b) => b.taskId));
  return tasks.filter((t) => t.status === "pending" && !planned.has(t.id)).length;
}

export function createOpeningPlanService(sql: Sql) {
  const repo: OpeningPlansRepository = createOpeningPlansRepository(sql);

  async function resolveFreeBlocks(scope: Scope, date: string): Promise<TimeBlock[] | null> {
    const preference = await createOpeningPlanningSettingsRepository(sql).get(scope);
    if (!preference.saved || preference.invalidStoredSettings || preference.settings == null) {
      return null;
    }
    const settings = openingPlanningSettingsSchema.parse(preference.settings);
    const sessions = await repo.listTimetable(scope);
    try {
      return deriveDayBlocks(date, settings, sessions);
    } catch {
      return null;
    }
  }

  async function ensureDailyDraft(scope: Scope, date: string): Promise<EnsureDailyDraftResult> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new OpeningPlanError("VALIDATION", "date must be YYYY-MM-DD");
    }
    const clientKey = dailyDraftClientKey(date);

    return repo.ensureAutoDraft(
      scope,
      date,
      clientKey,
      async () => {
        const freeBlocks = await resolveFreeBlocks(scope, date);
        if (!freeBlocks) {
          return { kind: "skip", reason: "no_settings" };
        }
        const preference = await createOpeningPlanningSettingsRepository(sql).get(scope);
        const timeZone = preference.settings?.timeZone ?? "Asia/Shanghai";
        const tasks = await repo.listTasks(scope);
        const yesterday = addLocalDays(date, -1);
        const yesterdayState = await repo.getToday(scope, yesterday);
        const yesterdayAccepted = yesterdayState?.blocks ?? [];
        const dueRetests = tasks.filter((task) => {
          if (task.status !== "pending" || !task.retest?.recommendedAt) return false;
          // Local-day filter is applied again inside buildDailyDraftInput.
          return true;
        });
        const { orderedTaskIds, reasons } = buildDailyDraftInput({
          tasks,
          yesterdayAccepted,
          dueRetests,
          freeBlocks,
          now: new Date(),
          timeZone,
          date,
        });
        const byId = new Map(tasks.map((t) => [t.id, t]));
        const orderedTasks = orderedTaskIds
          .map((id) => byId.get(id))
          .filter((t): t is TaskItem => Boolean(t));
        const planned = planDay(orderedTasks, freeBlocks, {
          dayEnd: `${date}T23:59:59.999Z`,
          preferredOrder: orderedTaskIds,
        });
        const blocks = applyDraftReasons(planned.blocks, reasons);
        return {
          kind: "propose",
          input: {
            date,
            tasks,
            free: freeBlocks,
            blocks,
            unscheduledTaskIds: planned.unscheduledTaskIds,
            clientKey,
          },
        };
      },
      async () => {
        const tasks = await repo.listTasks(scope);
        const state = await repo.getToday(scope, date);
        return countUnplannedPending(tasks, state?.blocks ?? []);
      },
    );
  }

  return {
    listTasks(scope: Scope) {
      return repo.listTasks(scope);
    },

    async createTask(scope: Scope, raw: unknown): Promise<TaskCreateResult> {
      const input = taskCreateInputSchema.parse(raw);
      try {
        return await repo.createTask(scope, input);
      } catch (error) {
        throw mapRepoError(error);
      }
    },

    async updateTaskStatus(scope: Scope, taskId: string, raw: unknown) {
      const input = taskStatusUpdateInputSchema.parse(raw);
      try {
        return await repo.updateTaskStatus(scope, uuidSchema.parse(taskId), input);
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

    ensureDailyDraft,

    async getToday(scope: Scope, date: string): Promise<TodayPlanResult> {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new OpeningPlanError("VALIDATION", "date must be YYYY-MM-DD");
      }
      const ensured = await ensureDailyDraft(scope, date);
      const state = await repo.getToday(scope, date);
      const hard = await repo.listHardBlocks(scope, date);
      const result: TodayPlanResult = {
        date,
        acceptedVersion: state?.acceptedVersion ?? 0,
        blocks: state?.blocks ?? [],
        hardBlocks: hard,
        dailyDraft: ensured.draft,
        dailyDraftSkippedReason: ensured.dailyDraftSkippedReason,
      };
      if (ensured.unplannedPendingCount !== undefined) {
        result.unplannedPendingCount = ensured.unplannedPendingCount;
      }
      return result;
    },

    async proposePlan(scope: Scope, raw: unknown): Promise<PlanDraft> {
      const body = proposeBodySchema.parse(raw);
      const tasks = await repo.listTasks(scope);
      let freeBlocks: TimeBlock[];
      if (body.free !== undefined) {
        freeBlocks = body.free as TimeBlock[];
      } else {
        const preference = await createOpeningPlanningSettingsRepository(sql).get(scope);
        if (!preference.saved || preference.invalidStoredSettings || preference.settings == null) {
          throw new OpeningPlanError(
            "VALIDATION",
            "请先完成学期设置（第一周周一、节次时间与每日可用窗口）后再按建议排程。",
          );
        }
        const settings = openingPlanningSettingsSchema.parse(preference.settings);
        const sessions = await repo.listTimetable(scope);
        try {
          freeBlocks = deriveDayBlocks(body.date, settings, sessions);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new OpeningPlanError("VALIDATION", message);
        }
      }
      const planned = planDay(tasks, freeBlocks, { dayEnd: `${body.date}T23:59:59.999Z` });
      await repo.upsertHardBlocks(scope, body.date, freeBlocks);
      try {
        return await repo.proposePlan(scope, {
          date: body.date,
          tasks,
          free: freeBlocks,
          blocks: planned.blocks,
          unscheduledTaskIds: planned.unscheduledTaskIds,
          clientKey: body.clientKey ?? null,
        });
      } catch (error) {
        throw mapRepoError(error);
      }
    },

    /**
     * P04 re-plan adapter after source revision of an accepted schedule.
     * Only schedules the given delta taskIds. Does not change proposePlan /
     * acceptPlan / rejectPlan confirmation semantics for the full-day path.
     */
    async proposeDeltaPlan(scope: Scope, raw: unknown): Promise<PlanDraft> {
      const body = proposeDeltaBodySchema.parse(raw);
      const allTasks = await repo.listTasks(scope);
      const wanted = new Set(body.taskIds);
      const tasks = allTasks.filter((task) => wanted.has(task.id));
      if (tasks.length === 0) {
        throw new OpeningPlanError("VALIDATION", "delta taskIds did not match any owned tasks");
      }
      let freeBlocks: TimeBlock[];
      if (body.free !== undefined) {
        freeBlocks = body.free as TimeBlock[];
      } else {
        const preference = await createOpeningPlanningSettingsRepository(sql).get(scope);
        if (!preference.saved || preference.invalidStoredSettings || preference.settings == null) {
          throw new OpeningPlanError(
            "VALIDATION",
            "请先完成学期设置（第一周周一、节次时间与每日可用窗口）后再按建议排程。",
          );
        }
        const settings = openingPlanningSettingsSchema.parse(preference.settings);
        const sessions = await repo.listTimetable(scope);
        try {
          freeBlocks = deriveDayBlocks(body.date, settings, sessions);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new OpeningPlanError("VALIDATION", message);
        }
      }
      const planned = planDay(tasks, freeBlocks, {
        dayEnd: `${body.date}T23:59:59.999Z`,
        preferredOrder: body.taskIds,
      });
      await repo.upsertHardBlocks(scope, body.date, freeBlocks);
      try {
        return await repo.proposePlan(scope, {
          date: body.date,
          tasks,
          free: freeBlocks,
          blocks: planned.blocks,
          unscheduledTaskIds: planned.unscheduledTaskIds,
          clientKey: body.clientKey,
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
