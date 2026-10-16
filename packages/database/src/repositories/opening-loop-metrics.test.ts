import type { Sql } from "postgres";
import { expect, it, vi } from "vitest";
import { readOpeningLoopMetrics } from "./opening-loop-metrics";

function readDatabase(zone = "America/Los_Angeles") {
  const query = vi.fn((strings: TemplateStringsArray) => {
    const text = strings.join("?");
    if (text.includes("FROM workspaces w")) return Promise.resolve([{ planning_settings: { timeZone: zone } }]);
    return Promise.resolve([]);
  });
  const begin = vi.fn(async (_options: string, run: (tx: Sql) => unknown) => run(query as unknown as Sql));
  return { sql: Object.assign(query, { begin }) as unknown as Sql, query, begin };
}
const scope = { workspaceId: "workspace", ownerUserId: "owner" };

it("uses a read-only repeatable snapshot and workspace calendar bounds across spring DST", async () => {
  const db = readDatabase();
  const result = await readOpeningLoopMetrics(db.sql, scope, { days: 2, now: new Date("2026-03-09T12:00:00Z") });
  expect(db.begin.mock.calls[0]?.[0]).toBe("isolation level repeatable read read only");
  expect(result).toMatchObject({ windowDays: 2, windowStart: "2026-03-08T08:00:00.000Z", windowEnd: "2026-03-09T12:00:00.000Z",
    timeZone: "America/Los_Angeles" });
  expect(db.query.mock.calls.map(([parts]) => parts.join("?")).every(sql => !/\b(UPDATE|INSERT|DELETE|FOR UPDATE)\b/.test(sql))).toBe(true);
  expect(result.groups.learning.find(m => m.id === "learning.independent_check_coverage")).toMatchObject({ value: null, dataStatus: "no_samples" });
});

it("validates bounded windows before opening a transaction", async () => {
  const db = readDatabase();
  await expect(readOpeningLoopMetrics(db.sql, scope, { days: 91 })).rejects.toThrow();
  expect(db.begin).not.toHaveBeenCalled();
});

it("refuses a missing or foreign workspace before reading other data", async () => {
  const db = readDatabase(); db.query.mockResolvedValue([]);
  await expect(readOpeningLoopMetrics(db.sql, scope)).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(db.query).toHaveBeenCalledTimes(1);
});
