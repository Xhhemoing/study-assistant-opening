import { describe, expect, it } from "vitest";
import { entryDestination } from "./entry-destination";

describe("default entry destination", () => {
  it.each([
    ["explore", true, "/opening/today"],
    ["learn", true, "/opening/courses"],
    ["library", true, "/opening/library"],
    [null, true, "/opening/today"],
    ["learn", false, "/learn"],
    ["explore", false, "/explore"],
    ["library", false, "/library"],
    [null, false, "/learn"],
  ] as const)("maps %s (release=%s) to %s", (value, release, expected) => {
    expect(entryDestination(value, release)).toBe(expected);
  });
  it("rejects unknown persisted values instead of building a URL", () => {
    expect(entryDestination("//evil.example", true)).toBeNull();
    expect(entryDestination("today", false)).toBeNull();
    expect(entryDestination(42, true)).toBeNull();
  });
});
