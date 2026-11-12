import { describe, expect, it } from "vitest";
import { validateBackupStudy } from "./backup-study";

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;
const id = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { workspace_id: id(1), owner_user_id: id(2) };
const activity = id(3), attempt = id(4), item = id(5), course = id(6), source = id(7), chunk = id(8), block = id(9);
function fixture(): Tables {
  return {
    opening_teaching_activities: [{ ...scope, id: activity, course_id: course }],
    opening_learning_attempts: [{ ...scope, id: attempt, course_id: course, activity_id: activity, item_version_id: item }],
    opening_learning_item_versions: [{ ...scope, id: item, course_id: course }],
    opening_sources: [{ ...scope, id: source, version: 2 }],
    opening_source_versions: [{ source_id: source, version: 1 }],
    opening_source_chunks: [{ id: chunk, source_id: source, source_version: 1, page: 3 }],
    opening_teaching_activity_specs: [{ activity_id: activity, version: 1, block_order: [{ blockId: block }] }],
    opening_help_exposures: [{ ...scope, course_id: course, release_key: null, context_anchor: { purpose: "learning_help" } }],
  };
}
const anchor = (t: Tables) => t.opening_help_exposures![0]!.context_anchor as Row;
function errors(t: Tables) { const e: string[] = []; validateBackupStudy(t, e); return e; }
function assertErrors(t: Tables, expected: string[]) { const before = structuredClone(t); expect(errors(t)).toEqual(expected); expect(t).toEqual(before); }

describe("batch2 anchor single-veto repair controls; no collateral schema/relationship error", () => {
  it.each([
    { key: "activityId", value: activity, table: "opening_teaching_activities", label: "activity" },
    { key: "attemptId", value: attempt, table: "opening_learning_attempts", label: "attempt" },
    { key: "itemVersionId", value: item, table: "opening_learning_item_versions", label: "item" },
  ].flatMap(target => ["missing", "workspace_id", "owner_user_id", "course_id"].map(field => ({ ...target, field }))))(
    "isolated $label $field guard repairs cleanly", ({ key, value, table, label, field }) => {
      const t = fixture(); anchor(t)[key] = value; anchor(t).courseId = course;
      assertErrors(t, []);
      const record = structuredClone(t[table]![0]!);
      if (field === "missing") t[table] = []; else t[table]![0]![field] = id(20);
      assertErrors(t, [`Study anchor ${label} scope or identity mismatch`]);
      t[table] = [record]; assertErrors(t, []);
    });
  it("row-course mismatch is isolated from reference-object course validation", () => {
    const t = fixture(); anchor(t).courseId = id(20); assertErrors(t, ["Study anchor course mismatch"]);
    anchor(t).courseId = course; assertErrors(t, []);
  });
  it.each(["activity", "item"] as const)("attempt-to-%s mismatch keeps both anchor references individually valid", kind => {
    const t = fixture(); anchor(t).attemptId = attempt;
    anchor(t)[kind === "activity" ? "activityId" : "itemVersionId"] = kind === "activity" ? activity : item;
    const field = kind === "activity" ? "activity_id" : "item_version_id";
    assertErrors(t, []); t.opening_learning_attempts![0]![field] = id(20);
    assertErrors(t, ["Study anchor attempt relationships mismatch"]);
    t.opening_learning_attempts![0]![field] = kind === "activity" ? activity : item; assertErrors(t, []);
  });
  it("source existence guard alone fails without a chunk or version to provide another veto", () => {
    const t = fixture(); anchor(t).sourceId = source; assertErrors(t, []);
    const saved = t.opening_sources!; t.opening_sources = [];
    assertErrors(t, ["Study anchor source version is missing"]);
    t.opening_sources = saved; assertErrors(t, []);
  });
  it("historical version guard alone fails, with owned source and no chunk drift", () => {
    const t = fixture(); anchor(t).sourceId = source; anchor(t).sourceVersion = 1; assertErrors(t, []);
    t.opening_source_versions = []; assertErrors(t, ["Study anchor source version is missing"]);
    anchor(t).sourceVersion = 2; assertErrors(t, []);
  });
  it.each(["missing", "source", "version", "page"] as const)("chunk %s guard is the only invalid relationship", kind => {
    const t = fixture(); Object.assign(anchor(t), { sourceId: source, sourceVersion: 1, chunkId: chunk, page: 3 });
    assertErrors(t, []);
    const old = structuredClone(t.opening_source_chunks!);
    if (kind === "missing") t.opening_source_chunks = [];
    if (kind === "source") t.opening_source_chunks![0]!.source_id = id(20);
    if (kind === "version") t.opening_source_chunks![0]!.source_version = 2;
    if (kind === "page") t.opening_source_chunks![0]!.page = 4;
    assertErrors(t, ["Study anchor chunk relationships mismatch"]);
    t.opening_source_chunks = old; assertErrors(t, []);
  });
  it.each(["activity", "version", "block", "array"] as const)("publication %s guard alone fails with activity identity still owned", kind => {
    const t = fixture(); Object.assign(anchor(t), { activityId: activity, blockId: block, contentVersion: 1 });
    assertErrors(t, []); const old = structuredClone(t.opening_teaching_activity_specs!);
    const spec = t.opening_teaching_activity_specs![0]!;
    if (kind === "activity") spec.activity_id = id(20);
    if (kind === "version") spec.version = 2;
    if (kind === "block") spec.block_order = [{ blockId: id(20) }];
    if (kind === "array") spec.block_order = null;
    assertErrors(t, ["Study anchor block version is missing"]);
    t.opening_teaching_activity_specs = old; assertErrors(t, []);
  });
});
