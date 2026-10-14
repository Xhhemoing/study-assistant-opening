/** Builds a draft-only task schedule from the conversation learning steps. */
import type { TaskItem, TimeBlock } from "@aistudy/contracts";
import { planDay, type DayPlanResult, type PlanDayOptions } from "../day-planner";
import type { LearningSessionProposal } from "./conversation-learning";

export type ConversationTaskDraft = {
  status: "draft";
  intentKey: string;
  tasks: TaskItem[];
  preview: DayPlanResult;
  requiresAcceptance: true;
};

/**
 * ids and intentKey come from the server. Persist ONLY through the existing
 * version-checked PlanDraft accept transaction. This function never touches DB.
 */
export function buildConversationTaskDraft(input: {
  proposal: LearningSessionProposal;
  intentKey: string;
  idFor: (key: string) => string;
  free: readonly TimeBlock[];
  options: PlanDayOptions;
}): ConversationTaskDraft {
  if (!input.intentKey || input.intentKey.length < 8 || input.intentKey.length > 200) {
    throw new Error("stable intentKey is required");
  }
  const tasks: TaskItem[] = input.proposal.steps.map((step, position) => ({
    id: input.idFor(`${input.intentKey}:${position}:${step.kind}`),
    title: step.title,
    minutes: step.minutes,
    dueAt: null,
    priority: 1,
    status: "pending",
    courseId: input.proposal.courseId,
    skillLabel: input.proposal.topic,
    origin: "agent",
  }));
  const ids = tasks.map(t => t.id);
  if (new Set(ids).size !== ids.length) throw new Error("task ids must be unique");
  return {
    status: "draft", intentKey: input.intentKey, tasks,
    preview: planDay(tasks, input.free, { ...input.options, preferredOrder: ids }),
    requiresAcceptance: true,
  };
}
