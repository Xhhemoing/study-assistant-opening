import { randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import { describe, expect, it, vi } from "vitest";
import { createOpeningMemoryRepository } from "./opening-memory";

function sqlStub() {
  const calls: string[] = [];
  const tx = Object.assign(
    async (strings: TemplateStringsArray) => {
      const text = strings.join(" ").replace(/\s+/g, " ").trim();
      calls.push(text);
      if (text.includes("FROM workspaces")) return [{ id: "workspace" }];
      if (text.includes("INSERT INTO opening_memories")) {
        return [{
          id: randomUUID(), workspace_id: randomUUID(), course_id: null, kind: "candidate",
          text: "note", source_turn_ids: [], version: 0, expires_at: null, status: "active",
          created_at: new Date(), updated_at: new Date(),
        }];
      }
      return [];
    },
    { json: (value: unknown) => value },
  );
  const begin = vi.fn(async (run: (inner: TransactionSql) => Promise<unknown>) => run(tx as never));
  return { sql: Object.assign(tx, { begin, json: tx.json }), calls, begin };
}

describe("proposeMemory transaction boundary", () => {
  it("locks, checks, and inserts inside one transaction", async () => {
    const { sql, calls, begin } = sqlStub();
    const memories = createOpeningMemoryRepository(sql as never);
    await memories.proposeMemory(
      { workspaceId: randomUUID(), ownerUserId: randomUUID() },
      { text: "note", sourceTurnIds: [], expiresAt: null },
    );
    expect(begin).toHaveBeenCalledOnce();
    expect(calls[0]).toContain("FROM workspaces");
    expect(calls.some((sqlText) => sqlText.includes("status = 'rejected'"))).toBe(true);
    expect(calls.at(-1)).toContain("INSERT INTO opening_memories");
  });
});
