import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { confirmOwnedMemory, rejectOwnedMemory } from "./opening-memory-decision";
import { OpeningMemoryError } from "./opening-memory-types";

const scope = { workspaceId: randomUUID(), ownerUserId: randomUUID() };
const id = randomUUID();

function stub(options: { deniedOwnerRead?: number; failure?: { query: string; error: Error } } = {}) {
  const calls: string[] = [];
  let ownerReads = 0;
  const row = { id, workspace_id: scope.workspaceId, course_id: null, kind: "candidate", text: "note",
    source_turn_ids: [], version: 0, status: "active", expires_at: null,
    created_at: new Date(), updated_at: new Date() };
  const tx = async (strings: TemplateStringsArray) => {
    const query = strings.join(" ").replace(/\s+/g, " ").trim();
    calls.push(query);
    if (options.failure && query.includes(options.failure.query)) throw options.failure.error;
    if (query.includes("FROM workspaces")) {
      ownerReads += 1;
      return ownerReads === options.deniedOwnerRead ? [] : [{ id: scope.workspaceId }];
    }
    if (query.includes("SELECT * FROM opening_memories")) return [row];
    if (query.includes("UPDATE opening_memories")) return [{ ...row, version: 1,
      kind: query.includes("kind = 'confirmed'") ? "confirmed" : "candidate",
      status: query.includes("status = 'rejected'") ? "rejected" : "active" }];
    return [];
  };
  const begin = vi.fn(async (run: (db: typeof tx) => Promise<unknown>) => run(tx));
  return { sql: Object.assign(tx, { begin }), calls, begin };
}

for (const decide of [confirmOwnedMemory, rejectOwnedMemory]) {
  describe(decide.name, () => {
    it("fences history before workspace/memory locks in the original transaction without advancing", async () => {
      const { sql, calls, begin } = stub();
      const result = await decide(sql as never, scope, id, 0, "decision");
      expect(result.version).toBe(1);
      expect(begin).toHaveBeenCalledOnce();
      const history = calls.findIndex(query => query.includes("SELECT revision"));
      const workspace = calls.findIndex(query => query.includes("FROM workspaces") && query.includes("FOR UPDATE"));
      const memory = calls.findIndex(query => query.includes("SELECT * FROM opening_memories"));
      expect(history).toBeGreaterThan(0);
      expect(workspace).toBeGreaterThan(history);
      expect(memory).toBeGreaterThan(workspace);
      expect(calls.some(query => query.includes("revision=revision+1"))).toBe(false);
    });

    it.each([1, 2, 3])("retains typed ownership denial at read %s", async deniedOwnerRead => {
      const { sql, calls } = stub({ deniedOwnerRead });
      const work = decide(sql as never, scope, id, 0, "decision");
      await expect(work).rejects.toBeInstanceOf(OpeningMemoryError);
      await expect(work).rejects.toMatchObject({ code: "NOT_FOUND", message: "workspace not found" });
      expect(calls.some(query => query.includes("opening_memories"))).toBe(false);
      if (deniedOwnerRead < 3) expect(calls.some(query => query.includes("opening_workspace_history_revisions"))).toBe(false);
    });

    it.each([
      Object.assign(new Error("bad uuid"), { code: "22P02" }),
      Object.assign(new Error("workspace not found"), { code: "XX000" }),
      Object.assign(new Error("unrelated not found"), { code: "NOT_FOUND" }),
    ])("preserves unrelated history error identity: $message", async error => {
      const { sql, calls } = stub({ failure: { query: "INSERT INTO opening_workspace_history_revisions", error } });
      await expect(decide(sql as never, scope, id, 0, "decision")).rejects.toBe(error);
      expect(calls.some(query => query.includes("FOR UPDATE"))).toBe(false);
    });
  });
}
