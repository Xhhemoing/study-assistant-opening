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

/** Match the visible queue: a hidden, not-yet-due retest must never be auto-opened. */
export function selectTodayTask(
  groups: { confirmed: TaskItem[]; dueRetests: TaskItem[]; overdue: TaskItem[]; other: TaskItem[]; done: TaskItem[] },
  options: { selectedId?: string; focusTaskId?: string; doneView?: boolean } = {},
): TaskItem | null {
  const pending = [...groups.confirmed, ...groups.dueRetests, ...groups.overdue, ...groups.other];
  if (options.doneView) {
    return groups.done.find(task => task.id === options.selectedId)
      ?? groups.done.find(task => task.id === options.focusTaskId)
      ?? groups.done[0] ?? null;
  }
  const selected = pending.find(task => task.id === options.selectedId);
  if (selected) return selected;
  // Explicit completed-task links remain readable; ordinary completion advances.
  const focused = [...pending, ...groups.done].find(task => task.id === options.focusTaskId);
  return focused ?? pending[0] ?? null;
}

/** Called after the mobile queue is opened, so focus never targets a hidden panel. */
export function focusPriorityActions(element: Pick<HTMLElement, "scrollIntoView" | "focus"> | null): boolean {
  if (!element) return false;
  element.scrollIntoView({ block: "start" });
  element.focus({ preventScroll: true });
  return true;
}
