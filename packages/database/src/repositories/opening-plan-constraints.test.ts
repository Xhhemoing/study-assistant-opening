import { describe, expect, it } from "vitest";
import { plannedBlocksFitConstraints } from "./opening-plan-constraints";
import type { PlannedBlock, TimeBlock } from "@aistudy/contracts";

const at = (time: string) => `2026-10-21T${time}:00.000Z`;
const block: PlannedBlock = { taskId: "practice", start: at("09:00"), end: at("09:25"), reason: "Practice" };
const free: TimeBlock = { start: at("08:00"), end: at("12:00"), kind: "free" };

describe("acceptance against current planning constraints", () => {
  it("refuses a formerly free slot after a class was added in another tab", () => {
    expect(plannedBlocksFitConstraints([block], [free], true)).toBe(true);
    expect(plannedBlocksFitConstraints([block], [free, { start: at("09:10"), end: at("09:55"), kind: "class" }], true)).toBe(false);
  });
  it("checks new availability for auto drafts and preserves explicit manual windows", () => {
    const shorter = { ...free, start: at("10:00") };
    expect(plannedBlocksFitConstraints([block], [shorter], true)).toBe(false);
    expect(plannedBlocksFitConstraints([block], [shorter], false)).toBe(true);
    expect(plannedBlocksFitConstraints([block], [shorter, { ...block, kind: "meal" }], false)).toBe(false);
  });
  it("allows adjacent hard boundaries and an empty selected plan", () => {
    expect(plannedBlocksFitConstraints([block], [free, { start: block.end, end: at("10:00"), kind: "class" }], true)).toBe(true);
    expect(plannedBlocksFitConstraints([], [], true)).toBe(true);
  });
});
