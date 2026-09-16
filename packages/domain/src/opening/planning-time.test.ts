import { describe, expect, it } from "vitest";
import type { TimeBlock } from "@aistudy/contracts";
import { availableTimeSlots } from "./planning-time";

function block(start: string, end: string, kind: TimeBlock["kind"] = "free"): TimeBlock {
  return { start: `2026-09-14T${start}:00.000Z`, end: `2026-09-14T${end}:00.000Z`, kind };
}

describe("availableTimeSlots", () => {
  it("does not treat missing availability or gaps between classes as free", () => {
    expect(availableTimeSlots([])).toEqual([]);
    expect(availableTimeSlots([block("08:00", "09:00", "class"), block("12:00", "13:00", "meal")])).toEqual([]);
  });

  it("unions overlapping and adjacent availability without double booking", () => {
    expect(availableTimeSlots([
      block("10:00", "11:00"), block("09:00", "10:30"), block("11:00", "12:00"), block("09:00", "10:30"),
    ])).toEqual([block("09:00", "12:00")]);
  });

  it.each(["class", "sleep", "meal", "locked"] as const)("protects %s even when availability overlaps it", (kind) => {
    expect(availableTimeSlots([block("08:00", "12:00"), block("09:00", "10:00", kind)]))
      .toEqual([block("08:00", "09:00"), block("10:00", "12:00")]);
  });

  it("subtracts overlapping hard blocks and clips partial overlaps", () => {
    expect(availableTimeSlots([
      block("08:00", "12:00"), block("07:00", "09:00", "class"),
      block("08:30", "10:00", "locked"), block("11:00", "13:00", "meal"),
    ])).toEqual([block("10:00", "11:00")]);
  });

  it("returns no time when a hard block covers all availability", () => {
    expect(availableTimeSlots([block("08:00", "09:00"), block("07:00", "10:00", "sleep")])).toEqual([]);
  });

  it("allows touching boundaries and preserves separated slots", () => {
    expect(availableTimeSlots([
      block("08:00", "09:00"), block("09:00", "10:00", "class"), block("10:00", "11:00"),
    ])).toEqual([block("08:00", "09:00"), block("10:00", "11:00")]);
  });

  it("supports hard blocks across midnight without inventing a day boundary", () => {
    expect(availableTimeSlots([
      { start: "2026-09-14T22:00:00.000Z", end: "2026-09-15T09:00:00.000Z", kind: "free" },
      { start: "2026-09-14T23:00:00.000Z", end: "2026-09-15T08:00:00.000Z", kind: "sleep" },
    ])).toEqual([
      block("22:00", "23:00"),
      { start: "2026-09-15T08:00:00.000Z", end: "2026-09-15T09:00:00.000Z", kind: "free" },
    ]);
  });

  it.each([
    block("09:00", "09:00"), block("10:00", "09:00"),
    { ...block("09:00", "10:00"), start: "not-a-date" },
  ])("rejects invalid intervals rather than silently ignoring constraints", (invalid) => {
    expect(() => availableTimeSlots([invalid])).toThrow();
  });

  it("does not mutate caller-owned blocks", () => {
    const blocks = [block("10:00", "12:00"), block("09:00", "11:00")];
    const original = structuredClone(blocks);
    availableTimeSlots(blocks);
    expect(blocks).toEqual(original);
  });
});
