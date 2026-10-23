import { describe, expect, it } from "vitest";
import { finishedTodayActivity } from "./today-finished";

const course = "11111111-1111-4111-8111-111111111111";
const row = (id: string, status: "completed" | "active" | "paused" | "skipped", updatedAt: string, courseId: string | null = course) => ({ id, courseId, status, intentSummary: `节 ${id}`, updatedAt });
describe("finished lesson on Today", () => {
  const now = new Date("2026-10-23T05:30:00Z"); // 13:30 Asia/Shanghai
  it("finds the latest lesson completed today in the workspace zone", () => {
    const result = finishedTodayActivity([row("a", "completed", "2026-10-23T01:00:00Z"), row("b", "completed", "2026-10-23T05:15:00Z")], course, "Asia/Shanghai", now);
    expect(result).toEqual({ id: "b", title: "节 b", count: 2 });
  });
  it("ignores yesterday, other courses and unfinished lessons", () => {
    expect(finishedTodayActivity([
      row("y", "completed", "2026-10-22T15:00:00Z"), // 23:00 Shanghai, yesterday
      row("o", "completed", "2026-10-23T05:00:00Z", "22222222-2222-4222-8222-222222222222"),
      row("p", "paused", "2026-10-23T05:00:00Z"), row("s", "skipped", "2026-10-23T05:00:00Z"),
    ], course, "Asia/Shanghai", now)).toBeNull();
    expect(finishedTodayActivity([row("a", "completed", "2026-10-23T05:00:00Z")], null, "Asia/Shanghai", now)).toBeNull();
  });
});
