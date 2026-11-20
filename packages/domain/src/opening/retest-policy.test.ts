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

  it("never emits more than one candidate on the dated two-day heuristic", () => {
    const batch = buildRetestCandidates({
      courseId,
      summaries,
      now: "2026-09-12T10:00:00.000Z",
      sourceIdsBySkill: {
        fractions: ["77777777-7777-4777-8777-777777777777"],
        geometry: ["99999999-9999-4999-8999-999999999999"],
      },
      promptsBySkill: {
        fractions: "Retest fractions from source stem",
        geometry: "Retest geometry",
      },
    });
    expect(batch).toHaveLength(1);
    expect(batch[0]?.dueAt).toBe("2026-09-14T10:00:00.000Z");
  });

  it("skips a skill when the prompt is missing instead of inventing a stem", () => {
    const batch = buildRetestCandidates({
      courseId,
      summaries,
      now: "2026-09-12T10:00:00.000Z",
      limit: 3,
      sourceIdsBySkill: {
        fractions: ["77777777-7777-4777-8777-777777777777"],
        geometry: ["99999999-9999-4999-8999-999999999999"],
      },
      promptsBySkill: {
        geometry: "Retest geometry",
      },
    });
    expect(batch.map((c) => c.skillLabel)).toEqual(["geometry"]);
    expect(batch.some((c) => c.prompt.includes("fractions"))).toBe(false);
  });
});

describe("retention ordering", () => {
  const now = "2026-09-14T10:00:00.000Z";
  const courseId = "11111111-1111-4111-8111-111111111111";
  const sourceId = "77777777-7777-4777-8777-777777777777";
  const summary = (skillLabel: string, status: LearningSummary["status"], lastObservedAt: string | null): LearningSummary =>
    ({ skillLabel, status, lastObservedAt, evidenceIds: [], sampleCount: 1 });
  const select = (summaries: LearningSummary[], limit = 1, delayDays = 2) => buildRetestCandidates({
    courseId, summaries, now, limit, delayDays,
    sourceIdsBySkill: Object.fromEntries(summaries.map(item => [item.skillLabel, [sourceId]])),
    promptsBySkill: Object.fromEntries(summaries.map(item => [item.skillLabel, "Redo the original question."])),
  });

  it("selects the older observation within the same stability stage before applying the cap", () => {
    const recent = summary("recent", "needs_check", "2026-09-14T04:00:00.000Z");
    const older = summary("older", "needs_check", "2026-09-12T10:00:00.000Z");
    expect(select([recent, older])).toMatchObject([{ skillLabel: "older", dueAt: now }]);
  });

  it("prioritizes lower retention even when its observation is more recent", () => {
    // 36 elapsed hours / 48-hour half-life vs. 24 elapsed hours / 24-hour half-life.
    const stable = summary("stable", "needs_check", "2026-09-12T22:00:00.000Z");
    const fragile = summary("fragile", "needs_review", "2026-09-13T10:00:00.000Z");
    expect(select([stable, fragile], 2)).toMatchObject([
      { skillLabel: "fragile", dueAt: "2026-09-15T10:00:00.000Z" },
      { skillLabel: "stable", dueAt: "2026-09-14T22:00:00.000Z" },
    ]);
  });

  it("clamps missing and future observations to zero elapsed time and breaks ties by skill label", () => {
    const future = summary("future", "needs_review", "2026-09-15T10:00:00.000Z");
    const missing = summary("absent", "needs_check", null);
    const older = summary("older", "needs_check", "2026-09-13T10:00:00.000Z");
    expect(select([future, missing, older], 3, 0).map(item => item.skillLabel)).toEqual(["older", "absent", "future"]);
  });
});
