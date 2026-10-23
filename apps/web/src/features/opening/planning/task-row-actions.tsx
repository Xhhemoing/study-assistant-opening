"use client";

import { createContext, useContext } from "react";
import { TransitionLink as Link } from "../v3/motion/view-transition";
import { studyConversationHref } from "../assistant/study-conversation-context";
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
  return <div className="flex flex-wrap gap-2"><Link className={`${ui.quiet} mb-2`} href={studyConversationHref({ courseId: task.courseId ?? undefined, purpose: "task_start", label: task.title.slice(0, 160), fragment: `任务：${task.title}。预计 ${task.minutes} 分钟。`.slice(0, 4000), returnTo: "/opening/today" })}>先问问这项任务</Link><button type="button" className={`${ui.secondary} mb-2`} disabled={action.busy} onClick={() => action.start(task)}>开始任务主讲</button></div>;
}
