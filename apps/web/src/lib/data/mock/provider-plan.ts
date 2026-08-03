import {
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
  type TodayPlan,
} from "@aistudy/contracts";
import { buildTodayPlan, deriveStatus, scheduleReview, type EvidenceEvent } from "@aistudy/domain";
import { SEED_SYLLABUS } from "./seeds";
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
  ReviewQueueItem,
  SubmissionResult,
  StatusCorrection,
} from "../types";

function statusForPoint(state: MockProviderState, pointId: string, now: Date): StatusResult {
  const events = readDomain<AttemptEvent[]>(state, "attemptEvents", []);
  const evidence: EvidenceEvent[] = events.filter((event) => event.syllabusPointId === pointId).map((event) => ({
    correct: event.correct,
    assisted: event.assisted,
    hintCount: event.hintCount,
    confidence: event.confidence,
    slice: event.abilitySlice,
    occurredAt: event.createdAt,
  }));
  return deriveStatus(pointId, evidence, now);
}

export function listStatuses(state: MockProviderState): StatusResult[] {
  const now = state.now();
  return SEED_SYLLABUS.map((point) => statusForPoint(state, point.id, now));
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

function planForDate(state: MockProviderState, date: string): TodayPlan {
  const goal = listGoals(state)[0];
  const snapshots = readPlanSnapshots(state);
  const snapshot: PlanSnapshot = snapshots[date] ?? { overlays: {}, lastPlan: null };
  if (!goal) throw new Error("请先创建一个学习目标");
  const lockedTasks = (snapshot.lastPlan?.tasks ?? []).filter((task) => snapshot.overlays[task.id]?.locked);
  const lockedRefs = new Set(lockedTasks.map((task) => task.refId));
  const items = readDomain<import("@aistudy/contracts").PracticeItem[]>(state, "practiceItems", []);
  const statuses = listStatuses(state);
  const points = SEED_SYLLABUS.flatMap((point) => {
    const item = items.find((candidate) => candidate.syllabusPointId === point.id);
    const status = statuses.find((candidate) => candidate.syllabusPointId === point.id);
    if (!item || !status || lockedRefs.has(item.id)) return [];
    return [{ pointId: point.id, title: point.title, status: status.status, estimatedMinutes: item.estimatedMinutes, practiceItemId: item.id }];
  });
  const cards = readDomain<import("@aistudy/contracts").ReviewCard[]>(state, "reviewCards", []);
  const states = readDomain<ReviewState[]>(state, "reviewStates", []);
  const nowMs = state.now().getTime();
  const dueReviews = states.filter((item) => !lockedRefs.has(item.cardId) && Date.parse(item.dueAt) <= nowMs).flatMap((stateItem) => {
    const card = cards.find((candidate) => candidate.id === stateItem.cardId);
    return card && !card.archived ? [{ cardId: card.id, front: card.front, estimatedMinutes: 5 }] : [];
  });
  const plan = buildTodayPlan({
    ownerUserId: state.userId,
    date,
    budgetMinutes: goal.dailyMinutes,
    scenario: goal.scenario,
    points,
    dueReviews,
    lockedTasks,
  });
  const applied = applyOverlay(plan, snapshot.overlays);
  snapshots[date] = { overlays: snapshot.overlays, lastPlan: applied };
  writePlanSnapshots(state, snapshots);
  return applied;
}

export function getTodayPlan(state: MockProviderState, date?: string): TodayPlan {
  return planForDate(state, date ?? todayKey(state.now()));
}

function setOverlay(state: MockProviderState, date: string, taskId: string, patch: PlanOverlay): TodayPlan {
  const current = planForDate(state, date);
  const snapshots = readPlanSnapshots(state);
  const snapshot = snapshots[date] ?? { overlays: {}, lastPlan: current };
  snapshot.overlays[taskId] = { ...snapshot.overlays[taskId], ...patch };
  snapshots[date] = snapshot;
  writePlanSnapshots(state, snapshots);
  return planForDate(state, date);
}

export function setTaskStatus(state: MockProviderState, date: string, taskId: string, status: PlannedTask["status"]): TodayPlan {
  return setOverlay(state, date, taskId, { status });
}

export function toggleTaskLock(state: MockProviderState, date: string, taskId: string): TodayPlan {
  const current = planForDate(state, date);
  const task = current.tasks.find((candidate) => candidate.id === taskId);
  return task ? setOverlay(state, date, taskId, { locked: !task.locked }) : current;
}

export function getPracticeItem(state: MockProviderState, id: string) {
  return readDomain<import("@aistudy/contracts").PracticeItem[]>(state, "practiceItems", []).find((item) => item.id === id) ?? null;
}

function normalized(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

function isCorrect(answer: string, item: import("@aistudy/contracts").PracticeItem): boolean {
  if (item.kind === "checkpoint") {
    const actual = new Set(answer.split(",").map((value) => value.trim()).filter(Boolean));
    const expected = new Set(item.answer.split(",").map((value) => value.trim()));
    return actual.size === expected.size && [...actual].every((value) => expected.has(value));
  }
  return normalized(answer) === normalized(item.answer) || (item.kind === "short_answer" && normalized(answer).includes(normalized(item.answer)));
}

export function submitAttempt(state: MockProviderState, input: AttemptInput): SubmissionResult {
  const item = getPracticeItem(state, input.practiceItemId);
  if (!item) throw new Error("练习题不存在");
  const events = readDomain<AttemptEvent[]>(state, "attemptEvents", []);
  const existing = events.find((event) => event.idempotencyKey === input.idempotencyKey);
  if (existing) return { event: existing, status: statusForPoint(state, item.syllabusPointId, state.now()) };
  const event = attemptEventSchema.parse({
    id: newId(), ownerUserId: state.userId, practiceItemId: item.id, syllabusPointId: item.syllabusPointId,
    idempotencyKey: input.idempotencyKey, answer: input.answer, correct: isCorrect(input.answer, item),
    assisted: input.assisted, durationMs: input.durationMs, hintCount: input.hintCount, confidence: input.confidence,
    errorCause: input.errorCause, abilitySlice: item.abilitySlice, contentVersion: item.contentVersion,
    schemaVersion: 1, createdAt: state.now().toISOString(),
  });
  writeDomain(state, "attemptEvents", [...events, event]);
  return { event, status: statusForPoint(state, item.syllabusPointId, state.now()) };
}

export function recordStatusCorrection(state: MockProviderState, syllabusPointId: string, note: string): StatusCorrection {
  const correction = { id: newId(), syllabusPointId, note, createdAt: state.now().toISOString() };
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
  const point = input.syllabusPointId ?? SEED_SYLLABUS[0]?.id;
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
  return next;
}
