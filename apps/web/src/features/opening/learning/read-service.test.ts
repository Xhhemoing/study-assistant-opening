import { describe, expect, it, vi } from "vitest";
import type { LearningObservation, Scope } from "@aistudy/contracts";
import { createOpeningLearningReadService } from "./read-service";

const scope: Scope = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  ownerUserId: "22222222-2222-4222-8222-222222222222",
};
const courseId = "33333333-3333-4333-8333-333333333333";
const NOW = "2026-09-14T10:00:00.000Z";

function observation(partial: Partial<LearningObservation> = {}): LearningObservation {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    workspaceId: scope.workspaceId,
    sessionId: "55555555-5555-4555-8555-555555555555",
    courseId,
    skillLabel: "fractions",
    sourceIds: [],
    problemId: null,
    retestId: null,
    answer: "1/2",
    outcome: "correct",
    assistance: "independent",
    clientKey: "client-key-01",
    occurredAt: NOW,
    sourceTurnIds: [],
    verdictSource: "self_report",
    referenceSourceId: null,
    evidenceVerdict: "MASTERY_NOT_ESTABLISHED",
    ...partial,
  };
}

describe("opening learning read service", () => {
  it("returns an empty known state when the owned course has no observations", async () => {
    const listObservationsForCourse = vi.fn(async () => []);
    const service = createOpeningLearningReadService({
      assertOwnedCourse: vi.fn(async () => undefined),
      listObservationsForCourse,
      now: () => NOW,
    });

    await expect(service.summarizeLearning(scope, courseId)).resolves.toEqual([]);
    expect(listObservationsForCourse).toHaveBeenCalledWith(scope, courseId);
  });

  it("404s when the course is unknown to this owner", async () => {
    const listObservationsForCourse = vi.fn();
    const service = createOpeningLearningReadService({
      assertOwnedCourse: vi.fn(async () => {
        throw Object.assign(new Error("course not found"), { code: "NOT_FOUND" });
      }),
      listObservationsForCourse,
      now: () => NOW,
    });

    await expect(service.summarizeLearning(scope, courseId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(listObservationsForCourse).not.toHaveBeenCalled();
  });

  it("keeps repository failures as errors instead of a fake summary", async () => {
    const service = createOpeningLearningReadService({
      assertOwnedCourse: vi.fn(async () => undefined),
      listObservationsForCourse: vi.fn(async () => {
        throw Object.assign(new Error("database unavailable"), { code: "UNAVAILABLE" });
      }),
      now: () => NOW,
    });

    await expect(service.summarizeLearning(scope, courseId)).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
  });

  it("summarizes real observations without inventing mastery", async () => {
    const service = createOpeningLearningReadService({
      assertOwnedCourse: vi.fn(async () => undefined),
      listObservationsForCourse: vi.fn(async () => [observation()]),
      now: () => NOW,
    });

    await expect(service.summarizeLearning(scope, courseId)).resolves.toEqual([
      {
        skillLabel: "fractions",
        status: "needs_check",
        evidenceIds: ["44444444-4444-4444-8444-444444444444"],
        evidenceSources: ["self_report"],
        sampleCount: 1,
        lastObservedAt: NOW,
      },
    ]);
  });
});
