import { describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { compilerFlagMatrix } from "../../../../../../tests/fixtures/opening/teaching/compiler-flag-matrix";
import { createCourseRouteService } from "./course-route-service";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { workspaceId: id(1), ownerUserId: id(2) };
const courses = [id(3), id(4)];
const nodes = [id(5), id(6)];
const chunks = [id(7), id(8)];
const sources = [id(9), id(10)];

// No repository, flag parser, schema or domain-policy mock. This is a pure
// tagged-SQL adapter, not a Postgres integration test. Unknown queries throw.
function fixture(available: boolean, failure?: { prefix: string; error: Error }) {
  const sql = vi.fn((parts: TemplateStringsArray, ...values: unknown[]): unknown => {
    const query = parts.join("?").replace(/\s+/gu, " ").trim();
    if (failure && query.startsWith(failure.prefix)) return Promise.reject(failure.error);
    const index = courses.findIndex(course => values.includes(course));
    if (query.startsWith("g.course_id=") || query.startsWith("SELECT g.course_id")) return { query, values };
    if (query.startsWith("SELECT c.id FROM courses")) return Promise.resolve(index < 0 ? [] : [{ id: courses[index] }]);
    if (query.startsWith("SELECT * FROM course_requirements")) return Promise.resolve([]);
    if (query.startsWith("SELECT s.id,s.version,s.name")) return Promise.resolve(index < 0 ? [] : [{
      id: sources[index], version: 1, name: `material-${index}`, upload_state: "uploaded", parse_state: available ? "ready" : "pending", included: true,
    }]);
    if (query.startsWith("SELECT snapshot FROM opening_course_knowledge")) return Promise.resolve(index < 0 ? [] : [{ snapshot: {
      courseId: courses[index], version: 1, edges: [], nodes: [{ id: nodes[index], courseId: courses[index], label: `node-${index}`,
        kind: "concept", status: "supported", evidenceChunkIds: [chunks[index]] }],
    } }]);
    if (query.startsWith("SELECT ch.id,ch.source_id,ch.source_version,ch.page")) return Promise.resolve(available && index >= 0 ? [{
      id: chunks[index], source_id: sources[index], source_version: 1, page: 1,
    }] : []);
    if (["SELECT o.*,s.activity_id", "SELECT a.id,a.started_at", "WITH current_nodes AS", "SELECT l.* FROM course_requirement_evidence_links",
      "SELECT a.id,a.goal_json,a.generate_status", "WITH owned_course AS", "SELECT id,task_id,learning_protocol", "SELECT * FROM opening_teaching_activities a"]
      .some(prefix => query.startsWith(prefix))) return Promise.resolve([]);
    throw new Error(`Unexpected SQL: ${query}`);
  });
  return sql;
}

for (const available of [true, false]) {
  describe(`real web route read with sources available=${available}`, () => {
    it.each(compilerFlagMatrix)("derives actual verification state: $name", async ({ opening, legacy, enabled }) => {
      const sql = fixture(available);
      const service = createCourseRouteService(sql as unknown as Sql, {
        OPENING_TEACHING_COMPILER_ENABLED: opening, TEACHING_COMPILER_ENABLED: legacy,
      });
      const route = await service.read(scope, courses[0]!);
      expect(route.courseId).toBe(courses[0]);
      expect(route.suggestions).toHaveLength(1);
      expect(route.suggestions[0]!.verification).toMatchObject({
        kind: enabled ? "exact" : "unavailable", status: enabled && available ? "ready" : "missing", exerciseKeys: [],
      });
      if (enabled) expect(route.spanBindingOptions?.length).toBeGreaterThan(0);
      else expect(route.spanBindingOptions).toBeUndefined();
      expect(sql.mock.calls.map(([parts]) => parts.join(" ")).join(" ")).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/i);
    });
  });
}

describe("real web route read propagates downstream storage failures without partial snapshots", () => {
  it.each([
    "SELECT * FROM course_requirements", "SELECT s.id,s.version,s.name", "SELECT o.*,s.activity_id", "SELECT a.id,a.started_at",
    "SELECT l.* FROM course_requirement_evidence_links", "SELECT ch.id,ch.source_id,ch.source_version,ch.page",
    "SELECT a.id,a.goal_json,a.generate_status", "WITH owned_course AS", "SELECT id,task_id,learning_protocol",
    "SELECT * FROM opening_teaching_activities a", "SELECT snapshot FROM opening_course_knowledge",
  ])("rejects exactly the dependency failure at %s", async prefix => {
    const error = Object.assign(new Error("route dependency unavailable"), { code: "ECONNRESET" });
    const sql = fixture(true, { prefix, error });
    await expect(createCourseRouteService(sql as unknown as Sql, {}).read(scope, courses[0]!)).rejects.toBe(error);
    const [parts] = sql.mock.calls.at(-1)!;
    expect(parts.join("?").replace(/\s+/gu, " ").trim().startsWith(prefix)).toBe(true);
    for (const [statement] of sql.mock.calls) expect(statement.join(" ")).not.toMatch(/^\s*(?:INSERT|UPDATE|DELETE)\b/i);
  });
});

describe("real web route course/scope boundaries", () => {
  it.each([{}, { OPENING_TEACHING_COMPILER_ENABLED: "0" }])("does not cache another course or expose its nodes/materials: %j", async env => {
    const sql = fixture(true);
    const service = createCourseRouteService(sql as unknown as Sql, env);
    const [left, right, again] = await Promise.all([
      service.read(scope, courses[0]!), service.read(scope, courses[1]!), service.read(scope, courses[0]!),
    ]);
    for (const [route, index] of [[left, 0], [right, 1], [again, 0]] as const) {
      expect(route.suggestions.map(row => row.knowledgeNodeId)).toEqual([nodes[index]]);
      expect(route.materials.map(row => row.sourceId)).toEqual([sources[index]]);
      expect(route.suggestions[0]!.sourceRefs).toEqual([{ sourceId: sources[index], sourceVersion: 1, chunkId: chunks[index], page: 1 }]);
    }
    // These are authorization/query-boundary assertions, not SQL-format snapshots.
    for (const [parts, ...values] of sql.mock.calls) {
      const query = parts.join("?").replace(/\s+/gu, " ");
      if (query.includes("FROM course_requirements WHERE") || query.includes("SELECT snapshot FROM opening_course_knowledge")) {
        expect(query).toMatch(/workspace_id=\?/);
        expect(query).toMatch(/owner_user_id=\?/);
        expect(query).toMatch(/course_id=\?/);
        expect(values).toContain(scope.workspaceId);
        expect(values).toContain(scope.ownerUserId);
        expect(values.some(value => courses.includes(String(value)))).toBe(true);
      }
    }
  });
  it.each(["not-a-uuid", "", "../another-course"])("rejects malformed course before SQL: %j", async course => {
    const sql = fixture(true);
    const service = createCourseRouteService(sql as unknown as Sql, {});
    expect(() => service.read(scope, course)).toThrow();
    expect(sql).not.toHaveBeenCalled();
  });
  it("forwards ownership failure without attempting graph or evidence reads", async () => {
    const sql = vi.fn(async () => []);
    await expect(createCourseRouteService(sql as unknown as Sql, {}).read(scope, id(99))).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(sql).toHaveBeenCalledTimes(1);
  });
});
