import { afterEach, describe, expect, it, vi } from "vitest";
import * as domain from "@aistudy/domain";
import { createRetestCandidateHandler } from "./retest-candidate";
import { createOpeningLearningReadService } from "../../../web/src/features/opening/learning/read-service";
import { courseEvidence, courseEvidenceCases, learningObservation } from "../../../../packages/domain/src/opening/learning-summary-fixtures";

const courseId = learningObservation.courseId;
const scope = { workspaceId: learningObservation.workspaceId, ownerUserId: "user-1" };
const job = { id: "job-1", ...scope, key: "retest-1", kind: "retest", payload: {}, result: null, state: "running", privacyEpoch: 0 };
const now = () => learningObservation.occurredAt;
const payload = { courseId, promptsBySkill: { fractions: "Retest fractions from source stem" } };

afterEach(() => vi.restoreAllMocks());

describe("retest-candidate shared evidence", () => {
  it.each(courseEvidenceCases)("matches read status and all reason codes for $name", async ({ evidence, independent }) => {
    const summarize = vi.spyOn(domain, "summarizeObservations");
    const readCourseEvidence = vi.fn(async () => evidence);
    const read = createOpeningLearningReadService({ readCourseObservationHeads: async () => [], assertOwnedCourse: async () => undefined, readCourseEvidence, now });
    const expected = await read.summarizeLearning(scope, courseId);
    const saveCandidates = vi.fn(async (_scope, candidates) => candidates);
    const worker = createRetestCandidateHandler({ readCourseEvidence, listDueRetests: async () => [], saveCandidates, now });
    const actual = await worker(job, payload);
    expect(summarize.mock.results.at(-1)?.value).toEqual(expected);
    const unavailable = expected.some((summary) => summary.evidenceEligibility?.some(({ eligibility }) => eligibility.usableForCurrentVersion === "no"));
    expect(actual.candidates).toHaveLength(independent || unavailable ? 0 : 1);
    expect(readCourseEvidence).toHaveBeenLastCalledWith(scope, courseId);
  });

  it("keeps a genuinely empty course empty", async () => {
    const worker = createRetestCandidateHandler({ readCourseEvidence: async () => ({ observations: [], evidenceContexts: {} }), listDueRetests: async () => [], saveCandidates: async (_s, c) => c });
    expect((await worker(job, payload)).candidates).toEqual([]);
  });

  it("does not accept a payload source outside captured observations", async () => {
    const worker = createRetestCandidateHandler({ readCourseEvidence: async () => courseEvidence(null), listDueRetests: async () => [], saveCandidates: async (_s, c) => c });
    expect((await worker(job, { ...payload, sourceIdsBySkill: { fractions: ["foreign-source"] } })).candidates).toEqual([]);
  });

  it("does not invent a prompt", async () => {
    const worker = createRetestCandidateHandler({ readCourseEvidence: async () => courseEvidence(null), listDueRetests: async () => [], saveCandidates: async (_s, c) => c });
    expect((await worker(job, { courseId })).candidates).toEqual([]);
  });
});



it("proposes only the due requirement and persists its identity for equal labels", async () => {
  const first = courseEvidence();
  const input = first.evidenceContexts[learningObservation.id]!;
  const second = { ...learningObservation, id: "second", sourceIds: ["second-source"] };
  const evidence = { observations: [...first.observations, second], evidenceContexts: { ...first.evidenceContexts, [second.id]: { ...input, observation: { ...input.observation, requirementKey: "requirement-2" } } } };
  const worker = createRetestCandidateHandler({
    readCourseEvidence: async () => evidence,
    listDueRetests: async () => [{ courseId, skillLabel: learningObservation.skillLabel, requirementKey: input.observation.requirementKey! }],
    saveCandidates: async (_scope, candidates) => candidates,
  });
  const result = await worker(job, { ...payload, limit: 5 });
  expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0]).toMatchObject({ requirementKey: input.observation.requirementKey, sourceIds: learningObservation.sourceIds });
});

it("never proposes unavailable or excluded source references from identity-incomplete observations", async () => {
  for (const applicability of ["unavailable", "privacy_excluded"] as const) {
    const evidence = courseEvidence({ observation: {}, context: { version: { applicability } } });
    const worker = createRetestCandidateHandler({ readCourseEvidence: async () => evidence, listDueRetests: async () => [], saveCandidates: async (_scope, candidates) => candidates });
    const result = await worker(job, payload);
    expect(result.candidates).toEqual([]);
  }
});

it("attaches current observation and stable root identity to generated proposals", async () => {
  const current = { ...learningObservation, id: "88888888-8888-4888-8888-888888888888", rootObservationId: learningObservation.id, revisionKind: "replace" as const, verdictSource: "self_report" as const };
  const evidence = { observations: [current], evidenceContexts: {} };
  const saveCandidates = vi.fn(async (_scope, candidates) => candidates);
  const worker = createRetestCandidateHandler({ readCourseEvidence: async () => evidence, listDueRetests: async () => [], saveCandidates, now });
  const result = await worker(job, payload);
  expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0]).toMatchObject({ evidenceObservationIds: [current.id], evidenceRootIds: [learningObservation.id] });
  expect(saveCandidates).toHaveBeenCalledWith(scope, result.candidates, job.privacyEpoch, job.id);
  expect(domain.summarizeObservations(evidence.observations, now())[0]?.sampleCount).toBe(1);
});

it("does not read evidence or publish when retest suggestions are disabled", async () => {
  const readCourseEvidence = vi.fn(async () => courseEvidence(null));
  const saveCandidates = vi.fn(async (_scope, candidates) => candidates);
  const worker = createRetestCandidateHandler({
    readLearningPreferences: async () => ({
      assessmentEnabled: true, retestSuggestionsEnabled: false, automaticRemindersEnabled: true,
    }),
    readCourseEvidence,
    listDueRetests: async () => [],
    saveCandidates,
  });

  expect((await worker(job, payload)).candidates).toEqual([]);
  expect(readCourseEvidence).not.toHaveBeenCalled();
  expect(saveCandidates).not.toHaveBeenCalled();
});

it("assembles prompts from stem snapshots when payload omits promptsBySkill", async () => {
  const saveCandidates = vi.fn(async (_scope, candidates) => candidates);
  const worker = createRetestCandidateHandler({
    readCourseEvidence: async () => courseEvidence(null),
    listDueRetests: async () => [],
    saveCandidates,
    readStemPromptsBySkill: async () => ({ fractions: "隔天重做原题（先不看之前的答案）：1/2+1/3" }),
  });
  const result = await worker(job, { courseId });
  expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0]?.prompt).toContain("1/2+1/3");
  expect(result.candidates[0]?.prompt.startsWith("隔天重做原题")).toBe(true);
});

it("does not invent a prompt when stem lookup returns nothing", async () => {
  const worker = createRetestCandidateHandler({
    readCourseEvidence: async () => courseEvidence(null),
    listDueRetests: async () => [],
    saveCandidates: async (_s, c) => c,
    readStemPromptsBySkill: async () => ({}),
  });
  expect((await worker(job, { courseId })).candidates).toEqual([]);
});
