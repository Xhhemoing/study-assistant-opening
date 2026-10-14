import { describe, expect, it } from "vitest";
import { resolveConversationIntent, proposeLearningSession } from "./conversation-learning";
import { buildConversationTaskDraft } from "./conversation-task-draft";

const courseId = "11111111-1111-4111-8111-111111111111";
const resolution = resolveConversationIntent({
  courseId, topic: "矩阵乘法", examDate: "2026-10-25", dailyMinutes: 60,
  preferences: ["explanation", "practice"], selfReportedDifficulty: true,
}, { ownedCourseIds: [courseId], supportedTopics: ["矩阵乘法"] });
const proposal = proposeLearningSession(resolution, {
  independentVerifiedCurrent: false, needsDelayedRetest: false,
  hasAssistedAttempts: false, independentTransferVerified: false, evidencePending: false,
}, 60)!;

describe("conversation task draft", () => {
  it("keeps all tasks in an uncommitted preview with a stable identity", () => {
    const input = {
      proposal, intentKey: "turn:fixture:matrix",
      idFor: (key: string) => {
        const index = proposal.steps.findIndex((step, i) => key.endsWith(`:${i}:${step.kind}`));
        return `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
      },
      free: [{ start: "2026-10-20T11:00:00.000Z", end: "2026-10-20T12:00:00.000Z", kind: "free" as const }],
      options: { localDate: "2026-10-20", timeZone: "Asia/Shanghai" },
    };
    const draft = buildConversationTaskDraft(input);
    expect(draft.status).toBe("draft");
    expect(draft.requiresAcceptance).toBe(true);
    expect(draft.tasks.every(t => t.origin === "agent" && t.courseId === courseId && t.skillLabel === "矩阵乘法")).toBe(true);
    expect(draft.preview.blocks).toHaveLength(proposal.steps.length);
    expect(buildConversationTaskDraft(input)).toEqual(draft);
  });

  it("rejects duplicated deterministic ids", () => {
    expect(() => buildConversationTaskDraft({
      proposal, intentKey: "turn:fixture:matrix", idFor: () => "00000000-0000-4000-8000-000000000001",
      free: [], options: {},
    })).toThrow("unique");
  });
});
