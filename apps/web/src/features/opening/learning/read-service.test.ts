import { describe, expect, it, vi } from "vitest";
import type { Scope } from "@aistudy/contracts";
import { createOpeningLearningReadService } from "./read-service";
import { courseEvidence, courseEvidenceCases, learningObservation } from "../../../../../../packages/domain/src/opening/learning-summary-fixtures";
import { summarizeObservations } from "@aistudy/domain";

const scope: Scope = { workspaceId: learningObservation.workspaceId, ownerUserId: "22222222-2222-4222-8222-222222222222" };
const courseId = learningObservation.courseId;
const now = () => learningObservation.occurredAt;

describe("opening learning read service", () => {
  it("returns a real empty course", async () => {
    const readCourseEvidence = vi.fn(async () => ({ observations: [], evidenceContexts: {} }));
    const service = createOpeningLearningReadService({ readCourseObservationHeads: async () => [], assertOwnedCourse: async () => undefined, readCourseEvidence, now });
    await expect(service.summarizeLearning(scope, courseId)).resolves.toEqual([]);
    expect(readCourseEvidence).toHaveBeenCalledWith(scope, courseId);
  });

  it("authorizes before reading evidence", async () => {
    const readCourseEvidence = vi.fn(async () => courseEvidence());
    const service = createOpeningLearningReadService({
      readCourseObservationHeads: async () => [], assertOwnedCourse: async () => { throw Object.assign(new Error("course not found"), { code: "NOT_FOUND" }); },
      readCourseEvidence, now,
    });
    await expect(service.summarizeLearning(scope, courseId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(readCourseEvidence).not.toHaveBeenCalled();
  });

  it("propagates unavailable evidence rather than inventing a summary", async () => {
    const service = createOpeningLearningReadService({
      readCourseObservationHeads: async () => [], assertOwnedCourse: async () => undefined,
      readCourseEvidence: async () => { throw Object.assign(new Error("database unavailable"), { code: "UNAVAILABLE" }); },
      now,
    });
    await expect(service.summarizeLearning(scope, courseId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it.each(courseEvidenceCases)("returns the shared qualifications for $name", async ({ evidence }) => {
    const service = createOpeningLearningReadService({ readCourseObservationHeads: async () => [], assertOwnedCourse: async () => undefined, readCourseEvidence: async () => evidence, now });
    await expect(service.summarizeLearning(scope, courseId)).resolves.toEqual(summarizeObservations(evidence.observations, now(), { evidenceContexts: evidence.evidenceContexts }));
  });
});


it("authorizes observation history heads before reading and includes tombstones", async () => {
  const tombstone = { ...learningObservation, revisionKind: "retract" as const };
  const readCourseObservationHeads = vi.fn(async () => [tombstone]);
  const assertOwnedCourse = vi.fn(async () => undefined);
  const service = createOpeningLearningReadService({ assertOwnedCourse, readCourseObservationHeads, readCourseEvidence: async () => ({ observations: [], evidenceContexts: {} }) });
  expect(await service.listLearningObservations(scope, courseId)).toEqual([tombstone]);
  expect(assertOwnedCourse).toHaveBeenCalledWith(scope, courseId);
  expect(readCourseObservationHeads).toHaveBeenCalledWith(scope, courseId);
  expect(await service.summarizeLearning(scope, courseId)).toEqual([]);
  assertOwnedCourse.mockRejectedValueOnce(Object.assign(new Error("not found"), { code: "NOT_FOUND" }));
  await expect(service.listLearningObservations(scope, courseId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(readCourseObservationHeads).toHaveBeenCalledTimes(1);
});
