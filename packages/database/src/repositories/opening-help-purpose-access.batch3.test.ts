import type { CourseSourcePurpose } from "@aistudy/contracts";
import type { Sql } from "postgres";
import { expect, it, vi } from "vitest";
import { resolveOpeningStudyContext } from "./opening-study-context";
const workspace = "70000000-0000-4000-8000-000000000001", owner = "70000000-0000-4000-8000-000000000002";
const source = "70000000-0000-4000-8000-000000000003", course = "70000000-0000-4000-8000-000000000004";
const attempt = "70000000-0000-4000-8000-000000000005", session = "70000000-0000-4000-8000-000000000006";
const activity = "70000000-0000-4000-8000-000000000007";
const scope = { workspaceId: workspace, ownerUserId: owner };
function fixture(purpose: CourseSourcePurpose | null) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const query = vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const sql = parts.join("?").replace(/\s+/g, " ").trim();calls.push({ sql, values });
    if (sql.startsWith("SELECT id FROM workspaces")) return [{ id: workspace }];
    if (sql.startsWith("SELECT * FROM opening_learning_attempts")) return [{ session_id: session, course_id: course, activity_id: activity, item_version_id: null, create_intent: {} }];
    if (sql.startsWith("SELECT * FROM opening_learning_sessions")) return [{ course_id: course, activity_id: activity, source_ids: [source] }];
    if (sql.startsWith("SELECT * FROM opening_teaching_activities")) return [{ course_id: course, source_ids: [source] }];
    if (sql.startsWith("SELECT id FROM courses")) return [{ id: course }];
    if (sql.startsWith("SELECT id,version FROM opening_sources")) return [{ id: source, version: 1 }];
    if (sql.startsWith("SELECT id FROM opening_source_chunks")) return [{ id: source }];
    if (sql.startsWith("SELECT id FROM course_asset_memberships")) return [{ id: source }];
    if (sql.startsWith("SELECT asset_id,purpose FROM course_asset_memberships")) return [{ asset_id: source, purpose }];
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  return { query: query as unknown as Sql, calls };
}
// Current membership rows are supplied doubles; tests prove the resolver's purpose
// policy remains active even after saved session/activity membership shortcuts.
it.each([
  { label: "practice-only source allowed for an actual attempt", stored: "practice", attemptBound: true, purpose: "learning_help", allowed: true },
  { label: "reference source not allowed as practice by saved session shortcut", stored: "reference", attemptBound: true, purpose: "learning_help", allowed: false },
  { label: "mock-exam source cannot be used as ordinary attempt help", stored: "mock_exam", attemptBound: true, purpose: "learning_help", allowed: false },
  { label: "practice source cannot become unbound teaching", stored: "practice", attemptBound: false, purpose: "learning_help", allowed: false },
  { label: "reference source remains legal for material citation", stored: "reference", attemptBound: false, purpose: "material_read", allowed: true },
  { label: "mock-exam still cannot become citation", stored: "mock_exam", attemptBound: false, purpose: "material_read", allowed: false },
  { label: "unclassified legacy membership keeps teaching admission", stored: null, attemptBound: false, purpose: "learning_help", allowed: true },
] as const)("$label", async ({ stored, attemptBound, purpose, allowed }) => {
  const { query, calls } = fixture(stored);
  const selection = { purpose, sourceId: source, courseId: course, ...(attemptBound ? { attemptId: attempt } : {}) };
  const promise = resolveOpeningStudyContext(query, scope, selection);
  if (allowed) expect(await promise).toMatchObject(selection);
  else await expect(promise).rejects.toMatchObject({ code: "CONFLICT", message: "study material purpose changed; reload the course materials" });
  const check = calls.find(c => c.sql.startsWith("SELECT asset_id,purpose"))!;
  expect(check.sql).toBe("SELECT asset_id,purpose FROM course_asset_memberships WHERE workspace_id=? AND course_id=? AND asset_type='source' AND asset_id=ANY(?::uuid[]) FOR SHARE");
  expect(check.values).toEqual([workspace, course, [source]]);
});
it.each(["human_read", "associationOnly"] as const)("%s does not retroactively reclassify the human/history receipt as AI teaching", async mode => {
  const { query, calls } = fixture("mock_exam");
  const expected = mode === "human_read" ? { sourceAccess: "human_read" as const } : { associationOnly: true };
  expect(await resolveOpeningStudyContext(query, scope, { purpose: "note_read", sourceId: source, courseId: course }, expected)).toMatchObject({ sourceId: source, courseId: course });
  expect(calls.some(c => c.sql.startsWith("SELECT asset_id,purpose"))).toBe(false);
});
