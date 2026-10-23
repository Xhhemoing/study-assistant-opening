import "server-only";
import type { Sql } from "postgres";
import { createOpeningAdaptivePrefsRepository, createOpeningLearningRepository, createOpeningPlanningSettingsRepository, createOpeningPlansRepository } from "@aistudy/database";
import { createSprintBudgetService } from "./sprint-budget-service";

export function getSprintBudgetService(sql: Sql) {
  return { read: (scope: Parameters<ReturnType<typeof createSprintBudgetService>["read"]>[0], courseId: string) =>
    sql.begin("isolation level repeatable read read only", async tx => {
      const db = tx as unknown as Sql;
      const plans = createOpeningPlansRepository(db);
      return createSprintBudgetService({
        assertCourse: (owned, id) => createOpeningLearningRepository(db).assertOwnedCourse(owned, id),
        preferences: owned => createOpeningAdaptivePrefsRepository(db).get(owned),
        settings: owned => createOpeningPlanningSettingsRepository(db).get(owned),
        tasks: owned => plans.listTasks(owned),
        timetable: owned => plans.listTimetable(owned),
        day: async (owned, date) => ({ accepted: (await plans.getToday(owned, date))?.blocks ?? [], hard: await plans.listHardBlocks(owned, date) }),
      }).read(scope, courseId);
    }),
  };
}
