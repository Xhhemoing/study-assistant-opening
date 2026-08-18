import { describe, expect, it } from "vitest";
import {
  attemptEventSchema,
  chatTurnSchema,
  diagnosticsSchema,
  explorationSchema,
  plannedTaskSchema,
  promotionCandidateSchema,
  reviewCardSchema,
  reviewGradeSchema,
  reviewStateSchema,
  statusResultSchema,
  studyGoalInputSchema,
  studyGoalSchema,
  todayPlanSchema,
} from "./index";

const UUID = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-08-02T08:00:00.000Z";

const validGoal = {
  id: UUID,
  ownerUserId: UUID,
  title: "高等数学（上）期末",
  scenario: "final",
  examDate: "2026-08-16",
  subjects: ["高等数学"],
  dailyMinutes: 45,
  courseId: null,
  archivedAt: null,
  strategyVersion: "goal-1",
  createdAt: NOW,
  updatedAt: NOW,
};

const validAttempt = {
  id: UUID,
  ownerUserId: UUID,
  practiceItemId: UUID,
  syllabusPointId: UUID,
  idempotencyKey: "attempt-key-1",
  answer: "A",
  correct: true,
  assisted: false,
  durationMs: 12000,
  hintCount: 0,
  confidence: 4,
  errorCause: null,
  abilitySlice: "recall",
  contentVersion: 1,
  schemaVersion: 1,
  createdAt: NOW,
};

const validStatus = {
  syllabusPointId: UUID,
  status: "usable",
  summaryMetrics: [{ key: "coverage", label: "证据覆盖", value: "3/6" }],
  reasonCodes: ["partial-mastery"],
  recommendedActions: [{ code: "variant", label: "1道变式题巩固", estimatedMinutes: 10 }],
  evidenceSnapshotId: "snap-abc123",
  strategyVersion: "assess-1",
  modelVersion: "rules-1",
  computedAt: NOW,
};

const validTask = {
  id: "plan-2026-08-02-practice-p1",
  kind: "practice",
  refId: "p1",
  title: "导数的定义",
  estimatedMinutes: 10,
  reason: "薄弱考点，优先补缺",
  locked: false,
  status: "pending",
};

const validPlan = {
  id: "plan-u-2026-08-02",
  ownerUserId: UUID,
  date: "2026-08-02",
  budgetMinutes: 45,
  totalMinutes: 20,
  tasks: [validTask],
  options: [],
  strategyVersion: "plan-1",
  generatedAt: NOW,
  evidenceSnapshotId: "snap-plan-contract",
};

describe("frontend domain contracts", () => {
  it("parses valid samples for every schema", () => {
    expect(studyGoalSchema.parse(validGoal).title).toBe("高等数学（上）期末");
    expect(attemptEventSchema.parse(validAttempt).confidence).toBe(4);
    expect(statusResultSchema.parse(validStatus).status).toBe("usable");
    expect(plannedTaskSchema.parse(validTask).kind).toBe("practice");
    expect(todayPlanSchema.parse(validPlan).tasks).toHaveLength(1);
    expect(
      reviewCardSchema.parse({
        id: UUID,
        ownerUserId: UUID,
        front: "导数的定义",
        back: "极限定义的导数",
        sourceDocumentId: null,
        syllabusPointId: null,
        tags: ["高数"],
        archived: false,
        createdAt: NOW,
      }).archived,
    ).toBe(false);
    expect(
      reviewStateSchema.parse({
        cardId: UUID,
        ease: 2.5,
        intervalDays: 0,
        dueAt: NOW,
        reps: 0,
        lapses: 0,
        lastGrade: null,
        updatedAt: NOW,
      }).ease,
    ).toBe(2.5);
    expect(
      explorationSchema.parse({
        id: UUID,
        ownerUserId: UUID,
        title: "熵到底是什么",
        status: "open",
        createdAt: NOW,
        updatedAt: NOW,
      }).status,
    ).toBe("open");
    expect(
      chatTurnSchema.parse({
        id: UUID,
        explorationId: UUID,
        author: "ai",
        aiRole: "explainer",
        content: "用生活例子解释熵。",
        simulated: true,
        createdAt: NOW,
      }).simulated,
    ).toBe(true);
    expect(
      promotionCandidateSchema.parse({
        id: UUID,
        explorationId: UUID,
        turnId: UUID,
        kind: "note",
        title: "熵的直觉解释",
        body: "熵是混乱程度的度量。",
        status: "pending",
        promotedTargetId: null,
        createdAt: NOW,
      }).kind,
    ).toBe("note");
    expect(
      diagnosticsSchema.parse({
        versions: { srs: "srs-1" },
        recentAttemptEvents: [validAttempt],
        statuses: [validStatus],
        planTaskReasons: [{ taskId: "t1", reason: "薄弱考点" }],
      }).recentAttemptEvents,
    ).toHaveLength(1);
  });

  it("applies defaults on goal input", () => {
    const parsed = studyGoalInputSchema.parse({});
    expect(parsed).toMatchObject({
      title: "未命名目标",
      scenario: "final",
      examDate: null,
      subjects: [],
      dailyMinutes: 45,
      courseId: null,
    });
  });

  it("rejects invalid values", () => {
    expect(() => studyGoalSchema.parse({ ...validGoal, id: "nope" })).toThrow();
    expect(() => attemptEventSchema.parse({ ...validAttempt, confidence: 0 })).toThrow();
    expect(() => attemptEventSchema.parse({ ...validAttempt, confidence: 6 })).toThrow();
    expect(() =>
      statusResultSchema.parse({
        ...validStatus,
        summaryMetrics: [
          { key: "a", label: "a", value: "1" },
          { key: "b", label: "b", value: "2" },
          { key: "c", label: "c", value: "3" },
          { key: "d", label: "d", value: "4" },
        ],
      }),
    ).toThrow();
    expect(() => statusResultSchema.parse({ ...validStatus, recommendedActions: [] })).toThrow();
    expect(() => studyGoalSchema.parse({ ...validGoal, examDate: "2026/08/16" })).toThrow();
    expect(() => reviewGradeSchema.parse("perfect")).toThrow();
    expect(() =>
      reviewStateSchema.parse({
        cardId: UUID,
        ease: 1.2,
        intervalDays: 0,
        dueAt: NOW,
        reps: 0,
        lapses: 0,
        lastGrade: null,
        updatedAt: NOW,
      }),
    ).toThrow();
  });
});
