import { randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import { describe, expect, it, vi } from "vitest";
import { replaceOwnedMemory } from "./opening-memory-replace";

const workspaceId = randomUUID();
const ownerUserId = randomUUID();
const memoryId = randomUUID();
const nextMemoryId = randomUUID();
const sourceTurnId = randomUUID();

function sqlStub(reusedKey = false, admitSources = true, expireAtFence = false) {
  const calls: string[] = [];
  const admissionBindings: unknown[] = [];
  let inserted = false;
  let superseded = false;
  let epoch = 0;
  let expired = false;
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
  const execute = async (strings: TemplateStringsArray, values: unknown[]) => {
    const text = strings.join(" ").replace(/\s+/g, " ").trim();
    calls.push(text);
    if (text.includes("FROM workspaces")) return [{ id: workspaceId }];
    if (text.includes("opening_workspace_history_revisions")) return [];
    if (text.startsWith("UPDATE workspaces SET privacy_epoch")) return [{ id: workspaceId, privacy_epoch: ++epoch }];
    if (text.startsWith("UPDATE opening_tutor_jobs j SET timing_execution_id = NULL")) {
      await Promise.resolve();
      expired = expireAtFence;
      return [];
    }
    if (text.includes("SELECT t.id FROM opening_turns")) {
      admissionBindings.push(...values);
      return admitSources && !expired ? [{ id: sourceTurnId }] : [];
    }
    if (text.startsWith("UPDATE opening_memories")) {
      superseded = true;
      return [{ id: memoryId }];
    }
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
  };
  const tx = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({
      then: (resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) =>
        execute(strings, values).then(resolve, reject),
    }),
    { json: (value: unknown) => value },
  );
  const begin = vi.fn(async (run: (inner: TransactionSql) => Promise<unknown>) => {
    const before = { inserted, superseded, epoch };
    try {
      return await run(tx as never);
    } catch (error) {
      ({ inserted, superseded, epoch } = before);
      throw error;
    }
  });
  return { sql: Object.assign(tx, { begin, json: tx.json }), calls, begin, admissionBindings,
    state: () => ({ inserted, superseded, epoch }) };
}

describe("replaceOwnedMemory", () => {
  it.each([[], undefined])("requires an explicit non-empty source for the corrected fact (%j)", (sourceTurnIds) => {
    const { sql } = sqlStub();
    expect(() => replaceOwnedMemory(sql as never, { workspaceId, ownerUserId }, {
      id: memoryId,
      expectedVersion: 2,
      text: "先看定义",
      sourceTurnIds: sourceTurnIds as string[],
      clientKey: "memory-replace-empty-source",
    })).toThrow(expect.objectContaining({ code: "VALIDATION" }));
  });

  it("validates source ancestry under the history lock and excludes the superseded memory", async () => {
    const { sql, calls, admissionBindings } = sqlStub(false, false);
    await expect(replaceOwnedMemory(sql as never, { workspaceId, ownerUserId }, {
      id: memoryId,
      expectedVersion: 2,
      text: "先看定义",
      sourceTurnIds: [sourceTurnId.toUpperCase()],
      clientKey: "memory-replace-self-dependency",
    })).rejects.toMatchObject({ code: "VALIDATION" });

    const history = calls.findIndex(query => query.startsWith("SELECT revision"));
    const workspace = calls.findIndex(query => query.includes("FROM workspaces") && query.includes("FOR UPDATE"));
    const admission = calls.findIndex(query => query.startsWith("SELECT t.id FROM opening_turns"));
    expect(history).toBeGreaterThanOrEqual(0);
    expect(workspace).toBeGreaterThan(history);
    expect(admission).toBeGreaterThan(workspace);
    expect(admissionBindings).toContain(memoryId);
    expect(admissionBindings).toContainEqual([sourceTurnId]);
    expect(calls.some(query => /^(UPDATE|INSERT INTO) opening_memories/.test(query))).toBe(false);
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

  it("rolls back both revisions and the privacy epoch if ancestry expires during the Tutor job lock", async () => {
    const { sql, calls, state } = sqlStub(false, true, true);
    await expect(replaceOwnedMemory(sql as never, { workspaceId, ownerUserId }, {
      id: memoryId, expectedVersion: 2, text: "corrected", sourceTurnIds: [sourceTurnId],
      clientKey: "memory-replace-expired-during-lock",
    })).rejects.toMatchObject({ code: "VALIDATION" });
    const fence = calls.findIndex(query => query.startsWith("UPDATE opening_tutor_jobs j"));
    expect(calls.findIndex(query => query.startsWith("INSERT INTO opening_memories"))).toBeLessThan(fence);
    expect(calls.at(-1)).toMatch(/^SELECT t.id FROM opening_turns/);
    expect(state()).toEqual({ inserted: false, superseded: false, epoch: 0 });
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
    expect(calls.some((query) => query.includes("INSERT INTO opening_memories"))).toBe(true);
    expect(calls.some((query) => query.startsWith("UPDATE workspaces SET privacy_epoch"))).toBe(true);
    expect(calls.some((query) => query.includes("SELECT t.id FROM opening_turns") && query.includes("WITH RECURSIVE mem_deps(dep_id)") && query.includes("dep_m.expires_at > clock_timestamp()"))).toBe(true);
    expect(replaced).toMatchObject({ id: nextMemoryId, kind: "confirmed", version: 3, status: "active", text: "先看定义" });
  });
});
