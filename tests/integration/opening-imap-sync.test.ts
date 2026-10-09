import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ImapFlow } from "imapflow";
import {
  createOpeningImportsRepository,
  createOpeningPrivacyRepository,
  createOpeningSourceRepository,
} from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { startOpeningImapServer, type OpeningImapServer } from "./opening-imap-server";
import { syncMailbox } from "../../apps/worker/src/connectors/imap-sync";

let f: OpeningFixture;
let server: OpeningImapServer;
let objectByKey = new Map<string, Uint8Array>();
let failFinalUpload = false;

beforeAll(async () => {
  f = await createOpeningFixture();
  server = await startOpeningImapServer([
    {
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
    },
  ]);
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
    auth: { user: "fixture", pass: "fixture" },
    tls: { rejectUnauthorized: true },
    logger: true,
  }) as unknown as Parameters<typeof syncMailbox>[0]["client"];
}

async function runSync() {
  const client = makeClient();
  await client.connect();
  return syncMailbox({
    scope: f.scope,
    connectionId: fixtureConnection.id,
    connectionVersion: fixtureConnection.version,
    folder: "INBOX",
    cursor: { folder: "INBOX", uidValidity: "42", lastUid: 0 },
    since: new Date("2026-01-01T00:00:00.000Z"),
    client,
    imports: createOpeningImportsRepository(f.sql),
    sources: createOpeningSourceRepository(f.sql),
    privacy: createOpeningPrivacyRepository(f.sql),
    upload: async ({ key, bytes }) => {
      if (key.includes("/v") && failFinalUpload) throw new Error("storage unavailable");
      objectByKey.set(key, bytes);
    },
  });
}

let fixtureConnection: { id: string; version: number };

beforeEach(async () => {
  objectByKey = new Map();
  failFinalUpload = false;
  await f.sql`TRUNCATE opening_import_receipts, opening_import_cursors, opening_jobs, opening_outbox, opening_source_versions, opening_sources RESTART IDENTITY CASCADE`;
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
    expect(receipts[0]?.remote_id).toBe("11");
    const cursors = await f.sql`SELECT generation,cursor FROM opening_import_cursors WHERE connection_id=${fixtureConnection.id}`;
    expect(cursors[0]?.generation).toBe("42");
    expect(cursors[0]?.cursor).toEqual({ folder: "INBOX", uidValidity: "42", lastUid: 11 });
  });

  it("does not duplicate a replay and keeps the committed UID cursor stable", async () => {
    await runSync();
    const firstSources = await f.sql`SELECT count(*)::int AS count FROM opening_sources WHERE workspace_id=${f.scope.workspaceId}`;
    expect(firstSources[0]?.count).toBe(1);

    const replay = await runSync();
    expect(replay).toMatchObject({ imported: 0, skipped: 1, cursor: { lastUid: 11 } });
    const secondSources = await f.sql`SELECT count(*)::int AS count FROM opening_sources WHERE workspace_id=${f.scope.workspaceId}`;
    expect(secondSources[0]?.count).toBe(1);
    expect(await f.sql`SELECT 1 FROM opening_import_receipts WHERE connection_id=${fixtureConnection.id}`).toHaveLength(1);
  });

  it("does not advance a UID cursor or create a receipt when final upload fails", async () => {
    failFinalUpload = true;
    await expect(runSync()).rejects.toThrow("storage unavailable");
    expect(await f.sql`SELECT 1 FROM opening_sources WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(1);
    expect(await f.sql`SELECT 1 FROM opening_import_receipts WHERE connection_id=${fixtureConnection.id}`).toHaveLength(0);
    expect(await f.sql`SELECT 1 FROM opening_import_cursors WHERE connection_id=${fixtureConnection.id}`).toHaveLength(0);
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