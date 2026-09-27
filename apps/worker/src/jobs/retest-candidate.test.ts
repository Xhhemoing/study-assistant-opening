import { describe, expect, it, vi } from "vitest";
import type { LearningObservation } from "@aistudy/contracts";
import { createRetestCandidateHandler } from "./retest-candidate";

const courseId = "11111111-1111-4111-8111-111111111111";
const job = {
  id: "job-1",
  workspaceId: "ws-1",
  ownerUserId: "user-1",
  key: "retest-1",
  kind: "retest",
  payload: {},
  result: null,
  state: "running",
  privacyEpoch: 0,
};

function obs(over: Partial<LearningObservation> & Pick<LearningObservation, "id" | "skillLabel">): LearningObservation {
  return {
    sessionId: "22222222-2222-4222-8222-222222222222",
    courseId,
    workspaceId: "ws-1",
    sourceIds: ["77777777-7777-4777-8777-777777777777"],
    answer: "x",
    clientKey: `ck-${over.id.slice(0, 8)}xx`,
    occurredAt: "2026-09-12T10:00:00.000Z",
    sourceTurnIds: [],
    referenceSourceId: null,
    evidenceVerdict: "MASTERY_NOT_ESTABLISHED",
    problemId: null,
    retestId: null,
    assistance: "independent",
    outcome: "unverified",
    verdictSource: "self_report",
    ...over,
  };
}

describe("retest-candidate job", () => {
  it("builds a single heuristic candidate from needs_check evidence", async () => {
    const saveCandidates = vi.fn(async (_s, c) => c);
    const handler = createRetestCandidateHandler({
      listObservations: async () => [
        obs({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", skillLabel: "fractions" }),
      ],
      listDueRetestSkills: async () => [],
      saveCandidates,
      now: () => "2026-09-12T10:00:00.000Z",
    });
    const result = await handler(job, {
      courseId,
      promptsBySkill: { fractions: "Retest fractions from source stem" },
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.skillLabel).toBe("fractions");
    expect(result.candidates[0]?.prompt).toBe("Retest fractions from source stem");
    expect(result.candidates[0]?.accepted).toBe(false);
    expect(saveCandidates.mock.calls[0]?.[1][0]).toMatchObject({
      skillLabel: "fractions",
      accepted: false,
    });
  });

  it("returns empty when there is no evidence", async () => {
    const handler = createRetestCandidateHandler({
      listObservations: async () => [],
      listDueRetestSkills: async () => [],
      saveCandidates: async (_s, c) => c,
    });
    const result = await handler(job, { courseId });
    expect(result.candidates).toEqual([]);
  });

  it("does not copy a client source id that the observation does not own", async () => {
    const saveCandidates = vi.fn(async (_s, c) => c);
    const handler = createRetestCandidateHandler({
      listObservations: async () => [
        obs({
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
          skillLabel: "fractions",
          sourceIds: [],
        }),
      ],
      listDueRetestSkills: async () => [],
      saveCandidates,
      now: () => "2026-09-12T10:00:00.000Z",
    });
    const result = await handler(job, {
      courseId,
      sourceIdsBySkill: {
        fractions: ["99999999-9999-4999-8999-999999999999"],
      },
      promptsBySkill: { fractions: "Retest fractions from source stem" },
    });
    expect(result.candidates).toEqual([]);
  });

  it("skips a skill when the prompt is missing instead of inventing a stem", async () => {
    const saveCandidates = vi.fn(async (_s, c) => c);
    const handler = createRetestCandidateHandler({
      listObservations: async () => [
        obs({
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
          skillLabel: "fractions",
          sourceIds: ["77777777-7777-4777-8777-777777777777"],
        }),
      ],
      listDueRetestSkills: async () => [],
      saveCandidates,
      now: () => "2026-09-12T10:00:00.000Z",
    });
    const result = await handler(job, {
      courseId,
      sourceIdsBySkill: {
        fractions: ["77777777-7777-4777-8777-777777777777"],
      },
    });
    expect(result.candidates).toEqual([]);
    expect(saveCandidates).toHaveBeenCalledWith(expect.anything(), []);
  });
});
