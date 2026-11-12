import { describe, expect, it } from "vitest";
import type { TransactionSql } from "postgres";
import { readOpeningBackupCourseRecords } from "./opening-backup-course-records";

const workspaceId = "workspace", ownerUserId = "owner";
const includedRef = { sourceId: "included", sourceVersion: 1 };
const excludedRef = { sourceId: "excluded", sourceVersion: 2 };
const requirement = {
  id: "requirement", workspace_id: workspaceId, owner_user_id: ownerUserId,
  course_id: "course", stable_skill_id: "skill", prerequisite_ids: ["prerequisite"],
  title: "source-derived title", knowledge_node_id: "node", approved_at: "2026-01-01T00:00:00Z",
  source_refs: [includedRef, excludedRef],
  verification: { kind: "rubric", status: "ready", exerciseKeys: ["private-key"], rubric: "private-rubric", missingReasons: [] },
};
const unavailable = {
  title: "材料不可用的课程要求", knowledge_node_id: null, approved_at: null,
  verification: { kind: "unavailable", status: "missing", exerciseKeys: [], rubric: null,
    missingReasons: ["此要求部分材料未包含在备份中，请补充可读材料并重新确认要求与验证标准。"] },
};

function fixture(rows: Record<string, unknown>[], failure?: Error) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const query = (parts: TemplateStringsArray | unknown[], ...values: unknown[]): unknown => {
    if (!Object.hasOwn(parts, "raw")) return parts;
    const text = (parts as TemplateStringsArray).join("?").replace(/\s+/g, " ").trim();
    if (!text.startsWith("SELECT")) return { text, values };
    calls.push({ text, values });
    if (text.startsWith("SELECT * FROM course_requirements")) return failure ? Promise.reject(failure) : Promise.resolve(rows);
    return Promise.resolve([]);
  };
  return { calls, run: (sourceIds: string[] = ["included"]) =>
    readOpeningBackupCourseRecords(query as unknown as TransactionSql, workspaceId, sourceIds) };
}

describe("readOpeningBackupCourseRecords persisted source references", () => {
  it.each([
    { name: "null", refs: null }, { name: "undefined", refs: undefined },
    { name: "null entry", refs: [null] }, { name: "undefined entry", refs: [undefined] },
    { name: "string", refs: "included" }, { name: "number", refs: 7 },
    { name: "boolean", refs: false }, { name: "object", refs: {} },
    { name: "primitive entry", refs: ["included"] }, { name: "missing source identity", refs: [{}] },
    { name: "non-string source identity", refs: [{ sourceId: 7 }] },
    { name: "mixed known and null", refs: [includedRef, null] },
    { name: "null before known", refs: [null, includedRef] },
  ])("redacts malformed $name without aborting export or treating it as source-free", async ({ refs }) => {
    const row = { ...structuredClone(requirement), source_refs: refs };
    const before = structuredClone(row);
    const result = await fixture([row]).run();
    expect(result.course_requirements).toEqual([{ ...row, ...unavailable, source_refs: [] }]);
    expect(row).toEqual(before);
  });

  it.each([
    { name: "empty refs", refs: [] },
    { name: "included ref", refs: [includedRef] },
    { name: "duplicate and versioned refs", refs: [includedRef, includedRef, { ...includedRef, sourceVersion: 3 }] },
  ])("preserves valid $name without mutation", async ({ refs }) => {
    const row = { ...structuredClone(requirement), source_refs: refs };
    const before = structuredClone(row);
    expect((await fixture([row]).run()).course_requirements).toEqual([before]);
    expect(row).toEqual(before);
  });

  it.each([
    { sources: ["included"], refs: [includedRef, includedRef] },
    { sources: ["excluded"], refs: [excludedRef] },
    { sources: [], refs: [] },
  ])("retains only included valid refs in order for $sources", async ({ sources, refs }) => {
    const row = { ...structuredClone(requirement), source_refs: [includedRef, excludedRef, includedRef] };
    const before = structuredClone(row);
    expect((await fixture([row]).run(sources)).course_requirements).toEqual([{ ...row, ...unavailable, source_refs: refs }]);
    expect(row).toEqual(before);
  });

  it("keeps the denominator, dependency identities and ordering across malformed, valid and source-free rows", async () => {
    const rows = [
      { ...requirement, id: "bad", source_refs: [null] },
      { ...requirement, id: "valid", prerequisite_ids: ["bad"], source_refs: [includedRef] },
      { ...requirement, id: "source-free", prerequisite_ids: ["valid"], source_refs: [] },
    ];
    expect((await fixture(rows).run()).course_requirements).toEqual([
      { ...rows[0], ...unavailable, source_refs: [] }, rows[1], rows[2],
    ]);
  });

  it("keeps workspace and source inventory bindings and skips memberships for an empty inventory", async () => {
    const f = fixture([]);
    await f.run();
    const membership = f.calls.find(call => call.text.includes("FROM course_asset_memberships"));
    expect(membership?.values).toEqual([workspaceId, workspaceId, ["included"]]);
    expect(membership?.text).toContain("c.workspace_id = ? WHERE m.workspace_id = ?");
    const requirements = f.calls.find(call => call.text.startsWith("SELECT * FROM course_requirements"));
    expect(requirements?.text).toContain("WHERE workspace_id=? ORDER BY id");
    expect(requirements?.values).toEqual([workspaceId]);
    const empty = fixture([]);
    await empty.run([]);
    expect(empty.calls.some(call => call.text.includes("FROM course_asset_memberships"))).toBe(false);
  });

  it("propagates the original database failure rather than reporting an empty or successful backup", async () => {
    const error = Object.assign(new Error("requirements read failed"), { code: "ECONNRESET" });
    await expect(fixture([], error).run()).rejects.toBe(error);
  });
});
