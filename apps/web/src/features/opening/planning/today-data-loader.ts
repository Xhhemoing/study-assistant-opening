import type { OpeningApi } from "../client/api";

type TodayApi = Pick<OpeningApi, "listTasks" | "getToday">;
type Observer = {
  isCurrent: () => boolean;
  tasks: (tasks: Awaited<ReturnType<TodayApi["listTasks"]>>["tasks"]) => void;
  plan: (plan: Awaited<ReturnType<TodayApi["getToday"]>>) => void;
  taskError: (reason: unknown) => void;
  planError: (reason: unknown) => void;
};

/** Tasks render independently of the plan. Optional reminder tools are not read here. */
export async function readTodayData(api: TodayApi, date: string, observer: Observer): Promise<void> {
  await Promise.all([
    api.listTasks().then(
      result => { if (observer.isCurrent()) observer.tasks(result.tasks); },
      reason => { if (observer.isCurrent()) observer.taskError(reason); },
    ),
    api.getToday(date).then(
      result => { if (observer.isCurrent()) observer.plan(result); },
      reason => { if (observer.isCurrent()) observer.planError(reason); },
    ),
  ]);
}
