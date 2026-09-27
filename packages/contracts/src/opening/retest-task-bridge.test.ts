import { describe, expect, it } from "vitest";
import { taskCreateInputSchema } from "./planning";

const candidateId = "11111111-1111-4111-8111-111111111111";
const sourceId = "22222222-2222-4222-8222-222222222222";

describe("retest→task bridge contract", () => {
  it("accepts a complete retest snapshot with base version and clientKey", () => {
    const parsed = taskCreateInputSchema.parse({
      title: "Retest fractions from source stem",
      minutes: 20,
      dueAt: null,
      priority: 1,
      candidateId,
      clientKey: "retest-accept-key-01",
      baseVersion: 0,
      inputSnapshot: {
        kind: "retest",
        candidateId,
        courseId: "33333333-3333-4333-8333-333333333333",
        skillLabel: "fractions",
        prompt: "Retest fractions from source stem",
        sourceIds: [sourceId],
        dueAt: "2026-09-14T10:00:00.000Z",
        heuristic: true,
      },
    });
    expect(parsed.candidateId).toBe(candidateId);
    expect(parsed.clientKey).toBe("retest-accept-key-01");
    expect(parsed.baseVersion).toBe(0);
    expect(parsed.inputSnapshot?.kind).toBe("retest");
    expect(parsed.dueAt).toBeNull();
  });

  it("still rejects dueText together with dueAt", () => {
    expect(
      taskCreateInputSchema.safeParse({
        title: "作业",
        minutes: 30,
        dueAt: "2026-09-14T18:00:00.000Z",
        dueText: "sometime soon",
        priority: 1,
        candidateId: null,
      }).success,
    ).toBe(false);
  });
});
