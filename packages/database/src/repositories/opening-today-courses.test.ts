import { describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { readOpeningTodayCourses } from "./opening-today-courses";
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
});
