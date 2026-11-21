import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { connectorReservationId, createOpeningSourceActionsRepository } from "./opening-source-actions";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const ownerUserId = "00000000-0000-4000-8000-0000000000aa";
const scope = { workspaceId, ownerUserId };
const sourceId = "00000000-0000-4000-8000-0000000000ab";

function fakeActionsSql(initialRow: { id: string; pendingKeys: string[] }) {
  const row = {
    id: initialRow.id,
    source_id: sourceId,
    asset_deleted_at: new Date("2030-01-01T00:00:00.000Z"),
    pending_object_keys: [...initialRow.pendingKeys],
    cleanup_not_before: null as Date | null,
  };
  const updates: string[][] = [];
  let lockSeen = false;
  const tag = ((parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.join("?").replace(/\s+/g, " ").trim();
    if (query === "" || query === "FOR UPDATE") return query;
    if (query.startsWith("SELECT id FROM workspaces")) return Promise.resolve([{ id: workspaceId }]);
    if (query.startsWith("SELECT id, source_id, pending_object_keys, cleanup_not_before FROM opening_privacy_exclusions")) {
      lockSeen = query.includes("FOR UPDATE");
      return Promise.resolve([{ ...row, pending_object_keys: [...row.pending_object_keys] }]);
    }
    if (query.startsWith("SELECT pg_try_advisory_xact_lock")) return Promise.resolve([{ acquired: true }]);
    if (query.startsWith("UPDATE opening_privacy_exclusions SET pending_object_keys=?")) {
      row.pending_object_keys = [...(values[0] as string[])];
      updates.push(row.pending_object_keys);
      return Promise.resolve([]);
    }
    return Promise.reject(new Error(`unexpected sql: ${query}`));
  }) as unknown as Sql;
  tag.begin = (async (cb: (tx: Sql) => Promise<unknown>) => cb(tag)) as unknown as Sql["begin"];
  return { sql: tag, updates, row, lockSeen: () => lockSeen };
}

describe("opening source actions cleanup extra key persistence", () => {
  it("locks the receipt FOR UPDATE and merges valid newly discovered staging keys into an empty receipt", async () => {
    const db = fakeActionsSql({ id: "00000000-0000-4000-8000-000000000044", pendingKeys: [] });
    const repo = createOpeningSourceActionsRepository(db.sql);
    const mixedKey = `opening/staging/${sourceId.toUpperCase()}`;

    const cleanup = await repo.cleanup(scope, sourceId, {
      extraKeys: [mixedKey, "opening/staging/../escape", "opening/staging/foreign-key"],
    });
    expect(db.lockSeen()).toBe(true);
    expect(db.updates).toEqual([[mixedKey]]);
    expect(db.row.pending_object_keys).toEqual([mixedKey]);
    expect(cleanup.keys).toEqual([mixedKey]);
  });

  it("never modifies pending_object_keys on a UUIDv8 connector reservation", async () => {
    const key = `opening/sources/${sourceId}/v0`;
    const db = fakeActionsSql({ id: connectorReservationId(sourceId), pendingKeys: [key] });
    const repo = createOpeningSourceActionsRepository(db.sql);

    const cleanup = await repo.cleanup(scope, sourceId, {
      extraKeys: [`opening/staging/${sourceId.toUpperCase()}`],
    });
    expect(db.updates).toEqual([]);
    expect(cleanup).toMatchObject({ keys: [key], connectorReservation: true });
  });
});
