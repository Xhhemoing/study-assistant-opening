import type { TaskItem } from "@aistudy/contracts";
export type StudyTask = TaskItem & { reason?: string };
export function taskPrompt(task: StudyTask): string {
  return `我想开始这项学习任务：${task.title}。预计用时 ${task.minutes} 分钟。请先了解我的思路，再帮助我推进。`;
}
/** Selecting a task never writes to the conversation; this explicit action protects its draft. */
export function replacePromptDraft(current: string, next: string, confirm: () => boolean): string {
  return current.trim() && current !== next && !confirm() ? current : next;
}
