import { randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import { describe, expect, it, vi } from "vitest";
import { replaceOwnedMemory } from "./opening-memory-replace";

const workspaceId = randomUUID();
const ownerUserId = randomUUID();
const memoryId = randomUUID();
const nextMemoryId = randomUUID();
const sourceTurnId = randomUUID();

function sqlStub(reusedKey = false) {
  const calls: string[] = [];
  let inserted = false;
  const corrected = {
    id: nextMemoryId,
    workspace_id: workspaceId,
    course_id: null,
    kind: "confirmed",
    text: "先看定义",
    source_turn_ids: [sourceTurnId],
    version: 3,
    expires_at: null,
    status: "active",
    created_at: new Date("2026-10-02T00:00:00Z"),
    updated_at: new Date("2026-10-02T00:00:00Z"),
  };
  const tx = Object.assign(
    async (strings: TemplateStringsArray) => {
      const text = strings.join(" ").replace(/\s+/g, " ").trim();
      calls.push(text);
      if (text.includes("FROM workspaces")) return [{ id: workspaceId }];
      if (text.includes("SELECT t.id FROM opening_turns")) return [{ id: sourceTurnId }];
      if (text.startsWith("UPDATE opening_memories")) return [{ id: memoryId }];
      if (text.includes("INSERT INTO opening_memories")) {
        inserted = true;
        return [corrected];
      }
      if (text.includes("last_decision_client_key") && text.includes("WHERE workspace_id")) {
        if (inserted) return [{ id: memoryId, status: "superseded", kind: "confirmed", version: 3 }, corrected];
        return reusedKey ? [{
          id: memoryId,
          workspace_id: workspaceId,
          course_id: null,
          kind: "confirmed",
          text: "先看例题",
          source_turn_ids: [sourceTurnId],
          version: 2,
          expires_at: null,
          status: "active",
          last_decision_client_key: "memory-replace-1",
          created_at: new Date("2026-10-01T00:00:00Z"),
          updated_at: new Date("2026-10-01T00:00:00Z"),
        }] : [];
      }
      if (text.includes("FROM opening_memories") && text.includes("FOR UPDATE")) {
        return [{
          id: memoryId,
          workspace_id: workspaceId,
          course_id: null,
          kind: "confirmed",
          text: "先看例题",
          source_turn_ids: [sourceTurnId],
          version: 2,
          expires_at: null,
          status: "active",
          created_at: new Date("2026-10-01T00:00:00Z"),
          updated_at: new Date("2026-10-01T00:00:00Z"),
        }];
      }
      throw new Error(`unexpected query: ${text}`);
    },
    { json: (value: unknown) => value },
  );
  const begin = vi.fn(async (run: (inner: TransactionSql) => Promise<unknown>) => run(tx as never));
  return { sql: Object.assign(tx, { begin, json: tx.json }), calls, begin };
}

describe("replaceOwnedMemory", () => {
  it("requires at least one source turn for the corrected confirmed fact", async () => {
    const { sql } = sqlStub();
    expect(() => replaceOwnedMemory(sql as never, { workspaceId, ownerUserId }, {
      id: memoryId,
      expectedVersion: 2,
      text: "先看定义",
      sourceTurnIds: [],
      clientKey: "memory-replace-empty-source",
    })).toThrow(expect.objectContaining({ code: "VALIDATION" }));
  });

  it("replays the corrected version for the same client key", async () => {
    const { sql } = sqlStub();
    const input = {
      id: memoryId,
      expectedVersion: 2,
      text: "先看定义",
      sourceTurnIds: [sourceTurnId],
      clientKey: "memory-replace-1",
    };
    const replaced = await replaceOwnedMemory(sql as never, { workspaceId, ownerUserId }, input);
    const replay = await replaceOwnedMemory(sql as never, { workspaceId, ownerUserId }, input);
    expect(replaced).toMatchObject({ id: nextMemoryId, kind: "confirmed", version: 3, status: "active" });
    expect(replay).toEqual(replaced);
  });

  it("rejects a key already used to confirm the current memory", async () => {
    const { sql } = sqlStub(true);
    await expect(replaceOwnedMemory(sql as never, { workspaceId, ownerUserId }, {
      id: memoryId,
      expectedVersion: 2,
      text: "先看例题",
      sourceTurnIds: [sourceTurnId],
      clientKey: "memory-replace-1",
    })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("supersedes the old confirmed fact and inserts the corrected version in one transaction", async () => {
    const { sql, calls, begin } = sqlStub();
    const replaced = await replaceOwnedMemory(sql as never, { workspaceId, ownerUserId }, {
      id: memoryId,
      expectedVersion: 2,
      text: "先看定义",
      sourceTurnIds: [sourceTurnId],
      clientKey: "memory-replace-1",
    });

    expect(begin).toHaveBeenCalledOnce();
    expect(calls.some((query) => query.includes("status = 'active'") && query.includes("kind = 'confirmed'"))).toBe(true);
    expect(calls.some((query) => query.includes("status = 'superseded'"))).toBe(true);
    expect(calls.at(-1)).toContain("INSERT INTO opening_memories");
    expect(replaced).toMatchObject({ id: nextMemoryId, kind: "confirmed", version: 3, status: "active", text: "先看定义" });
  });
});
