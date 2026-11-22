import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { loadMemoryContext } from "./opening-memory-context";
import { decideOwnedMemoryCandidate } from "./opening-memory-candidate";
import { OpeningMemoryError } from "./opening-memory-types";

const scope = {
  workspaceId: "a1000000-0000-4000-8000-000000000001",
  ownerUserId: "b2000000-0000-4000-8000-000000000001",
};
const ancestorMemoryId = "c3000000-0000-4000-8000-000000000001";
const derivedMemoryId = "c3000000-0000-4000-8000-000000000002";
const turnId = "d4000000-0000-4000-8000-000000000001";
const conversationId = "e5000000-0000-4000-8000-000000000001";

function flatten(value: unknown, values: unknown[]): string {
  if (value && typeof value === "object" && "fragment" in value) {
    const nested = value as { strings: TemplateStringsArray; values: unknown[] };
    return nested.strings.reduce((acc, part, idx) => acc + part
      + (idx < nested.strings.length - 1 ? flatten(nested.values[idx], values) : ""), "");
  }
  values.push(value);
  return "?";
}

function fakeSql(handler: (query: string) => unknown[]) {
  const queries: string[] = [];
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const fragment = { fragment: true, strings, values };
    return {
      ...fragment,
      then: (resolve: (rows: unknown[]) => void, reject: (error: unknown) => void) => {
        try {
          const flatValues: unknown[] = [];
          const query = flatten(fragment, flatValues).replace(/\s+/g, " ").trim();
          queries.push(query);
          resolve(handler(query));
        } catch (error) {
          reject(error);
        }
      },
    };
  }) as unknown as Sql & { queries: string[] };
  tx.begin = ((callback: (transaction: Sql) => unknown) => callback(tx)) as Sql["begin"];
  tx.json = ((value: unknown) => value) as Sql["json"];
  tx.unsafe = ((value: string) => ({ fragment: true, strings: [value] as unknown as TemplateStringsArray, values: [] })) as unknown as Sql["unsafe"];
  tx.queries = queries;
  return tx;
}

describe("transitive memoryDependencyIds lineage in memory context and candidate confirmation", () => {
  it("propagates earliest ancestor temporary expiry and dependencyMemoryIds and excludes once elapsed", async () => {
    const ancestorExpiresAt = "2099-01-01T00:10:00.000Z";
    const row = {
      id: derivedMemoryId,
      workspace_id: scope.workspaceId,
      course_id: null,
      kind: "confirmed",
      text: "Derived permanent memory from temporary ancestor",
      source_turn_ids: [turnId.toUpperCase()],
      version: 1,
      expires_at: null,
      status: "active",
      created_at: "2026-11-21T00:00:00.000Z",
      updated_at: "2026-11-21T00:00:00.000Z",
      material_source_refs: [{ memoryDependencyIds: [ancestorMemoryId] }],
      ancestor_temporary_expires_at: ancestorExpiresAt,
      ancestor_memory_ids: [ancestorMemoryId.toUpperCase()],
    };
    const sql = fakeSql(query => {
      if (query.includes("FROM workspaces")) return [{ id: scope.workspaceId }];
      if (query.includes("FROM opening_memories m")) return [row];
      if (query.includes("FROM opening_privacy_exclusions")) return [];
      throw new Error(`unexpected query: ${query}`);
    });

    const active = await loadMemoryContext(sql, scope, null, "2099-01-01T00:05:00.000Z");
    expect(active.memories.map(m => m.id)).toEqual([derivedMemoryId]);
    expect(active.sourceRefs).toEqual([]);
    expect(active.temporaryMemoryExpiresAt).toBe(ancestorExpiresAt);
    expect(active.dependencyMemoryIds).toEqual([ancestorMemoryId]);
    expect(sql.queries.some(q =>
      q.includes("WITH RECURSIVE mem_deps(dep_id)")
      && q.includes("dep_m.expires_at > clock_timestamp()")
      && q.includes("lower(ref.turn_id)"),
    )).toBe(true);

    // Once ancestor's temporary expiry elapses, derived permanent memory B is excluded.
    const expired = await loadMemoryContext(sql, scope, null, "2099-01-01T00:10:00.000Z");
    expect(expired).toEqual({ memories: [], sourceRefs: [] });
  });

  it("blocks confirming a derived permanent memory candidate when its ancestor temporary memory has expired or been excluded", async () => {
    const ancestorExpiresAt = "2026-11-21T00:00:00.000Z";
    const derivedRow = {
      id: derivedMemoryId,
      workspace_id: scope.workspaceId,
      course_id: null,
      kind: "confirmed",
      text: "Derived permanent candidate",
      source_turn_ids: [turnId],
      version: 1,
      expires_at: null,
      status: "active",
      created_at: "2026-11-21T00:00:00.000Z",
      updated_at: "2026-11-21T00:00:00.000Z",
      material_source_refs: [{ memoryDependencyIds: [ancestorMemoryId] }],
      ancestor_temporary_expires_at: ancestorExpiresAt,
      ancestor_memory_ids: [ancestorMemoryId],
    };
    const sql = fakeSql(query => {
      if (query.includes("FROM workspaces")) return [{ id: scope.workspaceId }];
      if (query.includes("FROM opening_assistant_candidates c")) {
        return [{
          conversation_id: conversationId,
          source_turn_id: turnId,
          source_ids: [],
          payload: { kind: "memory", text: "Derived permanent candidate", temporary: false },
          status: "pending",
          course_id: null,
        }];
      }
      if (query.includes("SELECT * FROM opening_memories")) return [];
      if (query.includes("SELECT text, source_turn_ids FROM opening_memories")) return [];
      if (query.includes("INSERT INTO opening_memories")) return [derivedRow];
      if (query.includes("UPDATE opening_assistant_candidates")) return [{ id: derivedMemoryId }];
      if (query.includes("FROM opening_memories m")) return [derivedRow];
      if (query.includes("FROM opening_privacy_exclusions")) return [];
      throw new Error(`unexpected query: ${query}`);
    });

    await expect(decideOwnedMemoryCandidate(
      sql,
      scope,
      {
        id: derivedMemoryId,
        expectedVersion: 0,
        clientKey: "confirm-derived-memory-candidate",
        action: "confirm",
        expiresAt: null,
      },
      () => new Date("2026-11-21T00:01:00.000Z"),
    )).rejects.toThrow(OpeningMemoryError);
  });
});
