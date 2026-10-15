import type { OpeningApi } from "../client/api";

type TodayApi = Pick<OpeningApi, "listTasks" | "getToday">;
type Observer = {
  isCurrent: () => boolean;
  tasks: (tasks: Awaited<ReturnType<TodayApi["listTasks"]>>["tasks"]) => void;
  plan: (plan: Awaited<ReturnType<TodayApi["getToday"]>>) => void;
  taskError: (reason: unknown) => void;
  planError: (reason: unknown) => void;
};

/**
 * Tasks render independently of the plan. Reading the plan can add the day's
 * study-plan lessons; the task list is then read again so they show up.
 * Optional reminder tools are not read here.
 */
export async function readTodayData(api: TodayApi, date: string, observer: Observer): Promise<void> {
  const readTasks = () => api.listTasks().then(
    result => { if (observer.isCurrent()) observer.tasks(result.tasks); },
    reason => { if (observer.isCurrent()) observer.taskError(reason); },
  );
  await Promise.all([
    readTasks(),
    api.getToday(date).then(
      async result => {
        if (observer.isCurrent()) observer.plan(result);
        if (result.planTasksAdded) await readTasks();
      },
      reason => { if (observer.isCurrent()) observer.planError(reason); },
    ),
  ]);
}
