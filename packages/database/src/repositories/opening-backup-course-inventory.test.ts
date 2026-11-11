import { describe, expect, it, vi } from "vitest";
import type { TransactionSql } from "postgres";
import { readOpeningBackupCourseRecords } from "./opening-backup-course-records";

const workspace = "workspace", owner = "owner";
const publicRef = { sourceId: "public", sourceVersion: 1 }, privateRef = { sourceId: "private", sourceVersion: 2 };
const requirement = { id: "r1", workspace_id: workspace, owner_user_id: owner, course_id: "course", stable_skill_id: "skill",
  prerequisite_ids: ["r2"], title: "derived title", knowledge_node_id: "node", approved_at: "2026-01-01T00:00:00Z",
  source_refs: [publicRef, privateRef], verification: { kind: "rubric", status: "ready", exerciseKeys: ["private-key"], rubric: "private-rubric", missingReasons: [] } };
function fixture(requirements: Record<string, unknown>[], cards: Record<string, unknown>[] = []) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const query = vi.fn((parts: TemplateStringsArray | unknown[], ...values: unknown[]): unknown => {
    if (!Object.hasOwn(parts, "raw")) return parts;
    const sql = (parts as TemplateStringsArray).join("?").replace(/\s+/g, " ").trim();
    if (!sql.startsWith("SELECT")) return { fragment: sql, values };
    calls.push({ sql, values });
    if (sql.startsWith("SELECT * FROM course_requirements")) return Promise.resolve(requirements);
    if (sql.includes("FROM cards c")) return Promise.resolve(cards);
    if (["FROM workspace_preferences", "FROM courses WHERE", "FROM course_asset_memberships", "FROM course_goals", "FROM course_goal_links", "FROM goal_time_windows", "FROM card_review_states", "FROM learning_events"].some(part => sql.includes(part))) return Promise.resolve([]);
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  return { calls, run: (sources: string[]) => readOpeningBackupCourseRecords(query as unknown as TransactionSql, workspace, sources) };
}
const redactedVerification = { kind: "unavailable", status: "missing", exerciseKeys: [], rubric: null,
  missingReasons: ["此要求部分材料未包含在备份中，请补充可读材料并重新确认要求与验证标准。"] };

describe("backup course requirements preserve topology while excluding source-derived content", () => {
  it("returns a fully included requirement byte-equivalent without mutating input", async () => {
    const original = structuredClone(requirement), f = fixture([requirement]);
    const result = await f.run(["public", "private"]);
    expect(result.course_requirements).toEqual([original]);
    expect(requirement).toEqual(original);
  });
  it.each([
    ["first source omitted", ["private"], [privateRef]],
    ["second source omitted", ["public"], [publicRef]],
    ["both sources omitted", [], []],
  ])("redacts an entire requirement when %s while retaining only included refs", async (_name, sources, expectedRefs) => {
    const f = fixture([structuredClone(requirement)]), result = await f.run(sources);
    expect(result.course_requirements).toEqual([{ ...requirement, title: "材料不可用的课程要求", knowledge_node_id: null, approved_at: null,
      source_refs: expectedRefs, verification: redactedVerification }]);
    expect(result.course_requirements[0]).toMatchObject({ id: "r1", workspace_id: workspace, owner_user_id: owner, course_id: "course",
      stable_skill_id: "skill", prerequisite_ids: ["r2"] });
    expect(JSON.stringify(result.course_requirements)).not.toContain("private-rubric");
    expect(JSON.stringify(result.course_requirements)).not.toContain("private-key");
  });
  it("preserves the full denominator and original ordering with mixed included/excluded requirements", async () => {
    const a = { ...structuredClone(requirement), id: "a", source_refs: [publicRef] };
    const b = { ...structuredClone(requirement), id: "b", source_refs: [privateRef], prerequisite_ids: ["a"] };
    const c = { ...structuredClone(requirement), id: "c", source_refs: [] };
    const before = structuredClone([a, b, c]);
    const result = await fixture([a, b, c]).run(["public"]);
    expect(result.course_requirements.map(r => r.id)).toEqual(["a", "b", "c"]);
    expect(result.course_requirements[0]).toEqual(a); expect(result.course_requirements[2]).toEqual(c);
    expect(result.course_requirements[1]).toMatchObject({ prerequisite_ids: ["a"], source_refs: [], verification: redactedVerification });
    expect([a, b, c]).toEqual(before);
  });
  it.each([
    ["empty refs", []], ["included duplicate refs", [publicRef, publicRef]],
    ["same source with distinct pinned versions", [publicRef, { sourceId: "public", sourceVersion: 3 }]],
  ])("preserves a valid requirement with %s", async (_name, refs) => {
    const row = { ...structuredClone(requirement), source_refs: refs };
    expect((await fixture([row]).run(["public"])).course_requirements).toEqual([row]);
  });
  it("retains duplicate included refs in order while removing excluded refs", async () => {
    const row = { ...structuredClone(requirement), source_refs: [publicRef, privateRef, publicRef] };
    const result = await fixture([row]).run(["public"]);
    expect(result.course_requirements[0]).toMatchObject({ source_refs: [publicRef, publicRef], verification: redactedVerification });
    expect(row.source_refs).toEqual([publicRef, privateRef, publicRef]);
  });
  it("binds source membership inventory and requirement query to this workspace", async () => {
    const f = fixture([requirement]); await f.run(["public"]);
    const membership = f.calls.find(c => c.sql.includes("FROM course_asset_memberships"))!;
    expect(membership.sql).toMatch(/c\.workspace_id = \? WHERE m\.workspace_id = \? AND m\.asset_type = 'source' AND m\.asset_id = ANY\(\?::uuid\[\]\)/);
    expect(membership.values).toEqual([workspace, workspace, ["public"]]);
    const req = f.calls.find(c => c.sql.startsWith("SELECT * FROM course_requirements"))!;
    expect(req.sql).toMatch(/WHERE workspace_id=\? ORDER BY id/); expect(req.values).toEqual([workspace]);
  });
  it("does not query source memberships when the included inventory is empty", async () => {
    const f = fixture([requirement]); const result = await f.run([]);
    expect(result.course_asset_memberships).toEqual([]);
    expect(f.calls.some(c => c.sql.includes("FROM course_asset_memberships"))).toBe(false);
  });
  it("does not mask dependency read errors as a partial backup", async () => {
    const error = Object.assign(new Error("requirements read failed"), { code: "ECONNRESET" });
    const query = vi.fn((parts: TemplateStringsArray | unknown[]) => {
      if (!Object.hasOwn(parts, "raw")) return parts;
      const sql = (parts as TemplateStringsArray).join("?");
      if (sql.includes("FROM course_requirements")) return Promise.reject(error);
      return Promise.resolve([]);
    });
    await expect(readOpeningBackupCourseRecords(query as unknown as TransactionSql, workspace, [])).rejects.toBe(error);
  });
});
