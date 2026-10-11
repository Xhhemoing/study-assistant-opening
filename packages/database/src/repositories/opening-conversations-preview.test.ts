import { describe, expect, it } from "vitest";
import { conversationSummarySchema } from "@aistudy/contracts";
import {
  LAST_TURN_PREVIEW_MAX,
  clipLastTurnPreview,
} from "./opening-conversations";

const summaryBase = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "t",
  courseId: null as string | null,
  updatedAt: "2026-10-11T00:00:00.000Z",
};

describe("clipLastTurnPreview", () => {
  it("returns null for nullish", () => {
    expect(clipLastTurnPreview(null)).toBeNull();
    expect(clipLastTurnPreview(undefined)).toBeNull();
  });

  it("keeps strings within max", () => {
    const s = "a".repeat(LAST_TURN_PREVIEW_MAX);
    expect(clipLastTurnPreview(s)).toBe(s);
  });

  it("clips oversize previews so conversationSummarySchema.parse succeeds", () => {
    const oversize = "预".repeat(LAST_TURN_PREVIEW_MAX + 40);
    expect(oversize.length).toBeGreaterThan(LAST_TURN_PREVIEW_MAX);
    expect(() =>
      conversationSummarySchema.parse({ ...summaryBase, lastTurnPreview: oversize }),
    ).toThrow();

    const clipped = clipLastTurnPreview(oversize);
    expect(clipped).not.toBeNull();
    expect(clipped!.length).toBe(LAST_TURN_PREVIEW_MAX);
    expect(
      conversationSummarySchema.parse({ ...summaryBase, lastTurnPreview: clipped }).lastTurnPreview,
    ).toBe(clipped);
  });

  it("clips Postgres-char LEFT residue that exceeds Zod via emoji surrogate pairs", () => {
    // Simulate PG LEFT(..., 280) by characters: 280 emoji graphemes.
    // Each 😀 is one PG char but two UTF-16 code units → JS length 560.
    const pgCharClipped = "😀".repeat(LAST_TURN_PREVIEW_MAX);
    expect([...pgCharClipped].length).toBe(LAST_TURN_PREVIEW_MAX);
    expect(pgCharClipped.length).toBe(LAST_TURN_PREVIEW_MAX * 2);
    expect(() =>
      conversationSummarySchema.parse({ ...summaryBase, lastTurnPreview: pgCharClipped }),
    ).toThrow();

    const clipped = clipLastTurnPreview(pgCharClipped);
    expect(clipped!.length).toBe(LAST_TURN_PREVIEW_MAX);
    expect(
      conversationSummarySchema.parse({ ...summaryBase, lastTurnPreview: clipped }).lastTurnPreview,
    ).toBe(clipped);
  });
});
