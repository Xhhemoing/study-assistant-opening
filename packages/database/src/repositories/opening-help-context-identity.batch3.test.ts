import type { Sql } from "postgres";
import { expect, it, vi } from "vitest";
import { resolveOpeningStudyContext } from "./opening-study-context";
const workspace = "60000000-0000-4000-8000-000000000001", owner = "60000000-0000-4000-8000-000000000002";
const attempt = "60000000-0000-4000-8000-000000000003", session = "60000000-0000-4000-8000-000000000004";
const activity = "60000000-0000-4000-8000-000000000005", course = "60000000-0000-4000-8000-000000000006";
const foreign = "60000000-0000-4000-8000-000000000007";
const scope = { workspaceId: workspace, ownerUserId: owner };
function fixture(options: { missing?: "attempt" | "session" | "activity" | "course"; sessionActivity?: string; activityCourse?: string } = {}) {
  const calls: string[] = [];
  const query = vi.fn(async (parts: TemplateStringsArray) => {
    const sql = parts.join("?").replace(/\s+/g, " ").trim(); calls.push(sql);
    if (sql.startsWith("SELECT id FROM workspaces")) return [{ id: workspace }];
    if (sql.startsWith("SELECT * FROM opening_learning_attempts")) return options.missing === "attempt" ? [] : [{
      id: attempt, session_id: session, course_id: course, activity_id: activity, item_version_id: null, create_intent: {},
    }];
    if (sql.startsWith("SELECT * FROM opening_learning_sessions")) return options.missing === "session" ? [] : [{ course_id: course, activity_id: options.sessionActivity ?? activity }];
    if (sql.startsWith("SELECT * FROM opening_teaching_activities")) return options.missing === "activity" ? [] : [{ course_id: options.activityCourse ?? course }];
    if (sql.startsWith("SELECT id FROM courses")) return options.missing === "course" ? [] : [{ id: course }];
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  return { query: query as unknown as Sql, calls };
}
// Preset authorized records test relationship guards, not actual ownership joins.
it("resolves the server-issued attempt/session/activity/course without changing the selected input", async () => {
  const { query } = fixture(); const selection = { purpose: "learning_help" as const, attemptId: attempt };
  expect(await resolveOpeningStudyContext(query, scope, selection)).toMatchObject({ ...selection, courseId: course, activityId: activity, itemVersionId: null });
  expect(selection).toEqual({ purpose: "learning_help", attemptId: attempt });
});
it.each([
  { label: "course", patch: { courseId: foreign }, field: "courseId" },
  { label: "activity", patch: { activityId: foreign }, field: "activityId" },
  { label: "item versus null server item", patch: { itemVersionId: foreign }, field: "itemVersionId" },
])("rejects explicit foreign $label instead of silently rebinding it to attempt", async ({ patch, field }) => {
  const { query } = fixture();
  await expect(resolveOpeningStudyContext(query, scope, { purpose: "learning_help", attemptId: attempt, ...patch }))
    .rejects.toMatchObject({ code: "CONFLICT", message: `study context ${field} mismatch; reopen the selected version` });
});
it("expected attempt is a fence, not a preferred replacement for a supplied different attempt", async () => {
  const { query, calls } = fixture();
  await expect(resolveOpeningStudyContext(query, scope, { purpose: "learning_help", attemptId: attempt }, { attemptId: foreign }))
    .rejects.toMatchObject({ code: "CONFLICT", message: "study context attempt mismatch" });
  expect(calls).toHaveLength(1);
});
it("uses an expected server attempt when the client did not select one", async () => {
  const { query } = fixture();
  expect(await resolveOpeningStudyContext(query, scope, { purpose: "learning_help" }, { attemptId: attempt }))
    .toMatchObject({ attemptId: attempt, courseId: course, activityId: activity });
});
it("expected session cannot redirect a saved attempt to a different session", async () => {
  const { query, calls } = fixture();
  await expect(resolveOpeningStudyContext(query, scope, { purpose: "learning_help", attemptId: attempt }, { sessionId: foreign }))
    .rejects.toMatchObject({ code: "CONFLICT", message: "study attempt/session mismatch" });
  expect(calls).toHaveLength(2);
});
it.each(["attempt", "session", "activity", "course"] as const)("missing %s is unavailable, not a fabricated context", async missing => {
  const { query } = fixture({ missing });
  await expect(resolveOpeningStudyContext(query, scope, { purpose: "learning_help", attemptId: attempt })).rejects.toMatchObject({ code: "NOT_FOUND" });
});
it.each([
  { label: "session/activity inconsistency", options: { sessionActivity: foreign }, field: "activityId" },
  { label: "activity/course inconsistency", options: { activityCourse: foreign }, field: "courseId" },
])("$label fails before a contradictory context escapes", async ({ options, field }) => {
  const { query } = fixture(options);
  await expect(resolveOpeningStudyContext(query, scope, { purpose: "learning_help", attemptId: attempt }))
    .rejects.toMatchObject({ code: "CONFLICT", message: `study context ${field} mismatch; reopen the selected version` });
});
