import type { ReviewQueueItem, TaskItem } from "@aistudy/contracts";
import { courseStudyHref } from "../../courses/course-study-model";

export type ReviewTask = { task: TaskItem; kind: "retest" | "reinforcement"; href: string | null; availableAt: string | null };
export type ReviewTaskGroups = { ready: ReviewTask[]; upcoming: ReviewTask[]; unavailable: ReviewTask[] };

/** Only accepted server tasks are actionable. A weak-skill suggestion is not a wrong-answer record. */
export function groupReviewTasks(tasks: TaskItem[], now: number): ReviewTaskGroups {
  const groups: ReviewTaskGroups = { ready: [], upcoming: [], unavailable: [] };
  for (const task of tasks) {
    if (task.status !== "pending" || (!task.retest && task.suggestionKind !== "weak_skill")) continue;
    const kind = task.retest ? "retest" : "reinforcement";
    const dates = [task.notBefore, task.retest?.recommendedAt].filter((value): value is string => Boolean(value));
    const availableAt = dates.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
    const courseMatches = Boolean(task.courseId) && (!task.retest || task.courseId === task.retest.courseId);
    const item: ReviewTask = { task, kind, availableAt, href: courseMatches ? `${courseStudyHref(task.courseId!)}?task=${encodeURIComponent(task.id)}` : null };
    if (!item.href) groups.unavailable.push(item);
    else if (availableAt && Date.parse(availableAt) > now) groups.upcoming.push(item);
    else groups.ready.push(item);
  }
  const priority = (a: ReviewTask, b: ReviewTask) => b.task.priority - a.task.priority || a.task.id.localeCompare(b.task.id);
  groups.ready.sort(priority);
  groups.upcoming.sort((a, b) => Date.parse(a.availableAt!) - Date.parse(b.availableAt!) || priority(a, b));
  return groups;
}

type SourceResult<T> = { kind: "ready"; value: T } | { kind: "error"; message: string };
export type ReviewSources = { cards: SourceResult<ReviewQueueItem[]>; tasks: SourceResult<TaskItem[]> };

/** A failure in one source must not masquerade as an empty/completed queue. */
export async function loadReviewSources(client: { listCards: () => Promise<ReviewQueueItem[]>; listTasks: () => Promise<{ tasks: TaskItem[] }> }): Promise<ReviewSources> {
  const [cards, tasks] = await Promise.allSettled([client.listCards(), client.listTasks()]);
  const failure = (reason: unknown) => ({ kind: "error" as const, message: reason instanceof Error ? reason.message : "读取失败，请重试。" });
  return {
    cards: cards.status === "fulfilled" ? { kind: "ready", value: cards.value } : failure(cards.reason),
    tasks: tasks.status === "fulfilled" ? { kind: "ready", value: tasks.value.tasks } : failure(tasks.reason),
  };
}
