"use client";

import { createContext, useContext } from "react";
import Link from "next/link";
import type { StudyTask } from "./study-task";
import { isRetestOriginTask } from "./task-status-control";
import { ui } from "../design/ui";

export const TaskLearningActionContext = createContext<{ start: (task: StudyTask) => void; busy: boolean } | null>(null);

/** Selecting a row remains read-only; starting teaching requires this explicit action. */
export function TaskRowActions({ task }: { task: StudyTask }) {
  const action = useContext(TaskLearningActionContext);
  if (task.status !== "pending" || isRetestOriginTask(task)) return null;
  if (task.origin === "planner" && task.suggestionKind === "review_cards") {
    return <Link className={`${ui.secondary} mb-2`} href="/opening/cards">开始卡片复习</Link>;
  }
  if (!action) return null;
  return <button type="button" className={`${ui.secondary} mb-2`} disabled={action.busy} onClick={() => action.start(task)}>开始任务主讲</button>;
}
