import { expect, it } from "vitest";
import { validateBackupLearningLinks } from "./backup-learning-links";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { workspace_id: id(1), owner_user_id: id(2) };
function fixture(): Record<string, Record<string, unknown>[]> {
  return { course_requirements: [{ ...scope, id: id(3), revision: 2 }, { ...scope, id: id(4), revision: 2 }],
    course_requirement_evidence_links: [{ ...scope, id: id(5), source_requirement_id: id(3), source_requirement_revision: 1,
      target_requirement_id: id(4), target_requirement_revision: 2, stable_skill_id: id(6), revision: 1, active: true }] };
}
function errors(tables: ReturnType<typeof fixture>) { const result: string[] = []; validateBackupLearningLinks(tables, result, id(2)); return result; }
it("keeps historical sharing versions without requiring current eligibility", () => expect(errors(fixture())).toEqual([]));
it.each(["owner_user_id", "target_requirement_id"])("rejects foreign or missing sharing %s", field => {
  const tables = fixture(); tables.course_requirement_evidence_links![0]![field] = id(99); expect(errors(tables)).not.toEqual([]);
});
it("rejects an impossible future requirement revision", () => {
  const tables = fixture(); tables.course_requirement_evidence_links![0]!.target_requirement_revision = 3; expect(errors(tables)).not.toEqual([]);
});
it("does not import note links without their native document inventory", () => {
  const tables = fixture(); tables.opening_learning_asset_links = [{ ...scope, id: id(8), asset_type: "document", asset_id: id(9), asset_version: null,
    course_id: null, goal_id: null, requirement_id: null, purpose: "understanding", origin_json: {}, source_refs: [], status: "active", revision: 1,
    created_at: "2026-10-27T00:00:00Z", updated_at: "2026-10-27T00:00:00Z" }];
  expect(errors(tables)).toContain("learning asset link is invalid");
});
