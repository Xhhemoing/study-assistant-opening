import { learningAgendaSchema, type LearningAgenda } from "@aistudy/contracts";

export type LearningAgendaAssemblyInput = Pick<LearningAgenda, "courseId"> & Partial<LearningAgenda>;

/** Pure boundary adapter: absent observations remain unknown/null rather than becoming new facts. */
export function assembleLearningAgenda(input: LearningAgendaAssemblyInput): LearningAgenda {
  return learningAgendaSchema.parse({
    courseId: input.courseId, goalId: input.goalId ?? null, activityId: input.activityId ?? null,
    sessionId: input.sessionId ?? null, itemVersionId: input.itemVersionId ?? null,
    status: input.status ?? "unknown", mode: input.mode ?? "unknown", userOverride: input.userOverride ?? null,
    help: input.help ?? { delivered: false, level: "unknown" }, requirement: input.requirement ?? null,
    selectedAction: input.selectedAction ?? null, returnTo: input.returnTo ?? null, originActivityId: input.originActivityId ?? null,
    pendingRetestId: input.pendingRetestId ?? null, parentDecisionId: input.parentDecisionId ?? null,
    decisionCurrent: input.decisionCurrent ?? null, invalidationReasons: input.invalidationReasons ?? [],
    intent: input.intent ?? null, moveId: input.moveId ?? null, budget: input.budget ?? null,
    decisionId: input.decisionId ?? null, resumable: input.resumable ?? false, suggestion: input.suggestion ?? null,
    dataAsOf: input.dataAsOf ?? new Date().toISOString(),
  });
}
