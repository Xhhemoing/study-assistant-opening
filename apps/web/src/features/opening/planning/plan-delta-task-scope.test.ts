import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { planDraftSchema, type TaskItem } from "@aistudy/contracts";
import { createOpeningPlanService } from "./plan-service";

const io = vi.hoisted(() => ({ tasks: vi.fn(), state: vi.fn(), settings: vi.fn(), hard: vi.fn(), propose: vi.fn(), local: vi.fn() }));
vi.mock("@aistudy/database", async original => ({ ...await original<typeof import("@aistudy/database")>(),
  createOpeningPlansRepository: () => ({ listTasks: io.tasks, getToday: io.state, upsertHardBlocks: io.hard, proposePlan: io.propose }),
  createOpeningPlanningSettingsRepository: () => ({ get: io.settings }), proposeOpeningLocalPlan: io.local }));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { workspaceId: id(1), ownerUserId: id(2) }, date = "2026-11-11", sql = {} as Sql;
const free = [{ start: `${date}T10:00:00.000Z`, end: `${date}T11:00:00.000Z`, kind: "free" as const }];
const request = { date, taskIds: [id(4), id(3)], clientKey: "delta-request-key", free };
const task = (n: number, priority: number): TaskItem => ({ id: id(n), title: `Task ${n}`, minutes: 30, dueAt: null, priority, status: "pending" });
beforeEach(() => {
  vi.resetAllMocks(); io.tasks.mockResolvedValue([task(3, 90), task(4, 0), task(5, 100)]); io.state.mockResolvedValue(null);
  io.settings.mockResolvedValue({ settings: { timeZone: "UTC" }, saved: false, invalidStoredSettings: false }); io.hard.mockResolvedValue(undefined);
  io.propose.mockImplementation(async (_scope, input) => planDraftSchema.parse({ id: id(8), date: input.date, version: 0, baseVersion: 0, status: "draft",
    blocks: input.blocks, unscheduledTaskIds: input.unscheduledTaskIds, unscheduled: input.unscheduledReasons }));
});
const service = () => createOpeningPlanService(sql, { now: () => new Date(`${date}T09:00:00.000Z`) });

describe("unaccepted delta plan: requested tasks only, request order and write boundary", () => {
  it("plans exactly the requested subset in requested order despite higher-ranked unrelated and earlier-returned tasks", async () => {
    const result = await service().proposeDeltaPlan(scope, request);
    expect(result.blocks.map(block => ({ taskId: block.taskId, start: block.start, end: block.end }))).toEqual([
      { taskId: id(4), start: `${date}T10:00:00.000Z`, end: `${date}T10:30:00.000Z` },
      { taskId: id(3), start: `${date}T10:30:00.000Z`, end: `${date}T11:00:00.000Z` },
    ]);
    expect(result.unscheduledTaskIds).toEqual([]);
    expect(io.propose).toHaveBeenCalledExactlyOnceWith(scope, expect.objectContaining({ date, tasks: [task(3, 90), task(4, 0)], free,
      clientKey: request.clientKey, blocks: result.blocks, unscheduledTaskIds: [] }));
    expect(io.hard).toHaveBeenCalledExactlyOnceWith(scope, date, free); expect(io.local).not.toHaveBeenCalled();
  });
  it("rejects a mixed known/unknown task selection before reading settings or writing hard blocks/draft", async () => {
    await expect(service().proposeDeltaPlan(scope, { ...request, taskIds: [id(3), id(99)] })).rejects.toMatchObject({ code: "VALIDATION", message: "delta taskIds did not match any owned tasks" });
    expect(io.state).not.toHaveBeenCalled(); expect(io.settings).not.toHaveBeenCalled(); expect(io.hard).not.toHaveBeenCalled(); expect(io.propose).not.toHaveBeenCalled(); expect(io.local).not.toHaveBeenCalled();
  });
  it("allows duplicate requested IDs without inventing duplicate tasks or falsely reporting missing ownership", async () => {
    const result = await service().proposeDeltaPlan(scope, { ...request, taskIds: [id(4), id(4)] });
    expect(result.blocks.map(block => block.taskId)).toEqual([id(4)]);
    expect(io.propose.mock.calls[0]![1].tasks).toEqual([task(4, 0)]);
  });
  it("never creates a draft if preparing hard blocks fails, preserving the exact error", async () => {
    const error = new Error("hard blocks unavailable"); io.hard.mockRejectedValueOnce(error);
    await expect(service().proposeDeltaPlan(scope, request)).rejects.toBe(error);
    expect(io.hard).toHaveBeenCalledOnce(); expect(io.propose).not.toHaveBeenCalled(); expect(io.local).not.toHaveBeenCalled();
  });
});
