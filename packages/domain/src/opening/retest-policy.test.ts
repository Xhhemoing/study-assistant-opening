import { describe, expect, it } from "vitest";
import { buildRetestCandidates, suggestRetestAt } from "./retest-policy";
import type { LearningSummary } from "@aistudy/contracts";

describe("suggestRetestAt", () => {
  it("defaults to a two-day heuristic from occurredAt", () => {
    expect(suggestRetestAt("2026-09-12T10:00:00.000Z", 2)).toBe(
      "2026-09-14T10:00:00.000Z",
    );
  });

  it("allows an editable delayDays", () => {
    expect(suggestRetestAt("2026-09-12T10:00:00.000Z", 5)).toBe(
      "2026-09-17T10:00:00.000Z",
    );
  });
});

describe("buildRetestCandidates", () => {
  const courseId = "11111111-1111-4111-8111-111111111111";
  const summaries: LearningSummary[] = [
    {
      skillLabel: "fractions",
      status: "needs_check",
      evidenceIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1"],
      sampleCount: 1,
      lastObservedAt: "2026-09-12T10:00:00.000Z",
    },
    {
      skillLabel: "algebra",
      status: "observed_independent",
      evidenceIds: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1"],
      sampleCount: 1,
      lastObservedAt: "2026-09-12T10:00:00.000Z",
    },
    {
      skillLabel: "geometry",
      status: "needs_review",
      evidenceIds: ["cccccccc-cccc-4ccc-8ccc-ccccccccccc1"],
      sampleCount: 1,
      lastObservedAt: "2026-09-12T10:00:00.000Z",
    },
  ];

  it("emits at most a small batch (default one) for skills that need practice", () => {
    const batch = buildRetestCandidates({
      courseId,
      summaries,
      now: "2026-09-12T10:00:00.000Z",
      sourceIdsBySkill: {
        fractions: ["77777777-7777-4777-8777-777777777777"],
        algebra: ["88888888-8888-4888-8888-888888888888"],
      },
      promptsBySkill: {
        fractions: "Retest fractions from source stem",
        algebra: "Retest algebra",
      },
    });
    expect(batch).toHaveLength(1);
    expect(batch[0]?.skillLabel).toBe("fractions");
    expect(batch[0]?.accepted).toBe(false);
    expect(batch[0]?.dueAt).toBe("2026-09-14T10:00:00.000Z");
    expect(batch[0]?.sourceIds).toEqual([
      "77777777-7777-4777-8777-777777777777",
    ]);
  });

  it("skips observed_independent and skills without source refs", () => {
    const batch = buildRetestCandidates({
      courseId,
      summaries,
      now: "2026-09-12T10:00:00.000Z",
      limit: 3,
      sourceIdsBySkill: {
        geometry: ["99999999-9999-4999-8999-999999999999"],
      },
      promptsBySkill: {
        geometry: "Retest geometry",
      },
    });
    expect(batch.map((c) => c.skillLabel)).toEqual(["geometry"]);
  });
});
