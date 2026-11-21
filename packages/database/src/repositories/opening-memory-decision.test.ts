import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { confirmOwnedMemory, rejectOwnedMemory } from "./opening-memory-decision";
import { OpeningMemoryError } from "./opening-memory-types";

const scope = { workspaceId: randomUUID(), ownerUserId: randomUUID() };
const id = randomUUID();

function stub(options: {
  deniedOwnerRead?: number;
  failure?: { query: string; error: Error };
  rowOverride?: Partial<{ status: string; kind: string; version: number; last_decision_client_key: string | null }>;
} = {}) {
  const calls: string[] = [];
  let ownerReads = 0;
  const row = { id, workspace_id: scope.workspaceId, course_id: null, kind: "candidate", text: "note",
    source_turn_ids: [], version: 0, status: "active", expires_at: null, last_decision_client_key: null as string | null,
    created_at: new Date(), updated_at: new Date(), ...(options.rowOverride ?? {}) };
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
    if (query.startsWith("UPDATE workspaces SET privacy_epoch")) return [{ id: scope.workspaceId, privacy_epoch: 1 }];
    if (query.startsWith("UPDATE opening_tutor_jobs j SET timing_execution_id = NULL")) return [];
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
      expect(calls.some(query => query.startsWith("UPDATE workspaces SET privacy_epoch"))).toBe(decide === rejectOwnedMemory);
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

it("rejectOwnedMemory skips privacy_epoch advance on idempotent replay", async () => {
  const { sql, calls } = stub({
    rowOverride: { status: "rejected", kind: "confirmed", version: 1, last_decision_client_key: "same-key" },
  });
  const result = await rejectOwnedMemory(sql as never, scope, id, 0, "same-key");
  expect(result.status).toBe("rejected");
  expect(calls.some(query => query.startsWith("UPDATE workspaces SET privacy_epoch"))).toBe(false);
});

describe("confirmOwnedMemory transitive source_turn_ids and memoryDependencyIds enforcement", () => {
  const sourceTurnId = randomUUID();

  function sourcedStub(options: {
    kind?: "candidate" | "temporary";
    expiresAt?: string | null;
    admittedRow?: { id: string; ancestor_temporary_expires_at: string | null } | null;
    expiryAfterUpdate?: boolean;
  }) {
    const calls: string[] = [];
    const row = {
      id, workspace_id: scope.workspaceId, course_id: null,
      kind: options.kind ?? "candidate", text: "derived memory",
      source_turn_ids: [sourceTurnId], version: 0, status: "active",
      expires_at: options.expiresAt ?? null, last_decision_client_key: null as string | null,
      created_at: new Date(), updated_at: new Date(),
    };
    const tx = async (strings: TemplateStringsArray) => {
      const query = strings.join(" ").replace(/\s+/g, " ").trim();
      calls.push(query);
      if (query.includes("FROM workspaces")) return [{ id: scope.workspaceId }];
      if (query.includes("SELECT * FROM opening_memories")) return [row];
      if (query.includes("FROM opening_memories m") && query.includes("WITH RECURSIVE mem_deps(dep_id)")) {
        return options.admittedRow ? [options.admittedRow] : [];
      }
      if (query.includes("UPDATE opening_memories")) {
        return [{ ...row, kind: "confirmed", expires_at: null, version: 1, last_decision_client_key: "confirm-sourced" }];
      }
      if (query.includes("AS still_active")) return [{ still_active: !options.expiryAfterUpdate }];
      return [];
    };
    const begin = vi.fn(async (run: (db: typeof tx) => Promise<unknown>) => run(tx));
    return { sql: Object.assign(tx, { begin }), calls };
  }

  it("rejects confirming a sourced memory when SQL transitive dependency check fails (revoked/deleted/expired ancestor)", async () => {
    const { sql, calls } = sourcedStub({ admittedRow: null });
    await expect(confirmOwnedMemory(sql as never, scope, id, 0, "confirm-sourced"))
      .rejects.toMatchObject({ code: "VALIDATION" });
    const checkIdx = calls.findIndex(q => q.includes("WITH RECURSIVE mem_deps(dep_id)") && q.includes("dep_m.expires_at > clock_timestamp()"));
    const lockIdx = calls.findIndex(q => q.includes("SELECT * FROM opening_memories") && q.includes("FOR UPDATE"));
    expect(checkIdx).toBeGreaterThan(lockIdx);
    expect(calls.some(q => q.startsWith("UPDATE opening_memories"))).toBe(false);
  });

  it("rejects confirming when ancestor temporary memory expiry has elapsed at now()", async () => {
    const { sql, calls } = sourcedStub({
      admittedRow: { id, ancestor_temporary_expires_at: "2026-11-21T00:00:00.000Z" },
    });
    await expect(confirmOwnedMemory(
      sql as never, scope, id, 0, "confirm-sourced", () => new Date("2026-11-21T00:01:00.000Z"),
    )).rejects.toMatchObject({ code: "VALIDATION" });
    expect(calls.some(q => q.startsWith("UPDATE opening_memories"))).toBe(false);
  });

  it("rejects promoting an already-expired temporary memory into confirmed", async () => {
    const { sql, calls } = sourcedStub({
      kind: "temporary",
      expiresAt: "2026-11-21T00:00:00.000Z",
      admittedRow: { id, ancestor_temporary_expires_at: null },
    });
    await expect(confirmOwnedMemory(
      sql as never, scope, id, 0, "confirm-sourced", () => new Date("2026-11-21T00:01:00.000Z"),
    )).rejects.toMatchObject({ code: "VALIDATION" });
    expect(calls.some(q => q.startsWith("UPDATE opening_memories"))).toBe(false);
  });

  it("confirms a sourced memory when all source turns and transitive memory dependencies remain active and unexpired", async () => {
    const { sql, calls } = sourcedStub({
      admittedRow: { id, ancestor_temporary_expires_at: "2099-01-01T00:00:00.000Z" },
    });
    const confirmed = await confirmOwnedMemory(
      sql as never, scope, id, 0, "confirm-sourced", () => new Date("2026-11-21T00:00:00.000Z"),
    );
    expect(confirmed.kind).toBe("confirmed");
    expect(confirmed.version).toBe(1);
    const checkIdx = calls.findIndex(q => q.includes("WITH RECURSIVE mem_deps(dep_id)"));
    const updateIdx = calls.findIndex(q => q.startsWith("UPDATE opening_memories"));
    expect(updateIdx).toBeGreaterThan(checkIdx);
  });

  it("aborts confirmation when the earliest temporary expiry elapses before commit", async () => {
    const { sql, calls } = sourcedStub({
      admittedRow: { id, ancestor_temporary_expires_at: "2099-01-01T00:00:00.000Z" },
      expiryAfterUpdate: true,
    });
    await expect(confirmOwnedMemory(sql as never, scope, id, 0, "confirm-sourced"))
      .rejects.toMatchObject({ code: "VALIDATION" });
    const finalCheck = calls.findIndex(q => q.includes("AS still_active"));
    expect(finalCheck).toBeGreaterThan(calls.findIndex(q => q.startsWith("UPDATE opening_memories")));
  });
});
