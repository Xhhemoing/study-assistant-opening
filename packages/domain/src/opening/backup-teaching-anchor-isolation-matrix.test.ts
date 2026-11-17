import { describe, expect, it } from "vitest";
import { validateBackupStudy } from "./backup-study";
import { privacyIds as id } from "./revision-privacy.fixtures";

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;
const activity = "10000000-0000-4000-8000-000000000001";
const block = "20000000-0000-4000-8000-000000000001";
const attempt = "30000000-0000-4000-8000-000000000001";
const item = "40000000-0000-4000-8000-000000000001";
const chunk = "50000000-0000-4000-8000-000000000001";
const other = "60000000-0000-4000-8000-000000000001";
const scope = { workspace_id: id.workspace, owner_user_id: id.owner };
function fixture(): Tables {
  return {
    opening_teaching_activities: [{ ...scope, id: activity, course_id: id.root }],
    opening_learning_item_versions: [{ ...scope, id: item, course_id: id.root }],
    opening_sources: [{ ...scope, id: id.source, version: 2 }],
    opening_source_versions: [{ ...scope, source_id: id.source, version: 1 }],
    opening_source_chunks: [{ source_id: id.source, id: chunk, source_version: 1, page: 3 }],
    opening_learning_attempts: [{ ...scope, id: attempt, course_id: id.root, activity_id: activity, item_version_id: item }],
    opening_teaching_activity_specs: [{ ...scope, activity_id: activity, version: 1, block_order: [{ blockId: block }] }],
    opening_help_exposures: [{ ...scope, id: id.head, course_id: id.root, attempt_id: attempt,
      context_anchor: { courseId: id.root, activityId: activity, blockId: block, contentVersion: 1,
        attemptId: attempt, itemVersionId: item, sourceId: id.source, sourceVersion: 1, chunkId: chunk, page: 3, purpose: "learning_help" },
      release_key: null, delivered: true }],
  };
}
function errors(tables: Tables) { const result: string[] = []; validateBackupStudy(tables, result); return result; }
const anchor = (tables: Tables) => tables.opening_help_exposures![0]!.context_anchor as Row;

describe("restored historical teaching help remains bound to original context (pure preflight)", () => {
  it("retains an exact historical source version without rebasing to the current source version", () => {
    const tables = fixture(), before = structuredClone(tables);
    expect(errors(tables)).toEqual([]);
    expect(tables).toEqual(before);
    expect(anchor(tables).sourceVersion).toBe(1);
    expect(tables.opening_sources![0]!.version).toBe(2);
  });

  it.each(["opening_teaching_activities", "opening_learning_attempts", "opening_learning_item_versions"])(
    "missing historical %s is not filled from a current object", table => {
      const tables = fixture(); tables[table] = [];
      expect(errors(tables).some(error => error.includes("scope or identity mismatch"))).toBe(true);
    });

  it.each(["opening_teaching_activities", "opening_learning_attempts", "opening_learning_item_versions"].flatMap(table =>
    ["workspace_id", "owner_user_id", "course_id"].map(field => ({ table, field }))))(
    "rejects historical $table $field transplant", ({ table, field }) => {
      const tables = fixture(); tables[table]![0]![field] = other;
      const before = structuredClone(tables);
      expect(errors(tables).some(error => error.includes("scope or identity mismatch"))).toBe(true);
      expect(tables).toEqual(before);
    });

  it.each(["activity_id", "item_version_id"])("existing scoped attempt cannot silently change its %s relationship", field => {
    const tables = fixture(); tables.opening_learning_attempts![0]![field] = other;
    expect(errors(tables)).toContain("Study anchor attempt relationships mismatch");
  });

  it.each(["contentVersion", "blockId"] as const)("does not resolve old %s by a newer publication", field => {
    const tables = fixture(); anchor(tables)[field] = field === "contentVersion" ? 2 : other;
    expect(errors(tables)).toContain("Study anchor block version is missing");
  });

  it.each(["source", "version", "chunkSource", "chunkVersion", "page"] as const)("rejects historical material relationship drift: %s", kind => {
    const tables = fixture();
    if (kind === "source") tables.opening_sources = [];
    if (kind === "version") tables.opening_source_versions = [];
    if (kind === "chunkSource") tables.opening_source_chunks![0]!.source_id = id.otherSource;
    if (kind === "chunkVersion") tables.opening_source_chunks![0]!.source_version = 2;
    if (kind === "page") tables.opening_source_chunks![0]!.page = 4;
    expect(errors(tables)).toContain(kind === "source" || kind === "version" ? "Study anchor source version is missing" : "Study anchor chunk relationships mismatch");
  });

  it.each([null, undefined])("unknown legacy anchor %s stays unknown without fabricating an original context", contextAnchor => {
    const tables = fixture(); tables.opening_help_exposures![0]!.context_anchor = contextAnchor;
    const before = structuredClone(tables);
    expect(errors(tables)).toEqual([]); expect(tables).toEqual(before);
  });
});
