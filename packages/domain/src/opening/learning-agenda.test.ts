import { describe, expect, it } from "vitest";
import { assembleLearningAgenda } from "./learning-agenda";
const courseId = "10000000-0000-4000-8000-000000000001";
describe("learning agenda", () => {
  it("keeps unobserved identity, budget and evidence unknown", () => {
    expect(assembleLearningAgenda({ courseId })).toMatchObject({ goalId: null, sessionId: null, itemVersionId: null,
      mode: "unknown", help: { delivered: false, level: "unknown" }, budget: null, decisionCurrent: null, resumable: false, suggestion: null });
  });
  it("preserves accepted choices and return points even with invalidated decisions", () => {
    const input = { courseId, status: "paused" as const, selectedAction: "create:self-example", returnTo: courseId,
      parentDecisionId: courseId, decisionCurrent: false, invalidationReasons: ["source_changed"], budget: { minutes: 20 }, userOverride: "full" };
    expect(assembleLearningAgenda(input)).toMatchObject(input);
  });
});
