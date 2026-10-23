import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";
import { readOpeningSprintBudgetConstraints } from "./opening-sprint-budget";

const scope = { workspaceId: "10000000-0000-4000-8000-000000000001", ownerUserId: "20000000-0000-4000-8000-000000000001" };
const taskId = "abcdef00-0000-4000-8000-000000000001";
const input = { windowStart: "2026-10-23T00:00:00.000Z", windowEnd: "2026-10-25T00:00:00.000Z", now: "2026-10-23T10:00:00.000Z", taskIds: [taskId] };
const block = { taskId, start: "2026-10-22T23:30:00.000Z", end: "2026-10-23T00:30:00.000Z", reason: "Accepted" };
const lock = { start_at: new Date(block.start), end_at: new Date(block.end), kind: "locked" };

// Exercises the production tagged reader and parsers, not a reimplementation of
// its filter. SQL predicate semantics are covered against PostgreSQL separately.
function transport(accepted: unknown[] = [], locked: unknown[] = []) {
  const calls: { text: string; values: unknown[] }[] = [];
  const query = vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const text = parts.join("?").replace(/\s+/g, " ").trim();
    calls.push({ text, values });
    if (!text.startsWith("SELECT ") || /\b(INSERT|UPDATE|DELETE|FOR|BEGIN|COMMIT)\b/.test(text)) {
      throw new Error(`not a plain SELECT: ${text}`);
    }
    if (text.includes("FROM opening_plan_state p")) return accepted.map(value => ({ block: value }));
    if (text.includes("FROM opening_hard_blocks h")) return locked;
    throw new Error(`unexpected query: ${text}`);
  });
  const begin = vi.fn(() => { throw new Error("repository must not open a transaction"); });
  return { sql: Object.assign(query, { begin }) as unknown as Sql, query, begin, calls };
}

describe("readOpeningSprintBudgetConstraints tagged SQL boundary", () => {
  it("parses JSON and PG timestamps, keeps absolute intervals, and binds exactly two scoped bounded SELECTs", async () => {
    const far = { ...block, taskId: taskId.toUpperCase(), start: "2026-11-21T09:00:00.000Z", end: "2026-11-21T09:30:00.000Z" };
    const t = transport([block, far], [lock]);
    const result = await readOpeningSprintBudgetConstraints(t.sql, scope, { ...input, taskIds: [taskId.toUpperCase(), taskId] });
    expect(result).toEqual({ accepted: [block, { ...far, taskId }], locked: [{ start: block.start, end: block.end, kind: "locked" }] });
    expect(result.accepted[0]).not.toBe(block);
    expect(t.query).toHaveBeenCalledTimes(2);
    expect(t.begin).not.toHaveBeenCalled();
    for (const call of t.calls) {
      expect(call.values).toEqual(expect.arrayContaining([scope.workspaceId, scope.ownerUserId, input.windowStart, input.windowEnd, 4001]));
    }
    expect(t.calls[0]!.values).toContain(input.now);
    expect(t.calls[0]!.values).toContainEqual([taskId]);
  });

  it("reads empty constraints without initialization, even with no pending task ids", async () => {
    const t = transport();
    await expect(readOpeningSprintBudgetConstraints(t.sql, scope, { ...input, taskIds: [] })).resolves.toEqual({ accepted: [], locked: [] });
    expect(t.query).toHaveBeenCalledTimes(2);
    expect(t.calls[0]!.values).toContainEqual([]);
  });

  it.each([
    { windowStart: "not-a-time" },
    { windowStart: "2026-02-30T00:00:00.000Z" },
    { windowEnd: input.windowStart },
    { windowEnd: "2026-10-22T00:00:00.000Z" },
    { now: "infinity" },
    { taskIds: ["not-a-uuid"] },
    { taskIds: Array.from({ length: 4001 }, () => taskId) },
  ])("rejects invalid input before querying: %j", async invalid => {
    const t = transport();
    await expect(readOpeningSprintBudgetConstraints(t.sql, scope, { ...input, ...invalid })).rejects.toThrow();
    expect(t.query).not.toHaveBeenCalled();
  });

  it("validates scope before querying", async () => {
    const t = transport();
    await expect(readOpeningSprintBudgetConstraints(t.sql, { ...scope, ownerUserId: "invalid" }, input)).rejects.toThrow();
    expect(t.query).not.toHaveBeenCalled();
  });

  it.each([
    null,
    [],
    JSON.stringify(block),
    { ...block, taskId: "invalid" },
    { ...block, reason: "" },
    { ...block, start: undefined },
    { ...block, start: "2026-02-30T00:00:00.000Z" },
    { ...block, end: "not-a-time" },
    { ...block, end: block.start },
    // Outside-window corrupt intervals must also fail, not be silently filtered.
    { ...block, start: "2026-10-01T10:00:00.000Z", end: "2026-10-01T09:00:00.000Z" },
  ])("rejects invalid stored accepted JSON/interval: %j", async invalid => {
    const t = transport([invalid]);
    await expect(readOpeningSprintBudgetConstraints(t.sql, scope, input)).rejects.toThrow();
  });

  it.each([
    { ...lock, start_at: null },
    { ...lock, start_at: new Date("invalid") },
    { ...lock, end_at: "infinity" },
    { ...lock, end_at: lock.start_at },
    { ...lock, end_at: "2026-10-22T22:00:00.000Z" },
    { ...lock, kind: "class" },
    { ...lock, kind: "sleep" },
    { ...lock, kind: "meal" },
  ])("rejects malformed or derived locked rows: %j", async invalid => {
    const t = transport([], [invalid]);
    await expect(readOpeningSprintBudgetConstraints(t.sql, scope, input)).rejects.toThrow();
  });

  it.each(["accepted", "locked"] as const)("fails closed above the %s limit instead of truncating", async kind => {
    const t = transport(kind === "accepted" ? Array.from({ length: 4001 }, () => block) : [],
      kind === "locked" ? Array.from({ length: 4001 }, () => lock) : []);
    await expect(readOpeningSprintBudgetConstraints(t.sql, scope, input)).rejects.toThrow(`sprint budget ${kind} constraints exceed 4000`);
  });

  it("admits the exact limit without dropping constraints", async () => {
    const t = transport(Array.from({ length: 4000 }, () => block), Array.from({ length: 4000 }, () => lock));
    const result = await readOpeningSprintBudgetConstraints(t.sql, scope, input);
    expect(result.accepted).toHaveLength(4000);
    expect(result.locked).toHaveLength(4000);
  });

  it("propagates SQL failure rather than returning an empty or partial success", async () => {
    const t = transport([block]);
    t.query.mockRejectedValueOnce(new Error("accepted read failed"));
    await expect(readOpeningSprintBudgetConstraints(t.sql, scope, input)).rejects.toThrow("accepted read failed");
    const second = transport([block]);
    second.query.mockResolvedValueOnce([{ block }]).mockRejectedValueOnce(new Error("locked read failed"));
    await expect(readOpeningSprintBudgetConstraints(second.sql, scope, input)).rejects.toThrow("locked read failed");
  });
});
