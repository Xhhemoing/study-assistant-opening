import type { TaskItem } from "@aistudy/contracts";
export function visibleTodayTasks(tasks: TaskItem[], focusTaskId?: string): TaskItem[] {
  const focused = tasks.find((task) => task.id === focusTaskId);
  const pending = tasks.filter((task) => task.status === "pending" && task.id !== focused?.id);
  return focused ? [focused, ...pending.slice(0, 2)] : pending.slice(0, 3);
}

/** A callback ref runs when the asynchronously loaded task node is attached. */
export function focusTodayTask(element: Pick<HTMLElement, "id" | "scrollIntoView" | "focus"> | null, focusTaskId?: string): void {
  if (!element || !focusTaskId || element.id !== `task-${focusTaskId}`) return;
  element.scrollIntoView({ block: "center" });
  element.focus({ preventScroll: true });
}
