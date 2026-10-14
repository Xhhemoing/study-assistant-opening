import { describe, it, expect, vi } from "vitest";
import { runPlanningAgent } from "./planning-agent";
const id = "11111111-1111-4111-8111-111111111111";
function setup(actions: unknown[], courseBound = false) {
  const complete = vi.fn(async () => ({ text: JSON.stringify(actions.shift()), citedChunkIds: [], candidates: [], requestId: null, inputTokens: 20, outputTokens: 30 }));
  const propose = vi.fn(async () => ({ id: "draft" }));
  const args = { text: "优先复习", context: { tasks: [{ id }] }, pendingTaskIds: [id], courseBound,
    guard: vi.fn(async () => {}), read: vi.fn(async () => ({ safe: true })), complete, propose };
  return args;
}
const schedule = { kind: "read", tool: "schedule" };
const propose = { kind: "propose", taskIds: [id], explanation: "先做到期复习，时间由排程器安排。" };
describe("bounded planning agent", () => {
  it("reads state and proposes only; stable step indices are supplied for billing", async () => {
    const args = setup([schedule, propose]);
    const result = await runPlanningAgent(args);
    expect(result.modelCalls).toBe(2); expect(result.proposal).toEqual({ id: "draft" });
    expect(args.propose).toHaveBeenCalledOnce(); expect(args.complete.mock.calls.map(c => c[1])).toEqual([0, 1]);
  });
  it("requires course evidence before proposing a bound-course plan", async () => {
    const args = setup([schedule, propose], true);
    await expect(runPlanningAgent(args)).rejects.toThrow("学习证据"); expect(args.propose).not.toHaveBeenCalled();
  });
  it("finishes within four paid steps including optional memory", async () => {
    const args = setup([schedule, { kind: "read", tool: "learning" }, { kind: "read", tool: "memory" }, propose], true);
    expect((await runPlanningAgent(args)).modelCalls).toBe(4);
  });
  it.each([
    { kind: "read", tool: "deleteTask" },
    { ...propose, taskIds: ["22222222-2222-4222-8222-222222222222"] },
    { ...propose, taskIds: [id, id] },
    { ...propose, ownerUserId: id },
    { ...propose, accept: true },
    { kind: "execute", sql: "DELETE FROM opening_tasks" },
  ])("rejects unknown tools, foreign IDs, duplicates and model authority: %j", async action => {
    const args = setup([schedule, action]);
    await expect(runPlanningAgent(args)).rejects.toThrow(); expect(args.propose).not.toHaveBeenCalled();
  });
  it("does not repair arbitrary prose into an executable action", async () => {
    const args = setup([]); args.complete.mockResolvedValue({ text: 'Here is a plan: {"kind":"propose"}', citedChunkIds: [], candidates: [], requestId: null, inputTokens: 20, outputTokens: 30 });
    await expect(runPlanningAgent(args)).rejects.toThrow(); expect(args.propose).not.toHaveBeenCalled();
  });
  it("stops a repeated read rather than looping/billing forever", async () => {
    const args = setup([schedule, schedule]);
    await expect(runPlanningAgent(args)).rejects.toThrow("重复"); expect(args.complete).toHaveBeenCalledTimes(2);
  });
  it("allows an honest missing-input result without writing", async () => {
    const args = setup([{ kind: "finish", message: "请先确定一个任务。" }]);
    expect((await runPlanningAgent(args)).proposal).toBeNull(); expect(args.propose).not.toHaveBeenCalled();
  });
  it("blocks a changed privacy epoch before tool or draft execution", async () => {
    const args = setup([schedule]); args.guard.mockRejectedValueOnce(new Error("epoch changed"));
    await expect(runPlanningAgent(args)).rejects.toThrow("epoch changed"); expect(args.complete).not.toHaveBeenCalled();
  });
  it("an already-aborted run performs no provider calls", async () => {
    const args = setup([schedule]);
    await expect(runPlanningAgent({ ...args, signal: AbortSignal.abort() })).rejects.toThrow(); expect(args.complete).not.toHaveBeenCalled();
  });
  it("bounds serialized tool context before another paid call", async () => {
    const args = setup([schedule, propose]); args.read.mockResolvedValue({ safe: true, text: "x".repeat(30000) } as never);
    await expect(runPlanningAgent(args)).rejects.toThrow("上限"); expect(args.complete).toHaveBeenCalledTimes(1);
  });
});
