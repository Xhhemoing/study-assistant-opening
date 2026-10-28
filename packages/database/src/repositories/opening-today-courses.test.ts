import { describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { readOpeningTodayCourses } from "./opening-today-courses";
import { DEFAULT_OPENING_ADAPTIVE_PREFS } from "@aistudy/contracts";
const scope = { workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ownerUserId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
function reader(rows: Record<string, unknown>[], goals: Record<string, unknown>[] = []) {
  return vi.fn(async (strings: TemplateStringsArray) => {
    const query = strings.join("?");
    if (query.includes("LEFT JOIN courses c")) return rows;
    if (query.includes("p.adaptive_planning FROM workspaces")) return [{ adaptive_planning: null }];
    if (query.includes("FROM course_goals g")) return goals;
    throw new Error(`unexpected Today query: ${query}`);
  });
}
describe("Today course facts", () => {
  it("distinguishes a genuinely empty owned workspace from an inaccessible scope", async () => {
    await expect(readOpeningTodayCourses(reader([{ id: null }]) as unknown as Sql, scope)).resolves.toEqual([]);
    await expect(readOpeningTodayCourses(reader([]) as unknown as Sql, scope)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("retains archived course identity and the real title", async () => {
    const sql = reader([{ id: "course", title: "线性代数", archived_at: new Date("2026-10-01T00:00:00Z") }]);
    expect(await readOpeningTodayCourses(sql as unknown as Sql, scope)).toEqual([{ id: "course", title: "线性代数", archivedAt: "2026-10-01T00:00:00.000Z" }]);
    expect(sql.mock.calls[0]?.slice(1)).toEqual([scope.workspaceId, scope.ownerUserId]);
  });
  it("projects only a validated goal belonging to the returned course", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const goal = { targetDate: "2026-10-31", weeklyMinutes: 420, learningMode: "exam" };
    const prefs = { ...DEFAULT_OPENING_ADAPTIVE_PREFS, courseGoals: { [id]: goal } };
    const sql = reader([{ id, title: "线性代数", archived_at: null, adaptive_planning: prefs },
      { id: "other", title: "无目标课程", archived_at: null, adaptive_planning: prefs }]);
    expect(await readOpeningTodayCourses(sql as unknown as Sql, scope)).toEqual([
      { id, title: "线性代数", archivedAt: null, ...goal }, { id: "other", title: "无目标课程", archivedAt: null },
    ]);
    const invalid = { ...prefs, courseGoals: { [id]: { ...goal, targetDate: "2026-02-30" } } };
    expect(await readOpeningTodayCourses(reader([{ id, title: "线性代数", archived_at: null, adaptive_planning: invalid }]) as unknown as Sql, scope))
      .toEqual([{ id, title: "线性代数", archivedAt: null }]);
  });
  it("uses the selected formal goal's current values without assigning it to another course", async () => {
    const id = "11111111-1111-4111-8111-111111111111", goalId = "22222222-2222-4222-8222-222222222222";
    const prefs = { ...DEFAULT_OPENING_ADAPTIVE_PREFS, courseGoalRefs: { [id]: goalId } };
    const sql = reader([{ id, title: "线性代数", archived_at: null, adaptive_planning: prefs },
      { id: "other", title: "无目标课程", archived_at: null }], [{ id: goalId, workspace_id: scope.workspaceId, course_ids: [id],
      title: "理解向量", kind: "custom", target_date: "2026-11-30", exam_date: null, weekly_minutes: 180, priority: 1,
      learning_mode: "understand", success_criteria: "能解释", revision: 2, lifecycle: "active", maintenance_interval_days: null,
      milestones: [], created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-27T00:00:00Z" }]);
    expect(await readOpeningTodayCourses(sql as unknown as Sql, scope)).toEqual([
      { id, title: "线性代数", archivedAt: null, targetDate: "2026-11-30", weeklyMinutes: 180, learningMode: "understand" },
      { id: "other", title: "无目标课程", archivedAt: null },
    ]);
  });
});
