import { randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import { describe, expect, it, vi } from "vitest";
import { createOpeningMemoryRepository, OpeningMemoryError } from "./opening-memory";

function sqlStub(options: { deniedOwnerRead?: number; failure?: { query: string; error: Error } } = {}) {
  const calls: string[] = [];
  let ownerReads = 0;
  const tx = Object.assign(
    async (strings: TemplateStringsArray) => {
      const text = strings.join(" ").replace(/\s+/g, " ").trim();
      calls.push(text);
      if (options.failure && text.includes(options.failure.query)) throw options.failure.error;
      if (text.includes("FROM workspaces")) {
        ownerReads += 1;
        return ownerReads === options.deniedOwnerRead ? [] : [{ id: "workspace" }];
      }
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
    expect(calls.slice(0, 2).every(query => !query.includes("FOR UPDATE"))).toBe(true);
    const history = calls.findIndex(query => query.includes("SELECT revision"));
    const workspace = calls.findIndex(query => query.includes("FROM workspaces") && query.includes("FOR UPDATE"));
    expect(history).toBeGreaterThan(0);
    expect(workspace).toBeGreaterThan(history);
    expect(calls.some(query => query.includes("revision=revision+1"))).toBe(false);
    expect(calls.some((sqlText) => sqlText.includes("status = 'rejected'"))).toBe(true);
    expect(calls.at(-1)).toContain("INSERT INTO opening_memories");
  });

  it.each([1, 2, 3])("keeps typed workspace not-found at ownership read %s", async deniedOwnerRead => {
    const { sql, calls } = sqlStub({ deniedOwnerRead });
    const work = createOpeningMemoryRepository(sql as never).proposeMemory(
      { workspaceId: randomUUID(), ownerUserId: randomUUID() },
      { text: "note", sourceTurnIds: [], expiresAt: null },
    );
    await expect(work).rejects.toBeInstanceOf(OpeningMemoryError);
    await expect(work).rejects.toMatchObject({ code: "NOT_FOUND", message: "workspace not found" });
    expect(calls.some(query => query.includes("opening_memories"))).toBe(false);
    if (deniedOwnerRead < 3) expect(calls.some(query => query.includes("opening_workspace_history_revisions"))).toBe(false);
  });

  it.each([
    Object.assign(new Error("bad uuid"), { code: "22P02" }),
    Object.assign(new Error("workspace not found"), { code: "XX000" }),
    Object.assign(new Error("unrelated not found"), { code: "NOT_FOUND" }),
  ])("propagates unrelated history errors unchanged: $message", async error => {
    const { sql, calls } = sqlStub({ failure: { query: "INSERT INTO opening_workspace_history_revisions", error } });
    await expect(createOpeningMemoryRepository(sql as never).proposeMemory(
      { workspaceId: randomUUID(), ownerUserId: randomUUID() },
      { text: "note", sourceTurnIds: [], expiresAt: null },
    )).rejects.toBe(error);
    expect(calls.some(query => query.includes("FOR UPDATE"))).toBe(false);
  });

  it("retains text/expiry validation before opening a transaction", async () => {
    const { sql, begin } = sqlStub();
    const repo = createOpeningMemoryRepository(sql as never);
    const scope = { workspaceId: randomUUID(), ownerUserId: randomUUID() };
    await expect(repo.proposeMemory(scope, { text: " ", sourceTurnIds: [], expiresAt: "bad" }))
      .rejects.toMatchObject({ message: "memory text is required" });
    await expect(repo.proposeMemory(scope, { text: "note", sourceTurnIds: [], expiresAt: "bad" }))
      .rejects.toMatchObject({ message: "expiresAt must be an ISO datetime" });
    expect(begin).not.toHaveBeenCalled();
  });
});
