import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ImapFlow } from "imapflow";
import type { ImapCursor } from "@aistudy/contracts";
import {
  createOpeningConnectionsRepository,
  createOpeningImportsRepository,
  createOpeningSourceActionsRepository,
} from "@aistudy/database";
import { readOpeningSourceQuotaUsage } from "../../packages/database/src/repositories/opening-source-quota";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { startOpeningImapServer, type OpeningImapServer } from "./opening-imap-server";
import { syncMailbox } from "../../apps/worker/src/connectors/imap-sync";
import { importIdentityKey } from "../../apps/worker/src/connectors/import-identity";

let f: OpeningFixture;
let server: OpeningImapServer;
let objectByKey = new Map<string, Uint8Array>();
let failFinalUpload = false;
let failImmediateDeletes = false;
const initialMail = {
  uid: 11,
  source: [
    "From: teacher@example.edu",
    "To: student@example.edu",
    "Subject: Lesson",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "hello lesson",
    "",
  ].join("\r\n"),
};

beforeAll(async () => {
  f = await createOpeningFixture();
  server = await startOpeningImapServer([initialMail]);
});

afterAll(async () => {
  await server?.close();
  if (f) {
    await f.sql`DELETE FROM workspaces WHERE id IN (${f.scope.workspaceId},${f.otherScope.workspaceId})`;
    await f.close();
  }
});

function seedConnection(version = 1) {
  const id = randomUUID();
  return f.sql`INSERT INTO opening_connections
    (id,workspace_id,owner_user_id,version,kind,label,create_client_key)
    VALUES (${id},${f.scope.workspaceId},${f.scope.ownerUserId},${version},'imap','Fixture',${'ck-' + id})`
    .then(() => ({ id, version }));
}

function makeClient() {
  return new ImapFlow({
    host: "127.0.0.1",
    port: server.port,
    secure: false,
    logger: false,
    auth: { user: "fixture", pass: "fixture" },
    tls: { rejectUnauthorized: true },
  });
}

async function runSync(options: { cursor?: ImapCursor | null; onUpload?: (bytes: Uint8Array) => Promise<void> } = {}) {
  const imports = createOpeningImportsRepository(f.sql);
  const cursor = options.cursor === undefined
    ? await imports.readImapCursor(f.scope, fixtureConnection.id, "INBOX") : options.cursor;
  const client = makeClient();
  try {
    await client.connect();
    return await syncMailbox({
      scope: f.scope,
      connectionId: fixtureConnection.id,
      connectionVersion: fixtureConnection.version,
      folder: "INBOX",
      cursor,
      since: new Date("2026-01-01T00:00:00.000Z"),
      client,
      imports,
      storage: {
        upload: async ({ key, bytes }) => {
          objectByKey.set(key, bytes);
          if (failFinalUpload) throw new Error("storage unavailable");
          await options.onUpload?.(bytes);
        },
        remove: async key => {
          if (failImmediateDeletes) throw new Error("storage cleanup unavailable");
          objectByKey.delete(key);
        },
      },
    });
  } finally {
    // syncMailbox logs out on success, but a rejected upload leaves the client
    // connected. The fixture owns that socket on every path; wait for the
    // server's close event before the next test can truncate or start a sync.
    client.close();
    await server.waitForConnectionsClosed();
  }
}

let fixtureConnection: { id: string; version: number };

beforeEach(async () => {
  await server.waitForConnectionsClosed();
  expect(server.activeConnectionCount()).toBe(0);
  server.mails.splice(0, server.mails.length, initialMail);
  objectByKey = new Map();
  failFinalUpload = false;
  failImmediateDeletes = false;
  await f.sql`TRUNCATE opening_import_receipts, opening_import_cursors, opening_jobs, opening_outbox,
    opening_source_versions, opening_sources, opening_privacy_exclusions RESTART IDENTITY CASCADE`;
  await f.sql`DELETE FROM opening_connections WHERE workspace_id=${f.scope.workspaceId}`;
  fixtureConnection = await seedConnection();
});

describe("isolated standard IMAP sync gate", () => {
  it("imports one real wire-format message into an immutable source and receipt", async () => {
    const result = await runSync();
    expect(result).toMatchObject({ imported: 1, skipped: 0, cursor: { folder: "INBOX", uidValidity: "42", lastUid: 11 } });
    expect(server.logoutCount()).toBeGreaterThan(0);

    const sources = await f.sql`SELECT * FROM opening_sources WHERE workspace_id=${f.scope.workspaceId}`;
    expect(sources).toHaveLength(1);
    const source = sources[0] as Record<string, unknown>;
    expect(source.name).toBe("Lesson.eml");
    expect(source.mime).toBe("message/rfc822");
    expect(source.upload_state).toBe("uploaded");
    expect(source.parse_state).toBe("queued");
    expect(Number(source.bytes)).toBe(Buffer.byteLength(server.mails[0]!.source));
    expect(String(source.sha256)).toHaveLength(64);
    expect(await f.sql`SELECT 1 FROM opening_jobs WHERE kind='parse'`).toHaveLength(1);
    expect(await f.sql`SELECT 1 FROM opening_outbox WHERE topic='opening.job.enqueue'`).toHaveLength(1);

    const stored = objectByKey.get(`opening/sources/${String(source.id)}/v0`);
    expect(Buffer.from(stored!).toString("utf8")).toBe(server.mails[0]!.source);
    const receipts = await f.sql`SELECT * FROM opening_import_receipts WHERE connection_id=${fixtureConnection.id}`;
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.identity_key).toBe(importIdentityKey({
      connectionId: fixtureConnection.id,
      container: "INBOX",
      generation: "42",
      remoteId: "11",
    }));
    const cursors = await f.sql`SELECT generation,cursor FROM opening_import_cursors WHERE connection_id=${fixtureConnection.id}`;
    expect(cursors[0]?.generation).toBe("42");
    expect(cursors[0]?.cursor).toEqual({ folder: "INBOX", uidValidity: "42", lastUid: 11 });
  });

  it("does not duplicate a replay and keeps the committed UID cursor stable", async () => {
    await runSync();
    const firstSources = await f.sql`SELECT count(*)::int AS count FROM opening_sources WHERE workspace_id=${f.scope.workspaceId}`;
    expect(firstSources[0]?.count).toBe(1);

    const replay = await runSync();
    expect(replay).toMatchObject({ imported: 0, cursor: { lastUid: 11 } });
    const secondSources = await f.sql`SELECT count(*)::int AS count FROM opening_sources WHERE workspace_id=${f.scope.workspaceId}`;
    expect(secondSources[0]?.count).toBe(1);
    expect(await f.sql`SELECT 1 FROM opening_import_receipts WHERE connection_id=${fixtureConnection.id}`).toHaveLength(1);
  });

  it("commits only one source and parse job for concurrent deliveries of the same UID", async () => {
    let uploads = 0;
    const onUpload = async () => { uploads += 1; };
    const results = await Promise.all([runSync({ cursor: null, onUpload }), runSync({ cursor: null, onUpload })]);
    expect(results.map(result => result.imported).sort()).toEqual([0, 1]);
    expect(uploads).toBe(1);
    const [source] = await f.sql`SELECT id FROM opening_sources WHERE workspace_id=${f.scope.workspaceId}`;
    expect([...objectByKey.keys()]).toEqual([`opening/sources/${source!.id}/v0`]);
    expect(await f.sql`SELECT 1 FROM opening_sources WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(1);
    expect(await f.sql`SELECT 1 FROM opening_jobs`).toHaveLength(1);
    expect(await f.sql`SELECT 1 FROM opening_outbox`).toHaveLength(1);
    expect(await f.sql`SELECT 1 FROM opening_import_receipts WHERE connection_id=${fixtureConnection.id}`).toHaveLength(1);
  });

  it("discards the message and staged object when revocation wins before publication", async () => {
    await expect(runSync({ onUpload: async () => {
      await createOpeningConnectionsRepository(f.sql).revoke(f.scope, fixtureConnection.id, fixtureConnection.version, "integration-revoke");
    } })).rejects.toMatchObject({ code: "CONFLICT", message: "connection is revoked" });
    expect(await f.sql`SELECT 1 FROM opening_sources WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
    expect(await f.sql`SELECT 1 FROM opening_jobs`).toHaveLength(0);
    expect(await f.sql`SELECT 1 FROM opening_outbox`).toHaveLength(0);
    expect(await f.sql`SELECT 1 FROM opening_import_receipts WHERE connection_id=${fixtureConnection.id}`).toHaveLength(0);
    expect(await f.sql`SELECT 1 FROM opening_import_cursors WHERE connection_id=${fixtureConnection.id}`).toHaveLength(0);
    expect(objectByKey.size).toBe(0);
  });

  it("journals an object when revocation wins and every immediate delete fails", async () => {
    failImmediateDeletes = true;
    await expect(runSync({ onUpload: async () => {
      await createOpeningConnectionsRepository(f.sql).revoke(f.scope, fixtureConnection.id, fixtureConnection.version, "integration-revoke");
    } })).rejects.toBeInstanceOf(AggregateError);

    const [journal] = await f.sql`SELECT source_id, pending_object_keys, asset_deleted_at
      FROM opening_privacy_exclusions WHERE workspace_id=${f.scope.workspaceId}
        AND cardinality(pending_object_keys)>0`;
    expect(journal).toMatchObject({ asset_deleted_at: expect.anything(), pending_object_keys: expect.any(Array) });
    const key = String((journal!.pending_object_keys as string[])[0]);
    expect(objectByKey.has(key)).toBe(true);
    const [orphan] = await f.sql`SELECT bytes FROM opening_source_versions
      WHERE workspace_id=${f.scope.workspaceId} AND source_id=${journal!.source_id} AND version=0`;
    expect(orphan).toMatchObject({ bytes: expect.anything() });
    await expect(readOpeningSourceQuotaUsage(f.sql, f.scope.workspaceId, 2 * 1024 ** 3))
      .resolves.toEqual({ bytes: BigInt(String(orphan!.bytes)), objects: 1n });
    expect(await f.sql`SELECT state FROM opening_connections WHERE id=${fixtureConnection.id}`)
      .toEqual([{ state: "revoked" }]);

    failImmediateDeletes = false;
    const actions = createOpeningSourceActionsRepository(f.sql);
    const cleanup = await actions.cleanup(f.scope, String(journal!.source_id));
    for (const pendingKey of cleanup.keys) {
      objectByKey.delete(pendingKey);
      await actions.cleaned(f.scope, String(journal!.source_id), pendingKey);
    }
    await expect(actions.cleanup(f.scope, String(journal!.source_id))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(f.sql`SELECT 1 FROM opening_privacy_exclusions WHERE source_id=${journal!.source_id}`).resolves.toHaveLength(0);
    await expect(f.sql`SELECT 1 FROM opening_source_versions WHERE source_id=${journal!.source_id}`).resolves.toHaveLength(0);
    await expect(readOpeningSourceQuotaUsage(f.sql, f.scope.workspaceId, 2 * 1024 ** 3))
      .resolves.toEqual({ bytes: 0n, objects: 0n });
    expect(objectByKey.has(key)).toBe(false);
  });

  it("imports both unordered UIDs on rollover, starting below the previous generation's cursor", async () => {
    server.mails.unshift({ ...server.mails[0]!, uid: 12, source: "Subject: UID 12\r\n\r\nnext" });
    const imports = createOpeningImportsRepository(f.sql);
    await imports.advanceImapCursor(f.scope, {
      connectionId: fixtureConnection.id,
      connectionVersion: fixtureConnection.version,
      cursor: { expected: null, next: { folder: "INBOX", uidValidity: "41", lastUid: 90 } },
    });
    const next = { folder: "INBOX", uidValidity: "42", lastUid: 12 };
    const imported: string[] = [];
    await expect(runSync({ onUpload: async bytes => { imported.push(Buffer.from(bytes).toString("utf8")); } }))
      .resolves.toMatchObject({ imported: 2, cursor: next });
    expect(imported).toEqual([server.mails[1]!.source, server.mails[0]!.source]);
    await expect(imports.readImapCursor(f.scope, fixtureConnection.id, "INBOX")).resolves.toEqual(next);
    await expect(runSync()).resolves.toMatchObject({ imported: 0, cursor: next });
  });

  it("imports the lowest 100 UIDs first and exhausts a descending mailbox on the second sync", { timeout: 25_000 }, async () => {
    const uids = Array.from({ length: 105 }, (_, index) => index + 11);
    server.mails.splice(0, 1, ...uids.toReversed().map(uid => ({
      uid, source: `Subject: UID ${uid}\r\n\r\nmessage`,
    })));
    const imported: number[] = [];
    const onUpload = async (bytes: Uint8Array) => {
      const raw = Buffer.from(bytes).toString("utf8");
      imported.push(Number(/^Subject: UID (\d+)/.exec(raw)?.[1]));
    };
    await expect(runSync({ onUpload })).resolves.toMatchObject({ imported: 100, cursor: { lastUid: 110 } });
    expect(imported).toEqual(uids.slice(0, 100));
    await expect(runSync({ onUpload })).resolves.toMatchObject({ imported: 5, cursor: { lastUid: 115 } });
    expect(imported).toEqual(uids);
    expect(await f.sql`SELECT 1 FROM opening_import_receipts WHERE connection_id=${fixtureConnection.id}`)
      .toHaveLength(uids.length);
  });

  it("does not advance a UID cursor or create a receipt when final upload fails", async () => {
    failFinalUpload = true;
    await expect(runSync()).rejects.toThrow("storage unavailable");
    expect(server.activeConnectionCount()).toBe(0);
    expect(await f.sql`SELECT 1 FROM opening_sources WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
    expect(await f.sql`SELECT 1 FROM opening_jobs`).toHaveLength(0);
    expect(await f.sql`SELECT 1 FROM opening_outbox`).toHaveLength(0);
    expect(objectByKey.size).toBe(0);
    expect(await f.sql`SELECT 1 FROM opening_import_receipts WHERE connection_id=${fixtureConnection.id}`).toHaveLength(0);
    expect(await f.sql`SELECT 1 FROM opening_import_cursors WHERE connection_id=${fixtureConnection.id}`).toHaveLength(0);
  });

  it("closes a failed sync before retrying on a fresh wire connection", async () => {
    failFinalUpload = true;
    await expect(runSync()).rejects.toThrow("storage unavailable");
    expect(server.activeConnectionCount()).toBe(0);

    failFinalUpload = false;
    await expect(runSync()).resolves.toMatchObject({ imported: 1, skipped: 0, cursor: { lastUid: 11 } });
    expect(server.activeConnectionCount()).toBe(0);
    expect(await f.sql`SELECT 1 FROM opening_import_receipts WHERE connection_id=${fixtureConnection.id}`).toHaveLength(1);
  });

  it("rolls back source publication, parse dispatch and the cursor when receipt insertion fails", async () => {
    await f.sql`ALTER TABLE opening_import_receipts ADD CONSTRAINT integration_reject_import CHECK (false) NOT VALID`;
    try {
      await expect(runSync()).rejects.toMatchObject({ code: "23514", constraint_name: "integration_reject_import" });
      expect(await f.sql`SELECT 1 FROM opening_sources WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
      expect(await f.sql`SELECT 1 FROM opening_source_versions WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
      expect(await f.sql`SELECT 1 FROM opening_jobs`).toHaveLength(0);
      expect(await f.sql`SELECT 1 FROM opening_outbox`).toHaveLength(0);
      expect(await f.sql`SELECT 1 FROM opening_import_cursors WHERE connection_id=${fixtureConnection.id}`).toHaveLength(0);
      expect(objectByKey.size).toBe(0);
    } finally {
      await f.sql`ALTER TABLE opening_import_receipts DROP CONSTRAINT integration_reject_import`;
    }
  });

  it("isolates mailbox generations and workspace ownership through import receipts", async () => {
    await runSync();
    const sourceRows = await f.sql`SELECT id FROM opening_sources WHERE workspace_id=${f.scope.workspaceId}`;
    const sourceId = String((sourceRows[0] as Record<string, unknown>).id);
    const imports = createOpeningImportsRepository(f.sql);
    await expect(imports.commit(f.otherScope, {
      connectionVersion: fixtureConnection.version,
      identity: { connectionId: fixtureConnection.id, container: "INBOX", generation: "42", remoteId: "11" },
      sourceId,
    })).rejects.toMatchObject({ code: "NOT_FOUND" });

    await expect(imports.commit(f.scope, {
      connectionVersion: fixtureConnection.version,
      identity: { connectionId: fixtureConnection.id, container: "INBOX", generation: "999", remoteId: "11" },
      sourceId,
    })).resolves.toMatchObject({ duplicate: false });
  });

  it("does not issue an upload ticket for a revoked connection during a stale final commit", async () => {
    await runSync();
    const sourceRows = await f.sql`SELECT id,version FROM opening_sources WHERE workspace_id=${f.scope.workspaceId}`;
    const sourceId = String((sourceRows[0] as Record<string, unknown>).id);
    await f.sql`UPDATE opening_connections SET state='revoked',version=2 WHERE id=${fixtureConnection.id}`;
    const imports = createOpeningImportsRepository(f.sql);
    await expect(imports.commit(f.scope, {
      connectionVersion: fixtureConnection.version,
      identity: { connectionId: fixtureConnection.id, container: "INBOX", generation: "42", remoteId: "11" },
      sourceId,
    })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await f.sql`SELECT state FROM opening_connections WHERE id=${fixtureConnection.id}`).toMatchObject([{ state: "revoked" }]);
  });
});
