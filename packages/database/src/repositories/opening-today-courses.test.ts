import { describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { readOpeningTodayCourses } from "./opening-today-courses";
import { DEFAULT_OPENING_ADAPTIVE_PREFS } from "@aistudy/contracts";
const scope = { workspaceId: "workspace", ownerUserId: "owner" };
describe("Today course facts", () => {
  it("distinguishes a genuinely empty owned workspace from an inaccessible scope", async () => {
    await expect(readOpeningTodayCourses(vi.fn(async () => [{ id: null }]) as unknown as Sql, scope)).resolves.toEqual([]);
    await expect(readOpeningTodayCourses(vi.fn(async () => []) as unknown as Sql, scope)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("retains archived course identity and the real title", async () => {
    const sql = vi.fn(async () => [{ id: "course", title: "线性代数", archived_at: new Date("2026-10-01T00:00:00Z") }]);
    expect(await readOpeningTodayCourses(sql as unknown as Sql, scope)).toEqual([{ id: "course", title: "线性代数", archivedAt: "2026-10-01T00:00:00.000Z" }]);
    expect(sql.mock.calls[0]?.slice(1)).toEqual([scope.workspaceId, scope.ownerUserId]);
  });
  it("projects only a validated goal belonging to the returned course", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const goal = { targetDate: "2026-10-31", weeklyMinutes: 420, learningMode: "exam" };
    const prefs = { ...DEFAULT_OPENING_ADAPTIVE_PREFS, courseGoals: { [id]: goal } };
    const sql = vi.fn(async () => [{ id, title: "线性代数", archived_at: null, adaptive_planning: prefs },
      { id: "other", title: "无目标课程", archived_at: null, adaptive_planning: prefs }]);
    expect(await readOpeningTodayCourses(sql as unknown as Sql, scope)).toEqual([
      { id, title: "线性代数", archivedAt: null, ...goal }, { id: "other", title: "无目标课程", archivedAt: null },
    ]);
    const invalid = { ...prefs, courseGoals: { [id]: { ...goal, targetDate: "2026-02-30" } } };
    expect(await readOpeningTodayCourses(vi.fn(async () => [{ id, title: "线性代数", archived_at: null, adaptive_planning: invalid }]) as unknown as Sql, scope))
      .toEqual([{ id, title: "线性代数", archivedAt: null }]);
  });
});
