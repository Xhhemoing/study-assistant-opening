import { expect, it } from "vitest";
import { tutorLearnerContextInstruction } from "./tutor-learner-context";
it("explains the specific error as fallible learning data without exposing internal identifiers", () => {
  const text = tutorLearnerContextInstruction({ courseId: "course-id", title: "线性代数", asOf: "2026-10-21T00:00:00Z", privacyEpoch: 4,
    goal: { description: "期末基础题", targetDate: "2026-10-31", weeklyMinutes: 420 },
    weaknesses: [{ skillLabel: "秩", requirementKey: "rank", samples: 2, incorrect: 1, assisted: 1 }],
    recentMistakes: [{ observationId: "observation-id", skillLabel: "秩", feedback: "行数不等于秩", unmetCriteria: ["检查线性相关性"], assistance: "hinted" }],
    observationIds: ["observation-id"], sourceRefs: [{ sourceId: "source-id", sourceVersion: 1 }] });
  expect(text).toContain("行数不等于秩");
  expect(text).toContain("2026-10-31");
  expect(text).toContain("AI批改意见可以有误");
  expect(text).not.toMatch(/observation-id|course-id|source-id|privacyEpoch/);
  expect(tutorLearnerContextInstruction(null)).toBe("");
});
