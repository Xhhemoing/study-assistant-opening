import { describe, expect, it } from "vitest";
import { EXAM_SOURCE_ITEMS, EXAM_WEEK_PLAN } from "./source-catalog";

describe("Math I source inventory", () => {
  it("accounts for the main numbered items without counting answers or subparts again", () => {
    expect(EXAM_SOURCE_ITEMS).toHaveLength(235);
    expect(new Set(EXAM_SOURCE_ITEMS.map((item) => item.id)).size).toBe(235);
    expect([1, 2, 3, 4, 5].map((topic) =>
      EXAM_SOURCE_ITEMS.filter((item) => item.topicId === `topic-${topic}`).length,
    )).toEqual([30, 50, 50, 58, 47]);
    expect(["choice", "problem", "exercise"].map((kind) =>
      EXAM_SOURCE_ITEMS.filter((item) => item.kind === kind).length,
    )).toEqual([100, 50, 85]);

    for (let topic = 1; topic <= 5; topic += 1) {
      for (const [kind, count] of [["q", 20], ["p", 10]] as const) {
        for (let number = 1; number <= count; number += 1) {
          expect(EXAM_SOURCE_ITEMS.some((item) => item.id === `t${topic}-${kind}-${number}`)).toBe(true);
        }
      }
    }
  });

  it("keeps the original application numbering and distinct exercise sections", () => {
    const applications = EXAM_SOURCE_ITEMS.filter((item) => item.id.startsWith("t4-e-application-"));
    expect(applications.map((item) => item.id)).toEqual([
      "t4-e-application-1", "t4-e-application-2", "t4-e-application-3", "t4-e-application-4",
      "t4-e-application-5", "t4-e-application-7", "t4-e-application-8", "t4-e-application-9",
    ]);
    expect(EXAM_SOURCE_ITEMS.find((item) => item.id === "t4-e-primitive-1")?.sourcePage).toBe(30);
    expect(EXAM_SOURCE_ITEMS.find((item) => item.id === "t4-e-application-1")?.sourcePage).toBe(61);
    expect(EXAM_SOURCE_ITEMS.find((item) => item.id === "t5-e-numerical-1")?.sourcePage).toBe(30);
    expect(EXAM_SOURCE_ITEMS.find((item) => item.id === "t5-e-functional-1")?.sourcePage).toBe(65);
  });

  it("uses physical PDF page locations, not slide footers or answer pages", () => {
    const byId = new Map(EXAM_SOURCE_ITEMS.map((item) => [item.id, item]));
    expect(byId.get("t2-e-1")?.sourcePage).toBe(53); // Footer says 36 / 45.
    expect(byId.get("t3-e-1")?.sourcePage).toBe(49); // Footer says 35 / 41.
    expect(byId.get("t5-q-20")?.sourcePage).toBe(4);
    expect(byId.get("t5-e-functional-8")?.sourcePage).toBe(67);
    for (const item of EXAM_SOURCE_ITEMS) {
      expect(Number.isInteger(item.sourcePage) && item.sourcePage! > 0).toBe(true);
      if (item.kind === "problem") expect(item.sourcePage).toBe(1);
      if (item.kind === "choice") expect(item.sourcePage).toBeLessThanOrEqual(4);
      expect(item.skills).toEqual([]);
    }
  });

  it("preserves the 42-hour budget and early interleaving while reserving mock-exam days", () => {
    expect(EXAM_WEEK_PLAN.map((day) => day.day)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(EXAM_WEEK_PLAN.map((day) => day.minutes)).toEqual([360, 360, 360, 390, 390, 360, 300]);
    expect(EXAM_WEEK_PLAN.reduce((total, day) => total + day.minutes, 0)).toBe(42 * 60);
    expect(EXAM_SOURCE_ITEMS.find((item) => item.id === "t4-p-1")?.suggestedDay).toBe(1);
    expect(EXAM_SOURCE_ITEMS.find((item) => item.id === "t5-e-functional-1")?.suggestedDay).toBe(1);
    expect(EXAM_SOURCE_ITEMS.every((item) => item.suggestedDay >= 1 && item.suggestedDay <= 5)).toBe(true);
  });
});
