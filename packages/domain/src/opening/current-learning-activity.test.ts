import { expect, it } from "vitest";
import { selectCurrentLearningActivity, compareCurrentLearningActivities } from "./current-learning-activity";
const row = (id: string, overrides = {}) => ({ id, courseId: "course", status: "active", updatedAt: "2026-11-01T00:00:00Z", placeholder: false, ...overrides });
it("uses descending timestamp then descending id without mutating its inputs", () => {
  const rows = [row("a"), row("c"), row("b")];
  expect(selectCurrentLearningActivity(rows, "course")?.id).toBe("c");
  expect(rows.map(r => r.id)).toEqual(["a", "c", "b"]);
  expect(compareCurrentLearningActivities(row("a"), row("z", { updatedAt: "2026-10-31T00:00:00Z" }))).toBeLessThan(0);
});
it("selects an explicit older active identity, never a conflicting, missing, closed or placeholder reference", () => {
  const rows = [row("old"), row("new", { updatedAt: "2026-11-02T00:00:00Z" }), row("closed", { status: "completed" }), row("shell", { placeholder: true })];
  expect(selectCurrentLearningActivity(rows, "course", ["old", "old"])?.id).toBe("old");
  for (const refs of [["old", "new"], ["missing"], ["closed"], ["shell"]]) expect(selectCurrentLearningActivity(rows, "course", refs)).toBeNull();
});
it("never falls back across courses or to completed/skipped placeholders", () => {
  expect(selectCurrentLearningActivity([row("foreign", { courseId: "other" }), row("done", { status: "completed" }), row("skip", { status: "skipped" }), row("shell", { placeholder: true })], "course")).toBeNull();
  expect(selectCurrentLearningActivity([row("paused", { status: "paused" })], "course")?.id).toBe("paused");
});
