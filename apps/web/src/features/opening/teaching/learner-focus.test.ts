import { expect, it } from "vitest";
import { assembleLearnerSnapshot, type LearnerSnapshotSources, type SnapshotObservation } from "@aistudy/domain";
import type { LearnerSnapshotRead } from "../planning/learner-snapshot-service";
import { teachingLearnerFocus } from "./learner-focus";

const courseId = "11111111-1111-4111-8111-111111111111";
function read(correct: SnapshotObservation["verifiedCorrect"], assisted = false): LearnerSnapshotRead {
  const sources: LearnerSnapshotSources = {
    date: "2026-10-16", timeZone: "UTC", dueCardCount: 0, tasks: [],
    courses: [{ courseId, title: "Math", goal: null, hasUsableMaterials: true, evidenceStatus: "available", knowledgeNodes: [],
      summaries: [{ skillLabel: "Linear Algebra", status: correct === "yes" && !assisted ? "observed_independent" : "needs_check", lastObservedAt: "2026-10-16T08:00:00Z" }],
      observations: [{ id: "22222222-2222-4222-8222-222222222222", skillLabel: "Linear Algebra", attemptedAt: "2026-10-16T08:00:00Z",
        verifiedCorrect: correct, independentAttempt: assisted ? "no" : "yes", assistance: assisted ? "hinted" : "independent", problemId: null }],
    }],
  };
  return { sources, snapshot: assembleLearnerSnapshot(sources), autonomy: "copilot", plannerInputRevision: "r1",
    dataStatus: { evidence: "available", goals: "available", dueCards: "available" }, metrics: { reads: 4, durationMs: 1 } };
}

it.each([
  ["unknown", "diagnose"], ["no", "targeted_explain"], ["yes", "transfer_check"],
] as const)("maps %s evidence for the actual task skill to %s", (correct, activityKind) => {
  const result = teachingLearnerFocus(read(correct), courseId, " LINEAR algebra ", false);
  expect(result).toMatchObject({ skillLabel: "Linear Algebra", activityKind, strategyVersion: "adaptive-1" });
  expect(result?.focusObservationId).toBe(correct === "no" ? "22222222-2222-4222-8222-222222222222" : null);
});

it("keeps assisted success separate and honors an explicit full explanation", () => {
  expect(teachingLearnerFocus(read("yes", true), courseId, "Linear Algebra", false)?.activityKind).toBe("reduced_help_practice");
  expect(teachingLearnerFocus(read("no"), courseId, "Linear Algebra", true)).toMatchObject({ activityKind: "full_explain", focusObservationId: null });
});

it("does not borrow another course's observations or turn unavailable evidence into a diagnosis", () => {
  const value = read("no");
  expect(teachingLearnerFocus(value, "other-course", "Linear Algebra", false)).toBeNull();
  const sources = { ...value.sources, courses: value.sources.courses.map(course => ({ ...course, evidenceStatus: "unavailable" as const })) };
  expect(teachingLearnerFocus({ ...value, sources }, courseId, "Linear Algebra", false)).toBeNull();
});
