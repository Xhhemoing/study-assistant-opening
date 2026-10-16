import { describe, expect, it } from "vitest";
import type { PlannedBlock, TaskItem, TimeBlock } from "@aistudy/contracts";
import { buildLocalReplan } from "./local-replan";
import { shouldOfferReplan } from "./replan-trigger";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = (clock: string) => `2026-10-16T${clock}:00.000Z`;
const task = (n: number, extra: Partial<TaskItem> = {}): TaskItem => ({ id: id(n), version: 1, title: `任务${n}`, minutes: 30, status: "pending", dueAt: null, priority: 0, ...extra });
const block = (n: number, start: string, end: string): PlannedBlock => ({ taskId: id(n), start: at(start), end: at(end), reason: "已确认" });
const constraints: TimeBlock[] = [{ start: at("08:00"), end: at("18:00"), kind: "free" }];
const now = new Date(at("10:00"));
const build = (acceptedBlocks: PlannedBlock[], tasks: TaskItem[], preserveAll = false) => buildLocalReplan({ acceptedBlocks, tasks, constraints, now, preserveAll,
  options: { localDate: "2026-10-16", timeZone: "UTC", planningNow: at("10:01") } });
describe("local replanning", () => {
  it("preserves missed history and unaffected future work while filling unused space", () => {
    const baseline = [block(1, "09:00", "09:30"), block(2, "11:00", "11:30")];
    const result = build(baseline, [task(1), task(2), task(3)]);
    expect(result.fixedBlocks).toEqual(baseline);
    expect(result.blocks).toEqual(expect.arrayContaining(baseline));
    expect(result.blocks.filter(b => b.taskId === id(1))).toHaveLength(2);
    expect(result.blocks.filter(b => b.taskId === id(2))).toHaveLength(1);
    expect(shouldOfferReplan({ acceptedBlocks: result.blocks, tasks: [task(1), task(2), task(3)], now })).toEqual({ offer: false, taskIds: [], reason: null });
  });
  it("releases only future closed or deferred work and does not re-place deferrals", () => {
    const baseline = [block(1, "09:00", "09:30"), block(2, "11:00", "11:30"), block(3, "12:00", "12:30")];
    const result = build(baseline, [task(1, { status: "done" }), task(2, { status: "skipped", version: 2 }), task(3, { notBefore: at("19:00"), version: 2 }), task(4)]);
    expect(result.fixedBlocks).toEqual([baseline[0]]);
    expect(result.releasedTaskVersions.map(t => t.id)).toEqual([id(2), id(3)]);
    expect(result.blocks.some(b => b.taskId === id(3))).toBe(false);
    expect(result.blocks.some(b => b.taskId === id(4))).toBe(true);
  });
  it("preserveAll keeps closed future blocks for explicit conversation additions", () => {
    const baseline = [block(1, "11:00", "11:30")];
    expect(build(baseline, [task(1, { status: "done" }), task(2)], true).fixedBlocks).toEqual(baseline);
  });
  it("does not invent a change when all work is already arranged or deferred", () => {
    const baseline = [block(1, "11:00", "11:30")];
    expect(build(baseline, [task(1), task(2, { notBefore: at("19:00") })]).changed).toBe(false);
  });
  it("keeps an ongoing block and excludes new blocks from it", () => {
    const baseline = [block(1, "09:45", "10:30")];
    const result = build(baseline, [task(1), task(2)]);
    expect(result.fixedBlocks).toEqual(baseline);
    expect(result.blocks.find(b => b.taskId === id(2))?.start).toBe(at("10:30"));
  });
  it("conversation addition does not reschedule a missed baseline task", () => {
    const baseline = [block(1, "09:00", "09:30")];
    const result = buildLocalReplan({ acceptedBlocks: baseline, tasks: [task(1), task(2)], constraints, now,
      preserveAll: true, candidateTaskIds: new Set([id(2)]),
      options: { localDate: "2026-10-16", timeZone: "UTC", planningNow: at("10:01") } });
    expect(result.blocks.filter(block => block.taskId === id(1))).toEqual(baseline);
    expect(result.blocks.filter(block => block.taskId === id(2))).toHaveLength(1);
  });
  it("does not move a missed task whose learning is already active", () => {
    const baseline = [block(1, "09:00", "09:30")];
    const result = buildLocalReplan({ acceptedBlocks: baseline, tasks: [task(1)], constraints, now,
      excludedTaskIds: new Set([id(1)]), options: { localDate: "2026-10-16", timeZone: "UTC", planningNow: at("10:01") } });
    expect(result.blocks).toEqual(baseline);
    expect(result.changed).toBe(false);
  });

});
