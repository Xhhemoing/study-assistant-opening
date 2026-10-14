import { describe, expect, it } from "vitest";
import type { TaskItem } from "@aistudy/contracts";
import { previewEvidenceTriggeredReplan, proposeLearningSession, resolveConversationIntent } from "./conversation-learning";

const courseId = "11111111-1111-4111-8111-111111111111";
const resolve = (overrides: Record<string, unknown> = {}) => resolveConversationIntent({
  courseId, topic: "矩阵乘法", examDate: "2026-10-25", dailyMinutes: 60,
  preferences: ["explanation", "practice"], selfReportedDifficulty: true, ...overrides,
}, { ownedCourseIds: [courseId], supportedTopics: ["矩阵乘法"] });

const unknown = {
  independentVerifiedCurrent: false, needsDelayedRetest: false,
  hasAssistedAttempts: false, independentTransferVerified: false, evidencePending: false,
};

describe("conversation learning bridge", () => {
  it("keeps the learner's reported difficulty separate from verified mastery", () => {
    const parsed = resolve();
    expect(parsed.needsConfirmation).toBe(false);
    const draft = proposeLearningSession(parsed, unknown, 60);
    expect(draft).toMatchObject({ status: "draft", topic: "矩阵乘法", totalMinutes: 60, requiresAcceptance: true });
    expect(draft!.steps.map(s => s.kind)).toEqual(["diagnostic", "explain", "independent_practice", "transfer", "review"]);
    expect(draft!.steps.reduce((sum, step) => sum + step.minutes, 0)).toBe(60);
    expect(draft!.steps.every(step => step.proposedOnly)).toBe(true);
  });

  it("never guesses a relative exam date or an unowned course", () => {
    const parsed = resolve({ examDate: "十天后", courseId: "other-course", dailyMinutes: 900 });
    expect(parsed.intent.examDate).toBeNull();
    expect(parsed.intent.courseId).toBeNull();
    expect(parsed.intent.dailyMinutes).toBeNull();
    expect(parsed.issues).toContain("ambiguous_exam_date");
    expect(parsed.issues).toContain("unknown_course");
    expect(proposeLearningSession(parsed, unknown, 60)).toBeNull();
  });

  it("routes qualified independent evidence to transfer instead of repeating explanations", () => {
    const draft = proposeLearningSession(resolve(), { ...unknown, independentVerifiedCurrent: true }, 60);
    expect(draft!.steps.map(s => s.kind)).toEqual(["transfer", "review"]);
  });

  it("does not treat an unfinished evidence projection as reliable mastery", () => {
    const draft = proposeLearningSession(resolve(), { ...unknown, evidencePending: true }, 60);
    expect(draft!.steps.map(s => s.kind)).toEqual(["diagnostic"]);
  });

  it("prioritizes due delayed retest", () => {
    const draft = proposeLearningSession(resolve(), { ...unknown, needsDelayedRetest: true }, 60);
    expect(draft!.steps[0]!.kind).toBe("delayed_retest");
  });

  it("respects the actual capacity and refuses an infeasible session", () => {
    const draft = proposeLearningSession(resolve(), unknown, 25);
    expect(draft!.totalMinutes).toBe(25);
    expect(draft!.steps.reduce((sum, s) => sum + s.minutes, 0)).toBe(25);
    expect(proposeLearningSession(resolve(), unknown, 5)).toBeNull();
  });

  it("only previews replan after a missed confirmed block and never writes", () => {
    const task: TaskItem = {
      id: "22222222-2222-4222-8222-222222222222",
      title: "矩阵乘法练习", minutes: 25, dueAt: null, priority: 1, status: "pending",
    };
    const result = previewEvidenceTriggeredReplan({
      acceptedBlocks: [{ taskId: task.id, start: "2026-10-20T09:00:00Z", end: "2026-10-20T09:25:00Z", reason: "confirmed" }],
      tasks: [task],
      free: [{ start: "2026-10-20T10:00:00Z", end: "2026-10-20T11:00:00Z", kind: "free" }],
      now: new Date("2026-10-20T09:30:00Z"),
      options: { localDate: "2026-10-20", timeZone: "UTC" },
    });
    expect(result.trigger.reason).toBe("missed_block");
    expect(result.preview!.blocks[0]?.taskId).toBe(task.id);
    expect(result.requiresAcceptance).toBe(true);
  });
});
