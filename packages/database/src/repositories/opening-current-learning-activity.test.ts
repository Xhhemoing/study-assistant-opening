import { expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { readOpeningCurrentLearningActivity } from "./opening-current-learning-activity";
const scope = { workspaceId: "workspace", ownerUserId: "owner" };
const row = (id: string, extra = {}) => ({ id, course_id: "course", status: "active", updated_at: "2026-11-01T00:00:00Z", content_version: 1, intent_kind: "topic", create_intent: {}, ...extra });
function db(...results: unknown[][]) {
  return vi.fn((strings: TemplateStringsArray) => strings.join("").trimStart().startsWith("SELECT")
    ? Promise.resolve(results.shift() ?? []) : {}) as unknown as Sql;
}
it("selects descending ids and returns identity only", async () => {
  const sql = db([row("a"), row("z")]);
  expect(await readOpeningCurrentLearningActivity(sql, scope, "course")).toEqual({ activityId: "z", courseId: "course", sessionId: null });
});
it("rejects missing session/task references without querying latest", async () => {
  for (const reference of [{ sessionId: "missing" }, { taskId: "missing" }]) {
    const sql = db([]);
    expect(await readOpeningCurrentLearningActivity(sql, scope, "course", reference)).toBeNull();
    expect(sql).toHaveBeenCalledTimes(1);
  }
});
it("rejects ambiguous persisted task bindings without substituting latest", async () => {
  const sql = db([{ id: "task", activity_id: "a" }, { id: "task", activity_id: "b" }]);
  expect(await readOpeningCurrentLearningActivity(sql, scope, "course", { taskId: "task" })).toBeNull();
  expect(sql).toHaveBeenCalledTimes(1);
});
it("falls back within the course only when a valid task has no persisted activity binding", async () => {
  const sql = db([{ id: "task", activity_id: null }], [row("current")]);
  expect(await readOpeningCurrentLearningActivity(sql, scope, "course", { taskId: "task" })).toMatchObject({ activityId: "current" });
});
it("requires agreement between explicit activity and persisted session", async () => {
  const sql = db([{ activity_id: "b" }], [row("a"), row("b", { session_id: "session" })]);
  expect(await readOpeningCurrentLearningActivity(sql, scope, "course", { activityId: "a", sessionId: "session" })).toBeNull();
});
it("uses the older persisted task target rather than a newer candidate", async () => {
  const sql = db([{ id: "task", activity_id: "old" }], [row("old"), row("new", { updated_at: "2026-11-02T00:00:00Z" })]);
  expect(await readOpeningCurrentLearningActivity(sql, scope, "course", { taskId: "task" })).toMatchObject({ activityId: "old" });
});
it("does not treat a missing persisted onboarding target as an unbound task", async () => {
  const sql = db([{ id: "task", activity_id: null, origin: "manual", client_key: "first-learning-activity:missing" }], [row("latest")]);
  expect(await readOpeningCurrentLearningActivity(sql, scope, "course", { taskId: "task" })).toBeNull();
});
it("rejects content-zero legacy placeholders but preserves static lesson sessions", async () => {
  const shell = row("shell", { intent_kind: "course_continue", content_version: 0 });
  expect(await readOpeningCurrentLearningActivity(db([shell]), scope, "course")).toBeNull();
  const span = { ...shell, id: "span", create_intent: { protocol: "span-lesson-v1" }, session_id: "session" };
  expect(await readOpeningCurrentLearningActivity(db([span]), scope, "course")).toMatchObject({ activityId: "span", sessionId: "session" });
  expect(await readOpeningCurrentLearningActivity(db([{ ...span, session_id: null }]), scope, "course")).toBeNull();
});
