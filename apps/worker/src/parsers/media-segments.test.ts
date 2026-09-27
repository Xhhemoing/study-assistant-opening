import { describe, expect, it } from "vitest";
import { validateMediaSegments } from "./media-segments";

const segment = {
  sourceId: "11111111-1111-4111-8111-111111111111",
  sourceVersion: 1,
  startMs: 0,
  endMs: 1_000,
  text: "课程",
  frameChunkIds: [],
  quality: "needs_check" as const,
};

describe("validateMediaSegments", () => {
  it("rejects a segment outside the source duration", () => {
    expect(() => validateMediaSegments([{ ...segment, endMs: 1_001 }], 1_000)).toThrow(
      "outside source duration",
    );
  });

  it("rejects reversed or zero-length segments", () => {
    expect(() => validateMediaSegments([{ ...segment, startMs: 1_000, endMs: 1_000 }], 2_000)).toThrow(
      "endMs must be greater than startMs",
    );
  });

  it("returns a defensive copy after validating segments", () => {
    const result = validateMediaSegments([segment], 2_000);
    expect(result).toEqual([segment]);
    expect(result).not.toBe(segment);
  });
});
