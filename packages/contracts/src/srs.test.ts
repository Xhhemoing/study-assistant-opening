import { describe, expect, it } from "vitest";
import {
  reviewCardSchema,
  reviewQueueModeSchema,
  reviewStateSchema,
} from "./srs";

const UUID = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-08-15T08:00:00.000Z";

const baseCard = {
  id: UUID,
  ownerUserId: UUID,
  front: "导数的定义",
  back: "极限定义的导数",
  sourceDocumentId: null,
  syllabusPointId: null,
  tags: ["高数"],
  archived: false,
  createdAt: NOW,
};

describe("srs contracts", () => {
  it("applies ReviewCard defaults for version, pause, maintain, and assessment flag", () => {
    const parsed = reviewCardSchema.parse(baseCard);
    expect(parsed.contentVersion).toBe(1);
    expect(parsed.pausedUntil).toBeNull();
    expect(parsed.maintainUntil).toBeNull();
    expect(parsed.excludeFromAssessment).toBe(false);
  });

  it("accepts explicit control fields on ReviewCard", () => {
    const parsed = reviewCardSchema.parse({
      ...baseCard,
      contentVersion: 3,
      pausedUntil: "2026-09-01T00:00:00.000Z",
      maintainUntil: "2026-12-31",
      excludeFromAssessment: true,
    });
    expect(parsed.contentVersion).toBe(3);
    expect(parsed.pausedUntil).toBe("2026-09-01T00:00:00.000Z");
    expect(parsed.maintainUntil).toBe("2026-12-31");
    expect(parsed.excludeFromAssessment).toBe(true);
  });

  it("rejects invalid maintainUntil dates and negative contentVersion", () => {
    expect(() =>
      reviewCardSchema.parse({ ...baseCard, maintainUntil: "2026/12/31" }),
    ).toThrow();
    expect(() =>
      reviewCardSchema.parse({ ...baseCard, maintainUntil: "not-a-date" }),
    ).toThrow();
    expect(() =>
      reviewCardSchema.parse({ ...baseCard, contentVersion: 0 }),
    ).toThrow();
    expect(() =>
      reviewCardSchema.parse({ ...baseCard, pausedUntil: "2026-09-01" }),
    ).toThrow();
  });

  it("parses ReviewQueueMode values and rejects unknown modes", () => {
    expect(reviewQueueModeSchema.parse("auto")).toBe("auto");
    expect(reviewQueueModeSchema.parse("self-selected")).toBe("self-selected");
    expect(reviewQueueModeSchema.parse("free")).toBe("free");
    expect(() => reviewQueueModeSchema.parse("manual")).toThrow();
  });

  it("keeps ReviewState shape unchanged", () => {
    const parsed = reviewStateSchema.parse({
      cardId: UUID,
      ease: 2.5,
      intervalDays: 0,
      dueAt: NOW,
      reps: 0,
      lapses: 0,
      lastGrade: null,
      updatedAt: NOW,
    });
    expect(parsed.ease).toBe(2.5);
    expect(parsed).not.toHaveProperty("goalPriority");
  });
});
