import type { PlanDraft, PlannedBlock, TaskItem } from "@aistudy/contracts";
import { courseStudyHref, courseStudyTasks } from "../courses/course-study-model";
import { selectableSuggestedKeys } from "../planning/daily-draft-selection";

export function sprintTaskHref(task: TaskItem): string {
  if (task.suggestionKind === "review_cards") return "/opening/review?tab=cards";
  if (!task.courseId) return `/opening/settings/planning?task=${encodeURIComponent(task.id)}#task-${encodeURIComponent(task.id)}`;
  const query = new URLSearchParams({ task: task.id });
  const target = task.teachingTarget;
  const requirementKey = task.requirementKey !== undefined ? task.requirementKey : task.retest?.requirementKey;
  // Keep task in the URL: the activity is a hint and must pass fresh task admission on entry.
  if (target?.courseId === task.courseId
    && (requirementKey === undefined || target.requirementKey === requirementKey)) query.set("activity", target.activityId);
  return `${courseStudyHref(task.courseId)}?${query}`;
}

export function sprintTodayTasks(tasks: TaskItem[], blocks: PlannedBlock[], courseId: string, now = new Date()) {
  const actionable = new Set(courseStudyTasks(tasks, courseId, now).map(task => task.id));
  return blocks.flatMap(block => {
    const task = tasks.find(item => item.id === block.taskId && item.courseId === courseId);
    return task ? [{ task, block, actionable: actionable.has(task.id) }] : [];
  });
}

export function sprintTaskTitle(taskId: string, tasks: TaskItem[], draft?: PlanDraft): string {
  return tasks.find(task => task.id === taskId)?.title ?? draft?.suggestedTasks?.find(task => task.id === taskId)?.title ?? "学习任务";
}

export function sprintCandidateBlocks(draft: PlanDraft) {
  const selected = new Set(selectableSuggestedKeys(draft));
  return draft.blocks.filter(block => {
    const suggestion = draft.suggestedTasks?.find(task => task.id === block.taskId);
    return !suggestion || selected.has(suggestion.key);
  });
}

/** Compare service results for display only; never build or reorder a plan here. */
export function sprintPlanChanges(current: PlannedBlock[], draft: PlanDraft, tasks: TaskItem[]) {
  const blocks = sprintCandidateBlocks(draft);
  const nextIds = new Set(blocks.map(block => block.taskId));
  const currentIds = new Set(current.map(block => block.taskId));
  const changes: { kind: "新增" | "移出今天" | "调整时间"; title: string; block?: PlannedBlock }[] = [];
  for (const taskId of nextIds) {
    const next = blocks.filter(block => block.taskId === taskId);
    const previous = current.filter(block => block.taskId === taskId);
    const slots = (items: PlannedBlock[]) => items.map(item => `${item.start}/${item.end}`).sort().join(",");
    if (!currentIds.has(taskId)) changes.push({ kind: "新增", title: sprintTaskTitle(taskId, tasks, draft), block: next[0] });
    else if (slots(previous) !== slots(next)) changes.push({ kind: "调整时间", title: sprintTaskTitle(taskId, tasks, draft), block: next[0] });
  }
  for (const taskId of currentIds) if (!nextIds.has(taskId)) changes.push({ kind: "移出今天", title: sprintTaskTitle(taskId, tasks) });
  return changes;
}
