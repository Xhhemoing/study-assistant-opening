import type { TransactionSql } from "postgres";
import { describe, expect, it } from "vitest";
import { admitTaskCandidate } from "./opening-task-candidate-admission";
import { readMemoryDependencyStatus } from "./opening-memory-admission";

const scope = { workspaceId: "11111111-1111-4111-8111-111111111111", ownerUserId: "22222222-2222-4222-8222-222222222222" };
const turnId = "33333333-3333-4333-8333-333333333333";
const candidateId = "44444444-4444-4444-8444-444444444444";

function stub(ancestor: "none" | "active" | "expired" | "revoked" | "superseded") {
  const queries: string[] = [];
  const tx = ((parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.reduce((text, part, i) => text + part + (i < values.length ? String(values[i]) : ""), "")
      .replace(/\s+/g, " ").trim();
    return {
      toString: () => query,
      then(resolve: (rows: unknown[]) => unknown) {
        queries.push(query);
        if (query.startsWith("SELECT c.payload")) return resolve([{
          payload: { kind: "task", title: "Do the exercise", minutes: 15, dueText: null },
          source_turn_id: turnId, has_memory_dependencies: ancestor !== "none",
        }]);
        if (query.startsWith("SELECT t.id FROM opening_turns")) {
          return resolve(ancestor === "active" ? [{ id: turnId }] : []);
        }
        return resolve([{ id: candidateId }]);
      },
    };
  }) as unknown as TransactionSql;
  return { tx, queries };
}

describe("admitTaskCandidate", () => {
  it("keeps ordinary candidates on the non-recursive path", async () => {
    const { tx, queries } = stub("none");
    await expect(admitTaskCandidate(tx, scope, candidateId)).resolves.toBeNull();
    expect(queries.some(q => q.includes("WITH RECURSIVE"))).toBe(false);
  });

  it.each(["expired", "revoked", "superseded"] as const)("rejects stale candidates with %s memory ancestry", async ancestor => {
    const { tx, queries } = stub(ancestor);
    await expect(admitTaskCandidate(tx, scope, candidateId)).rejects.toMatchObject({ code: "VALIDATION" });
    const probe = queries.find(query => query.startsWith("SELECT t.id FROM opening_turns"));
    expect(probe).toContain("clock_timestamp()");
    expect(probe).toContain(turnId);
  });

  it("admits a candidate with usable memory ancestry", async () => {
    const { tx } = stub("active");
    await expect(admitTaskCandidate(tx, scope, candidateId)).resolves.toBe(turnId);
  });
});

function simulatedSql(read: (query: string) => unknown[]) {
  const queries: string[] = [];
  const tx = Object.assign((parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.reduce((text, part, i) => text + part + (i < values.length ? String(values[i]) : ""), "")
      .replace(/\s+/g, " ").trim();
    return { toString: () => query, then(resolve: (rows: unknown[]) => unknown) {
      queries.push(query);
      return resolve(read(query));
    } };
  }, { json: JSON.stringify }) as unknown as TransactionSql;
  return { tx, queries };
}

it("locks the course, direct and inherited materials, and memberships before validating a task candidate", async () => {
  const courseId = "55555555-5555-4555-8555-555555555555";
  const direct = "66666666-6666-4666-8666-666666666666";
  const backing = "77777777-7777-4777-8777-777777777777";
  const memoryId = "88888888-8888-4888-8888-888888888888";
  let membershipRemoved = false;
  const { tx, queries } = simulatedSql(query => {
    if (query.startsWith("SELECT id FROM workspaces")) return [{ id: scope.workspaceId }];
    if (query.startsWith("SELECT c.payload")) return [{
      payload: { kind: "task", title: "Practice", minutes: 15, dueText: null }, source_turn_id: turnId,
      has_memory_dependencies: true, course_id: courseId, source_ids: [direct], role: "assistant",
      context_source_refs: [{ memoryDependencyIds: [memoryId] }],
    }];
    if (query.startsWith("SELECT id FROM courses")) return [{ id: courseId }];
    if (query.startsWith("SELECT t.id FROM opening_turns")) return [{ id: {
      turnId, ownerUserId: scope.ownerUserId, courseId, materialUse: "citation",
      refs: [{ memoryDependencyIds: [memoryId] }], checkedAt: new Date().toISOString(),
    } }];
    if (query.startsWith("SELECT dep_m.id")) return [{ id: memoryId, course_id: courseId, source_turn_ids: [turnId], expires_at: null }];
    if (query.startsWith("SELECT m.id, course.id")) return membershipRemoved ? [] : [
      { id: memoryId, turn_course_id: courseId, refs: [], backings: [], source_ids: [backing] },
    ];
    if (query.startsWith("SELECT id FROM opening_sources")) return [{ id: direct }, { id: backing }];
    if (query.startsWith("SELECT id FROM course_asset_memberships")) {
      membershipRemoved = true;
      return [];
    }
    if (query.startsWith("SELECT c.id")) return [{ id: candidateId }];
    throw new Error(query);
  });

  await expect(admitTaskCandidate(tx, scope, candidateId)).rejects.toMatchObject({ code: "VALIDATION", message: expect.stringContaining("memory dependency") });
  const locks = queries.filter(query => query.endsWith("FOR SHARE") || query.endsWith("FOR SHARE OF conv, t"));
  expect(locks.map(query => query.split(" FROM ")[1]?.split(" ")[0])).toEqual([
    "workspaces", "opening_turns", "courses", "opening_sources", "course_asset_memberships",
  ]);
  expect(locks[3]).toContain(`${direct},${backing}`);
  expect(locks[3]).toContain("ORDER BY id FOR SHARE");
  expect(locks[4]).toContain("ORDER BY asset_id, course_id FOR SHARE");
  expect(queries.findLast(query => query.startsWith("SELECT m.id, course.id"))).toContain(`s.id = ANY(${direct},${backing}::uuid[])`);
});

it.each([false, true])("denies a memory-only task source without a backing match (result row: %s)", async hasBackingRow => {
  const sourceId = "66666666-6666-4666-8666-666666666666";
  const memoryId = "88888888-8888-4888-8888-888888888888";
  const refs = [{ sourceId, sourceVersion: 0, memoryOnly: true }, { memoryDependencyIds: [memoryId] }];
  const { tx } = simulatedSql(query => {
    if (query.startsWith("SELECT id FROM workspaces")) return [{ id: scope.workspaceId }];
    if (query.startsWith("SELECT c.payload")) return [{
      payload: { kind: "task", title: "Review", minutes: 15, dueText: null }, source_turn_id: turnId,
      has_memory_dependencies: true, course_id: null, source_ids: [sourceId], role: "assistant", context_source_refs: refs,
    }];
    if (query.startsWith("SELECT t.id FROM opening_turns")) return [{ id: {
      turnId, ownerUserId: scope.ownerUserId, courseId: null, materialUse: "citation", refs, checkedAt: new Date().toISOString(),
    } }];
    if (query.startsWith("SELECT saved.id")) return hasBackingRow ? [{ id: turnId, backings: [[]] }] : [];
    if (query.startsWith("SELECT dep_m.id")) return [{ id: memoryId, course_id: null, source_turn_ids: [], expires_at: null }];
    if (query.startsWith("SELECT id FROM opening_sources")) return [{ id: sourceId }];
    if (query.startsWith("SELECT id FROM course_asset_memberships")) return [];
    if (query.startsWith("SELECT c.id")) return [{ id: candidateId }];
    throw new Error(query);
  });
  await expect(admitTaskCandidate(tx, scope, candidateId)).rejects.toMatchObject({
    code: "VALIDATION", message: "task candidate memory dependency is no longer active",
  });
});

it.each([false, true])("keeps the preferred temporary legacy backing with reversed rows = %s", async reverse => {
  const lower = "60000000-0000-4000-8000-000000000001";
  const higher = "60000000-0000-4000-8000-000000000002";
  const parent = "60000000-0000-4000-8000-000000000003";
  const cycle = "60000000-0000-4000-8000-000000000004";
  const expiresAt = new Date(Date.now() + 60_000);
  const order = reverse ? [parent, higher, lower, cycle] : [parent, lower, higher, cycle];
  const { tx } = simulatedSql(query => {
    if (query.startsWith("SELECT dep_m.id")) return order.map(id => ({
      id, course_id: null, expires_at: id === lower ? expiresAt : null, source_turn_ids: id === higher ? [] : [turnId],
    }));
    if (query.startsWith("SELECT m.id, course.id")) return order.filter(id => id !== higher).map(id => ({
      id, turn_course_id: null, refs: id === parent ? [] : [{ memoryDependencyIds: [id === cycle ? cycle : higher] }],
      backings: id === parent ? [[lower, higher]] : [],
    }));
    throw new Error(query);
  });

  const graph = await readMemoryDependencyStatus(tx, scope, order);
  expect(graph.get(parent)?.map(node => node.dep_id)).toEqual([higher, lower, parent]);
  expect(graph.get(parent)?.find(node => node.dep_id === lower)?.expires_at).toBe(expiresAt);
  expect(graph.has(cycle)).toBe(false);
});
