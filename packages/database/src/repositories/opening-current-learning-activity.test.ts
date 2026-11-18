import { expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { readOpeningCurrentLearningActivity, readOpeningCurrentLearningRecovery, readOpeningTaskTeachingBinding } from "./opening-current-learning-activity";
const scope = { workspaceId: "workspace", ownerUserId: "owner" };
const row = (id: string, extra = {}) => ({ id, course_id: "course", status: "active", updated_at: "2026-11-01T00:00:00Z", content_version: 1, intent_kind: "topic", create_intent: {}, ...extra });
function db(...results: unknown[][]) {
  return vi.fn((strings: TemplateStringsArray) => strings.join("").trimStart().startsWith("SELECT")
    ? Promise.resolve(results.shift() ?? []) : {}) as unknown as Sql;
}
function queries(sql: Sql): string[] {
  return (sql as unknown as ReturnType<typeof vi.fn>).mock.calls
    .map(call => (call[0] as TemplateStringsArray).join(" "));
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
  const sql = db([{ id: "task", activity_id: "old", course_id: "course", status: "active", create_intent: {} }], [row("old"), row("new", { updated_at: "2026-11-02T00:00:00Z" })]);
  expect(await readOpeningCurrentLearningActivity(sql, scope, "course", { taskId: "task" })).toMatchObject({ activityId: "old" });
});
it("does not treat a missing persisted onboarding target as an unbound task", async () => {
  const sql = db([{ id: "task", activity_id: null, origin: "manual", client_key: "first-learning-activity:missing" }], [row("latest")]);
  expect(await readOpeningCurrentLearningActivity(sql, scope, "course", { taskId: "task" })).toBeNull();
});
it.each(["branch", "cycle", "multiple-live", "foreign-parent", "skipped"])("rejects malformed continuation lineage %s", async kind => {
  const root = { activity_id: "root", course_id: "course", status: "completed", activity_client_key: "task:task", create_intent: { source: "task", taskId: "task" } };
  const child = { activity_id: "child", course_id: "course", status: "active", activity_client_key: "task:task:next:root", create_intent: { source: "task", taskId: "task", continuesActivityId: "root" } };
  const rows = kind === "branch" ? [root, child, { ...child, activity_id: "other" }]
    : kind === "cycle" ? [{ ...root, create_intent: { ...root.create_intent, continuesActivityId: "child" } }, child]
    : kind === "multiple-live" ? [{ ...root, status: "active" }, child]
    : kind === "foreign-parent" ? [root, { ...child, create_intent: { ...child.create_intent, continuesActivityId: "foreign" } }]
    : [root, { ...child, status: "skipped" }];
  expect((await readOpeningTaskTeachingBinding(db(rows), scope, "course", "task")).kind).toBe("unavailable");
});
it("rejects content-zero legacy placeholders but preserves static lesson sessions", async () => {
  const shell = row("shell", { intent_kind: "course_continue", content_version: 0 });
  expect(await readOpeningCurrentLearningActivity(db([shell]), scope, "course")).toBeNull();
  const span = { ...shell, id: "span", create_intent: { protocol: "span-lesson-v1" }, session_id: "session" };
  expect(await readOpeningCurrentLearningActivity(db([span]), scope, "course")).toMatchObject({ activityId: "span", sessionId: "session" });
  expect(await readOpeningCurrentLearningActivity(db([{ ...span, session_id: null }]), scope, "course")).toBeNull();
});
it("prefers live recovery candidates and falls back only to decision-bearing activities", async () => {
  const selectCount = (sql: Sql) => queries(sql).filter(query => query.trimStart().startsWith("SELECT")).length;
  const liveSql = db([row("live")]);
  expect(await readOpeningCurrentLearningRecovery(liveSql, scope)).toEqual({ activityId: "live", courseId: "course", sessionId: null });
  expect(selectCount(liveSql)).toBe(1);
  expect(queries(liveSql).some(query => query.includes("'proposed','accepted','in_progress'") && query.includes("rt.status NOT IN ('done','skipped')"))).toBe(true);
  const fallbackSql = db([], [row("decided")]);
  expect(await readOpeningCurrentLearningRecovery(fallbackSql, scope)).toEqual({ activityId: "decided", courseId: "course", sessionId: null });
  expect(selectCount(fallbackSql)).toBe(2);
  expect(queries(fallbackSql).some(query => query.includes("a.create_intent->>'protocol'='span-lesson-v1' OR a.goal_json ? 'courseRoute'")
    && query.includes("opening_learning_decisions"))).toBe(true);
  expect(await readOpeningCurrentLearningRecovery(db([], []), scope)).toBeNull();
});
it("excludes card-session keys, cardReviewSession checkpoints, and legacy-course-continue keys in SQL candidates and sorts fractional timestamps", async () => {
  const whole = row("ffffffff-ffff-4fff-8fff-ffffffffffff", { updated_at: "2026-11-17T10:00:00Z" });
  const fractional = row("11111111-1111-4111-8111-111111111111", { updated_at: "2026-11-17T10:00:00.500Z" });
  const currentSql = db([whole, fractional]);
  expect(await readOpeningCurrentLearningActivity(currentSql, scope, "course")).toEqual({
    activityId: fractional.id, courseId: "course", sessionId: null,
  });
  const recoverySql = db([whole, fractional]);
  expect(await readOpeningCurrentLearningRecovery(recoverySql, scope)).toEqual({
    activityId: fractional.id, courseId: "course", sessionId: null,
  });
  for (const sql of [currentSql, recoverySql]) {
    const query = queries(sql).find(item => item.includes("FROM opening_teaching_activities a"));
    expect(query).toContain("a.client_key NOT LIKE 'card-session:%'");
    expect(query).toContain("NOT (COALESCE(a.checkpoint_json,'{}'::jsonb) ? 'cardReviewSession')");
    expect(query).toContain("a.client_key NOT LIKE 'legacy-course-continue:%'");
  }
});
