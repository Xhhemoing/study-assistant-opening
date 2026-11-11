import { afterEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { createCourseRouteService } from "./course-route-service";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { workspaceId: id(1), ownerUserId: id(2) }, course = id(3), activity = id(4), task = id(5);
const context = { goalId: id(6), goalRevision: 1, requirementId: id(7), requirementRevision: 1,
  stableSkillId: id(8), requirementKey: "arithmetic", action: "diagnose" };
const fail = new Error("actual storage read denied");
const stages = ["course", "activity", "requirements", "submitted-items"] as const;
afterEach(() => vi.restoreAllMocks());

function verificationSql(failureStage: typeof stages[number], ownedScope = scope) {
  const events: string[] = [];
  const tx = vi.fn((parts: TemplateStringsArray, ..._values: unknown[]): unknown => {
    const query = parts.join("?").replace(/\s+/gu, " ").trim();
    let stage: typeof stages[number];
    let rows: Record<string, unknown>[];
    if (query.startsWith("SELECT c.id FROM courses")) { stage = "course"; rows = [{ id: course }]; }
    else if (query.startsWith("SELECT content_version,goal_json")) { stage = "activity"; rows = [{ content_version: 1, goal_json: { courseRoute: context } }]; }
    else if (query.startsWith("SELECT * FROM course_requirements")) { stage = "requirements"; rows = [{ id: context.requirementId, course_id: course,
      stable_skill_id: context.stableSkillId, knowledge_node_id: null, requirement_key: context.requirementKey, title: "Arithmetic", position: 0, mandatory: true,
      goal_ids: [context.goalId], prerequisite_ids: [], source_refs: [], verification: { kind: "rubric", status: "needs_check", exerciseKeys: [], rubric: "check sum", missingReasons: [] },
      revision: 1, lifecycle: "active", origin: "confirmed", approved_at: "2026-11-10T12:00:00Z" }]; }
    else if (query.startsWith("SELECT DISTINCT v.*")) { stage = "submitted-items"; rows = []; }
    else throw new Error(`Unexpected SQL: ${query}`);
    events.push(stage);
    return stage === failureStage ? Promise.reject(fail) : Promise.resolve(rows);
  });
  const begin = vi.fn((isolation: string, callback: (tx: unknown) => unknown) => callback(tx));
  const sql = Object.assign(tx, { begin }) as unknown as Sql;
  return { tx, begin, events, run: () => createCourseRouteService(sql, {}).readVerification(ownedScope, course, activity) };
}

describe("web verification read uses owned real repository and preserves storage failures", () => {
  for (const stage of stages) it.each([
    scope, { ...scope, ownerUserId: id(20) }, { ...scope, workspaceId: id(21) },
  ])(`${stage} scoped query and error propagation: %j`, async ownedScope => {
    const f = verificationSql(stage, ownedScope);
    await expect(f.run()).rejects.toBe(fail);
    expect(f.begin).toHaveBeenCalledExactlyOnceWith("isolation level repeatable read read only", expect.any(Function));
    expect(f.events).toEqual(stages.slice(0, stages.indexOf(stage) + 1));
    const [parts, ...values] = f.tx.mock.calls.at(-1)!;
    const query = parts.join("?");
    expect(query).toMatch(/(?:\w+\.)?workspace_id=\?/);
    expect(query).toMatch(/(?:\w+\.)?owner_user_id=\?/);
    expect(values).toContain(ownedScope.workspaceId);
    expect(values).toContain(ownedScope.ownerUserId);
    expect(values).toContain(course);
    if (stage === "activity" || stage === "submitted-items") expect(values).toContain(activity);
    for (const [statement] of f.tx.mock.calls) expect(statement.join(" ")).not.toMatch(/^\s*(?:INSERT|UPDATE|DELETE)\b/i);
  });
});

describe("web task read reaches actual repository course/owner guards", () => {
  it.each([undefined, id(30)])("does not continue to retest query for missing/other-course task %j", async courseId => {
    const tx = vi.fn(async (..._args: unknown[]) => courseId ? [{ id: task, course_id: courseId }] : []);
    await expect(createCourseRouteService(tx as unknown as Sql, {}).readTask(scope, course, task)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(tx).toHaveBeenCalledExactlyOnceWith(expect.anything(), task, scope.workspaceId, scope.ownerUserId);
  });
  for (const ownedScope of [scope, { ...scope, ownerUserId: id(20) }, { ...scope, workspaceId: id(21) }]) {
    it.each(["task", "retest"])(`scope=${ownedScope.workspaceId}/${ownedScope.ownerUserId} preserves %s query failure`, async stage => {
      let calls = 0;
      const tx = vi.fn((parts: TemplateStringsArray, ..._values: unknown[]): unknown => {
        const query = parts.join("?");
        calls++;
        if (query.includes("FROM opening_tasks")) return stage === "task" ? Promise.reject(fail) : Promise.resolve([{ id: task, course_id: course }]);
        if (query.includes("FROM opening_retest_activities")) return Promise.reject(fail);
        throw new Error(`Unexpected SQL ${query}`);
      });
      await expect(createCourseRouteService(tx as unknown as Sql, {}).readTask(ownedScope, course, task)).rejects.toBe(fail);
      expect(calls).toBe(stage === "task" ? 1 : 2);
      for (const [parts, ...values] of tx.mock.calls) {
        expect(parts.join("?")).toMatch(/workspace_id=\?/);
        expect(parts.join("?")).toMatch(/owner_user_id=\?/);
        expect(values).toEqual([task, ownedScope.workspaceId, ownedScope.ownerUserId]);
      }
    });
  }
});
