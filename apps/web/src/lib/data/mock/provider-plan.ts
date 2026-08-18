import {
  todayPlanSchema,
  attemptEventSchema,
  practiceItemSchema,
  reviewCardSchema,
  reviewGradeSchema,
  reviewStateSchema,
  type AttemptEvent,
  type PlannedTask,
  type PracticeItem,
  type ReviewCard,
  type ReviewGrade,
  type ReviewState,
  type StatusResult,
  type StatusWord,
  type TodayPlan,
} from "@aistudy/contracts";
import {
  applyPlanOption,
  buildTodayPlan,
  deriveStatus,
  isPracticeAnswerCorrect,
  reviewGradeToEvidence,
  scenarioToGoalKind,
  scheduleReview,
  type EvidenceEvent,
} from "@aistudy/domain";
import { listGoals } from "./provider-goals";
import {
  newId,
  readDomain,
  readPlanSnapshots,
  todayKey,
  writeDomain,
  writePlanSnapshots,
  type MockProviderState,
  type PlanOverlay,
  type PlanSnapshot,
} from "./provider-state";
import type {
  AttemptInput,
  PracticeItemInput,
  ReviewCardInput,
  ReviewEvidenceRecord,
  ReviewQueueItem,
  SubmissionResult,
  StatusCorrection,
} from "../types";

function statusForPoint(state: MockProviderState, pointId: string, now: Date): StatusResult {
  const events = readDomain<AttemptEvent[]>(state, "attemptEvents", []);
  const attemptEvidence: EvidenceEvent[] = events
    .filter((event) => event.syllabusPointId === pointId)
    .map((event) => ({
      correct: event.correct,
      assisted: event.assisted,
      hintCount: event.hintCount,
      confidence: event.confidence,
      errorCause: event.errorCause,
      slice: event.abilitySlice,
      occurredAt: event.createdAt,
      source: "attempt" as const,
    }));
  const reviewEvents = readDomain<ReviewEvidenceRecord[]>(state, "reviewEvents", []);
  const reviewEvidence: EvidenceEvent[] = reviewEvents
    .filter((record) => record.syllabusPointId === pointId)
    .map((record) => reviewGradeToEvidence(record.grade, record.occurredAt));
  const corrections = readDomain<StatusCorrection[]>(state, "corrections", []);
  return deriveStatus(pointId, [...attemptEvidence, ...reviewEvidence], now, corrections, {
    assessmentMode: state.assessmentMode,
    disabledSlices: state.disabledSlices,
  });
}

export function listStatuses(state: MockProviderState): StatusResult[] {
  const now = state.now();
  return state.syllabus.map((point) => statusForPoint(state, point.id, now));
}

function applyOverlay(plan: TodayPlan, overlays: Record<string, PlanOverlay>): TodayPlan {
  return {
    ...plan,
    tasks: plan.tasks.map((task) => ({
      ...task,
      status: overlays[task.id]?.status ?? task.status,
      locked: overlays[task.id]?.locked ?? task.locked,
    })),
  };
}

function activeGoals(state: MockProviderState) {
  return listGoals(state).filter((goal) => goal.archivedAt === null);
}

function goalSetKey(goals: ReturnType<typeof activeGoals>): string {
  return goals.map((goal) => goal.id).sort().join("|");
}

function isGoalSetExtension(previous: string, next: string): boolean {
  const previousIds = previous.split("|").filter(Boolean);
  const nextIds = new Set(next.split("|").filter(Boolean));
  return previousIds.length > 0 && previousIds.every((id) => nextIds.has(id));
}

function planForDate(state: MockProviderState, date: string): TodayPlan {
  const goals = activeGoals(state);
  const primaryGoal = goals[0];
  if (!primaryGoal) throw new Error("请先创建一个学习目标");
  const key = goalSetKey(goals);
  const snapshots = readPlanSnapshots(state);
  const storedSnapshot = snapshots[date];
  const snapshot: PlanSnapshot =
    storedSnapshot && storedSnapshot.goalId === key
      ? storedSnapshot
      : storedSnapshot && isGoalSetExtension(storedSnapshot.goalId, key)
        ? { ...storedSnapshot, goalId: key, selectedOptionId: null }
        : { goalId: key, overlays: {}, lastPlan: null, selectedOptionId: null };
  const previousLockedTasks = (snapshot.lastPlan?.tasks ?? []).filter((task) => snapshot.overlays[task.id]?.locked);
  const items = readDomain<import("@aistudy/contracts").PracticeItem[]>(state, "practiceItems", []);
  const statuses = listStatuses(state);
  const points = state.syllabus.flatMap((point) => {
    const item = items.find((candidate) => candidate.syllabusPointId === point.id);
    const status = statuses.find((candidate) => candidate.syllabusPointId === point.id);
    if (!item || !status) return [];
    return [{ pointId: point.id, title: point.title, status: status.status, estimatedMinutes: item.estimatedMinutes, practiceItemId: item.id }];
  });
  const cards = readDomain<import("@aistudy/contracts").ReviewCard[]>(state, "reviewCards", []);
  const states = readDomain<ReviewState[]>(state, "reviewStates", []);
  const nowMs = state.now().getTime();
  const dueReviews = states.filter((item) => Date.parse(item.dueAt) <= nowMs).flatMap((stateItem) => {
    const card = cards.find((candidate) => candidate.id === stateItem.cardId);
    return card && !card.archived ? [{ cardId: card.id, front: card.front, estimatedMinutes: 5 }] : [];
  });
  const plannerInput = {
    ownerUserId: state.userId,
    date,
    budgetMinutes: goals.reduce((sum, goal) => sum + goal.dailyMinutes, 0),
    scenario: primaryGoal.scenario,
    points,
    dueReviews,
    assessmentMode: state.assessmentMode,
    goals: goals.map((goal) => ({ id: goal.id, kind: scenarioToGoalKind(goal.scenario) })),
    protectedExplorationMinutes: state.protectedExplorationMinutes,
    planningEnabled: state.planningEnabled,
  };
  const baselinePlan = buildTodayPlan({ ...plannerInput, lockedTasks: [] });
  const lockableIds = new Set([
    ...baselinePlan.tasks.map((task) => task.id),
    ...baselinePlan.options.flatMap((option) => option.tasks.map((task) => task.id)),
  ]);
  const lockedTasks = previousLockedTasks.filter((task) => lockableIds.has(task.id));
  const lockedRefs = new Set(lockedTasks.map((task) => task.refId));
  const plan = buildTodayPlan({
    ...plannerInput,
    points: points.filter((point) => !lockedRefs.has(point.practiceItemId)),
    dueReviews: dueReviews.filter((review) => !lockedRefs.has(review.cardId)),
    lockedTasks,
  });
  const chosen = snapshot.selectedOptionId ? applyPlanOption(plan, snapshot.selectedOptionId) : plan;
  const retainIds = new Set([
    ...chosen.tasks.map((task) => task.id),
    ...plan.options.flatMap((option) => option.tasks.map((task) => task.id)),
  ]);
  const overlays = Object.fromEntries(
    Object.entries(snapshot.overlays).filter(([taskId]) => retainIds.has(taskId)),
  );
  const applied = applyOverlay(chosen, overlays);
  snapshots[date] = { goalId: key, overlays, lastPlan: applied, selectedOptionId: snapshot.selectedOptionId ?? null };
  writePlanSnapshots(state, snapshots);
  return applied;
}

export function getTodayPlan(state: MockProviderState, date?: string): TodayPlan {
  return todayPlanSchema.parse(planForDate(state, date ?? todayKey(state.now())));
}

export function selectPlanOption(state: MockProviderState, date: string, optionId: string): TodayPlan {
  planForDate(state, date);
  const snapshots = readPlanSnapshots(state);
  const snapshot = snapshots[date];
  if (!snapshot) throw new Error("今日计划不存在");
  snapshots[date] = { ...snapshot, selectedOptionId: optionId };
  writePlanSnapshots(state, snapshots);
  return todayPlanSchema.parse(planForDate(state, date));
}

function setOverlay(state: MockProviderState, date: string, taskId: string, patch: PlanOverlay): TodayPlan {
  const current = planForDate(state, date);
  const snapshots = readPlanSnapshots(state);
  const goals = activeGoals(state);
  if (goals.length === 0) throw new Error("请先创建一个学习目标");
  const snapshot = snapshots[date] ?? { goalId: goalSetKey(goals), overlays: {}, lastPlan: current };
  snapshots[date] = {
    ...snapshot,
    overlays: { ...snapshot.overlays, [taskId]: { ...snapshot.overlays[taskId], ...patch } },
    lastPlan: current,
  };
  writePlanSnapshots(state, snapshots);
  return planForDate(state, date);
}

export function setTaskStatus(state: MockProviderState, date: string, taskId: string, status: PlannedTask["status"]): TodayPlan {
  return todayPlanSchema.parse(setOverlay(state, date, taskId, { status }));
}

export function toggleTaskLock(state: MockProviderState, date: string, taskId: string): TodayPlan {
  const current = planForDate(state, date);
  const task = current.tasks.find((candidate) => candidate.id === taskId);
  return task ? todayPlanSchema.parse(setOverlay(state, date, taskId, { locked: !task.locked })) : todayPlanSchema.parse(current);
}

export function getPracticeItem(state: MockProviderState, id: string) {
  return readDomain<import("@aistudy/contracts").PracticeItem[]>(state, "practiceItems", []).find((item) => item.id === id) ?? null;
}

export function submitAttempt(state: MockProviderState, input: AttemptInput): SubmissionResult {
  const item = getPracticeItem(state, input.practiceItemId);
  if (!item) throw new Error("练习题不存在");
  const events = readDomain<AttemptEvent[]>(state, "attemptEvents", []);
  const existing = events.find((event) => event.idempotencyKey === input.idempotencyKey);
  if (existing) return { event: existing, status: statusForPoint(state, item.syllabusPointId, state.now()) };
  const event = attemptEventSchema.parse({
    id: input.eventId ?? newId(), ownerUserId: state.userId, practiceItemId: item.id, syllabusPointId: item.syllabusPointId,
    idempotencyKey: input.idempotencyKey, answer: input.answer, correct: isPracticeAnswerCorrect(item, input.answer),
    assisted: input.assisted, durationMs: input.durationMs, hintCount: input.hintCount, confidence: input.confidence,
    errorCause: input.errorCause, abilitySlice: item.abilitySlice, contentVersion: item.contentVersion,
    schemaVersion: 1, createdAt: state.now().toISOString(),
  });
  writeDomain(state, "attemptEvents", [...events, event]);
  return { event, status: statusForPoint(state, item.syllabusPointId, state.now()) };
}

export function recordStatusCorrection(
  state: MockProviderState,
  syllabusPointId: string,
  note: string,
  overrideStatus: StatusWord | null = null,
): StatusCorrection {
  const correction: StatusCorrection = {
    id: newId(),
    syllabusPointId,
    note,
    overrideStatus,
    createdAt: state.now().toISOString(),
  };
  writeDomain(state, "corrections", [...readDomain<StatusCorrection[]>(state, "corrections", []), correction]);
  return correction;
}

export function listDueCards(state: MockProviderState, at = state.now()): ReviewQueueItem[] {
  const cards = readDomain<import("@aistudy/contracts").ReviewCard[]>(state, "reviewCards", []);
  const states = readDomain<ReviewState[]>(state, "reviewStates", []);
  return states.filter((item) => Date.parse(item.dueAt) <= at.getTime()).flatMap((item) => {
    const card = cards.find((candidate) => candidate.id === item.cardId);
    return card && !card.archived ? [{ card, state: item }] : [];
  }).sort((a, b) => a.state.dueAt.localeCompare(b.state.dueAt) || a.card.id.localeCompare(b.card.id));
}

export function createReviewCard(state: MockProviderState, input: ReviewCardInput): ReviewCard {
  const now = state.now().toISOString();
  const card = reviewCardSchema.parse({
    id: newId(),
    ownerUserId: state.userId,
    front: input.front.trim(),
    back: input.back.trim(),
    sourceDocumentId: input.sourceDocumentId ?? null,
    syllabusPointId: input.syllabusPointId ?? null,
    tags: [...new Set((input.tags ?? ["探索"]).map((tag) => tag.trim()).filter(Boolean))],
    archived: false,
    createdAt: now,
  });
  const reviewState = reviewStateSchema.parse({
    cardId: card.id,
    ease: 2.5,
    intervalDays: 0,
    dueAt: now,
    reps: 0,
    lapses: 0,
    lastGrade: null,
    updatedAt: now,
  });
  writeDomain(state, "reviewCards", [...readDomain<ReviewCard[]>(state, "reviewCards", []), card]);
  writeDomain(state, "reviewStates", [...readDomain<ReviewState[]>(state, "reviewStates", []), reviewState]);
  return card;
}

export function createPracticeItem(state: MockProviderState, input: PracticeItemInput): PracticeItem {
  const point = input.syllabusPointId ?? state.syllabus[0]?.id;
  if (!point) throw new Error("没有可用的课程知识点");
  const item = practiceItemSchema.parse({
    id: newId(),
    syllabusPointId: point,
    kind: input.kind ?? "short_answer",
    stem: input.stem.trim(),
    options: input.options,
    answer: input.answer.trim(),
    hints: input.hints?.map((hint) => hint.trim()).filter(Boolean) ?? ["先用自己的话回答，再检查关键条件。"],
    abilitySlice: input.abilitySlice ?? "recall",
    estimatedMinutes: input.estimatedMinutes ?? 5,
    contentVersion: 1,
  });
  writeDomain(state, "practiceItems", [...readDomain<PracticeItem[]>(state, "practiceItems", []), item]);
  return item;
}

export function gradeCard(state: MockProviderState, cardId: string, grade: ReviewGrade): ReviewState {
  reviewGradeSchema.parse(grade);
  const states = readDomain<ReviewState[]>(state, "reviewStates", []);
  const current = states.find((item) => item.cardId === cardId);
  if (!current) throw new Error("复习卡不存在");
  const next = scheduleReview(current, grade, state.now());
  writeDomain(state, "reviewStates", states.map((item) => (item.cardId === cardId ? next : item)));
  const card = readDomain<ReviewCard[]>(state, "reviewCards", []).find((item) => item.id === cardId);
  if (card?.syllabusPointId) {
    const record: ReviewEvidenceRecord = {
      syllabusPointId: card.syllabusPointId,
      grade,
      occurredAt: state.now().toISOString(),
    };
    writeDomain(state, "reviewEvents", [...readDomain<ReviewEvidenceRecord[]>(state, "reviewEvents", []), record]);
  }
  return next;
}
