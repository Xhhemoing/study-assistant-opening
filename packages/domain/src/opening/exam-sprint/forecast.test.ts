import { describe, expect, it } from "vitest";
import type { ExamPaper } from "@aistudy/contracts";
import { forecastExamTopics } from "./forecast";

function paper(id: string, overrides: Partial<ExamPaper> = {}): ExamPaper {
  return { id, courseId: "course", sourceId: `source-${id}`, sourceVersion: 1, teacher: "Teacher A", year: 2025,
    label: id, kind: "past_exam", skills: [{ skillId: "limits", points: 10 }], recordedAt: "2026-10-17T08:00:00.000Z", ...overrides };
}

describe("historical exam topic forecast", () => {
  it("does not invent a probability from exercises, samples or an unspecified teacher", () => {
    const materials = [paper("sample", { kind: "sample" }), paper("practice", { kind: "exercise" })];
    const result = forecastExamTopics(materials, ["limits"], "Teacher A");
    expect(result).toMatchObject({ status: "no_history", papers: materials });
    expect(result.topics[0]).toEqual({ skillId: "limits", examinedPapers: 0, totalPapers: 0, probability: null, lower: null, upper: null, meanPoints: null });
    expect(forecastExamTopics([paper("true")], ["limits"], null)).toMatchObject({ status: "no_history", topics: [{ probability: null }] });
  });

  it("uses the exact Beta(2,1) quantiles for one observed appearance", () => {
    const topic = forecastExamTopics([paper("one")], ["limits"], "Teacher A").topics[0]!;
    expect(topic.probability).toBeCloseTo(2 / 3, 12);
    // Beta(2,1) CDF is x², so inverse quantiles can be checked without this implementation.
    expect(topic.lower).toBeCloseTo(Math.sqrt(0.025), 12);
    expect(topic.upper).toBeCloseTo(Math.sqrt(0.975), 12);
    expect(topic.meanPoints).toBe(10);
  });

  it("uses exact Beta(1,2) bounds for one absence and does not equate zero observations with impossibility", () => {
    const topic = forecastExamTopics([paper("one", { skills: [{ skillId: "integrals", points: 0 }] })], ["integrals"], "Teacher A").topics[0]!;
    expect(topic.probability).toBeCloseTo(1 / 3, 12);
    expect(topic.lower).toBeCloseTo(1 - Math.sqrt(0.975), 12);
    expect(topic.upper).toBeCloseTo(1 - Math.sqrt(0.025), 12);
    expect(topic.meanPoints).toBe(0);
    expect(forecastExamTopics([paper("zero", { skills: [{ skillId: "integrals", points: 0 }] })], ["integrals"], "Teacher A").topics[0]).toEqual(topic);
  });

  it("counts independent paper IDs only, filters teachers, excludes practice and averages absent skills as zero", () => {
    const original = paper("first", { skills: [{ skillId: "limits", points: 6 }] });
    const revision = paper("first", { skills: [{ skillId: "limits", points: 12 }], recordedAt: "2026-10-18T08:00:00.000Z" });
    const other = paper("second", { skills: [{ skillId: "integrals", points: 20 }, { skillId: "limits", points: 0 }] });
    const input = [original, revision, other, paper("wrong-teacher", { teacher: "Teacher B" }), paper("exercise", { kind: "exercise" })];
    const result = forecastExamTopics(input, ["limits", "limits"], "Teacher A");
    expect(result.status).toBe("limited_history");
    expect(result.papers).toHaveLength(3);
    expect(result.topics).toHaveLength(1);
    expect(result.topics[0]).toMatchObject({ examinedPapers: 1, totalPapers: 2, probability: 0.5, meanPoints: 6 });
    expect(result.topics[0]!.lower! + result.topics[0]!.upper!).toBeCloseTo(1, 12);
    result.papers[0]!.skills[0]!.points = 999;
    expect(revision.skills[0]!.points).toBe(12);
  });

  it("narrows credible intervals with repeated independent papers without reaching certainty", () => {
    const small = forecastExamTopics([paper("one")], ["limits"], "Teacher A");
    const larger = forecastExamTopics(Array.from({ length: 20 }, (_, index) => paper(String(index))), ["limits"], "Teacher A");
    expect(larger.status).toBe("history_based");
    const interval = larger.topics[0]!;
    expect(interval.upper! - interval.lower!).toBeLessThan(small.topics[0]!.upper! - small.topics[0]!.lower!);
    expect(interval.probability).toBeLessThan(1);
    // Beta(21,1) is also analytic: CDF x^21.
    expect(interval.lower).toBeCloseTo(0.025 ** (1 / 21), 11);
    expect(interval.upper).toBeCloseTo(0.975 ** (1 / 21), 11);
  });

  it("does not count a new registration ID for the same source version as a new exam", () => {
    const first = paper("first", { sourceId: "same-source", sourceVersion: 2 });
    const duplicate = paper("different-id", { sourceId: "same-source", sourceVersion: 2,
      recordedAt: "2026-10-18T08:00:00.000Z", skills: [{ skillId: "limits", points: 15 }] });
    const result = forecastExamTopics([first, duplicate], ["limits"], "Teacher A");
    expect(result.papers).toHaveLength(1);
    expect(result.papers[0]!.id).toBe("different-id");
    expect(result.topics[0]).toMatchObject({ totalPapers: 1, examinedPapers: 1, probability: 2 / 3, meanPoints: 15 });
  });

  it("keeps unreviewed skills unknown instead of treating blanks as absences", () => {
    const input = Array.from({ length: 20 }, (_, index) => paper(String(index)));
    const result = forecastExamTopics(input, ["limits", "integrals"], "Teacher A");
    expect(result.status).toBe("limited_history");
    expect(result.topics[0]).toMatchObject({ totalPapers: 20, examinedPapers: 20 });
    expect(result.topics[1]).toEqual({ skillId: "integrals", totalPapers: 0, examinedPapers: 0, probability: null, lower: null, upper: null, meanPoints: null });
    input.push(paper("checked-absence", { skills: [{ skillId: "integrals", points: 0 }] }));
    expect(forecastExamTopics(input, ["integrals"], "Teacher A").topics[0]).toMatchObject({
      totalPapers: 1, examinedPapers: 0, probability: 1 / 3, meanPoints: 0,
    });
  });
});
