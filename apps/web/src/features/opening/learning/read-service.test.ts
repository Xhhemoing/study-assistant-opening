import { describe, expect, it, vi } from "vitest";
import type { Scope } from "@aistudy/contracts";
import { createOpeningLearningReadService } from "./read-service";
import { courseEvidence, courseEvidenceCases, learningObservation, qualifiedInput } from "../../../../../../packages/domain/src/opening/learning-summary-fixtures";
import { summarizeObservations } from "@aistudy/domain";
import { createRetestCandidateHandler } from "../../../../../worker/src/jobs/retest-candidate";

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

it("returns later independent progress with historical failures through the course service", async () => {
  const failed = { ...learningObservation, outcome: "incorrect" as const };
  const success = { ...learningObservation, id: "44444444-4444-4444-8444-444444444445", occurredAt: "2026-09-15T10:00:00.000Z" };
  const service = createOpeningLearningReadService({
    assertOwnedCourse: async () => undefined, readCourseObservationHeads: async () => [], now,
    readCourseEvidence: async () => ({ observations: [failed, success], evidenceContexts: {
      [failed.id]: { observation: { ...qualifiedInput.observation, outcome: "incorrect", submittedAt: Date.parse(failed.occurredAt) }, context: {
        ...qualifiedInput.context, referenceCheck: { ...qualifiedInput.context.referenceCheck!, outcome: "incorrect" },
      } },
      [success.id]: { ...qualifiedInput, observation: { ...qualifiedInput.observation, submittedAt: Date.parse(success.occurredAt) } },
    } }),
  });
  await expect(service.summarizeLearning(scope, courseId)).resolves.toMatchObject([{
    status: "observed_independent", evidenceIds: [failed.id, success.id],
    recentPerformance: { status: "observed_independent", evidenceIds: [success.id] }, historicalIncorrectCount: 1,
  }]);
});

it("keeps complete effective heads for domain and worker while projecting the course response", async () => {
  const observations = Array.from({ length: 201 }, (_, index) => ({
    ...learningObservation, id: `44444444-4444-4444-8444-${String(index).padStart(12, "0")}`,
  }));
  const originalId = "88888888-8888-4888-8888-888888888888";
  observations[0] = { ...observations[0]!, rootObservationId: originalId, revisesObservationId: originalId,
    revisionKind: "replace", recordedAt: "2026-09-30T12:00:00.000Z" };
  const evidence = { observations, evidenceContexts: Object.fromEntries(observations.map(row => [row.id, qualifiedInput])) };
  const before = structuredClone(evidence);
  const readCourseEvidence = vi.fn(async () => evidence);
  const service = createOpeningLearningReadService({ assertOwnedCourse: async () => undefined, readCourseObservationHeads: async () => observations, readCourseEvidence, now });
  const response = await service.summarizeLearning(scope, courseId);
  expect(readCourseEvidence).toHaveBeenCalledWith(scope, courseId);
  expect(response[0]).toMatchObject({ sampleCount: 201, historicalIncorrectCount: 0, status: "observed_independent" });
  expect(response[0]?.evidenceIds).toHaveLength(20);
  const full = summarizeObservations(evidence.observations, now(), { evidenceContexts: evidence.evidenceContexts });
  expect(full[0]?.evidenceIds).toHaveLength(201);
  expect(full[0]?.evidenceEligibility).toHaveLength(201);
  expect(full[0]?.recentPerformance?.evidenceIds).toHaveLength(201);
  expect(full[0]?.evidenceIds).not.toContain(originalId);
  const worker = createRetestCandidateHandler({
    readCourseEvidence, listDueRetests: async () => [{ courseId, skillLabel: learningObservation.skillLabel, requirementKey: "requirement-1" }],
    saveCandidates: async (_scope, candidates) => candidates, now,
  });
  const result = await worker({ id: "job-1", ...scope, key: "retest-1", kind: "retest", payload: {}, result: null, state: "running", privacyEpoch: 0 },
    { courseId, promptsBySkill: { fractions: "Retest fractions from source stem" } });
  expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0]?.evidenceObservationIds).toEqual(full[0]?.evidenceIds);
  expect(result.candidates[0]?.evidenceRootIds).toHaveLength(201);
  expect(result.candidates[0]?.evidenceRootIds).toContain(originalId);
  expect(evidence).toEqual(before);
});
