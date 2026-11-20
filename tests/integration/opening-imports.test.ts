import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  connectionViewSchema,
  imapCursorSchema,
  importIdentitySchema,
  importReceiptSchema,
} from "@aistudy/contracts";
import {
  createOpeningConnectionsRepository,
  createOpeningImportsRepository,
} from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { importIdentityKey } from "../../apps/worker/src/connectors/import-identity";
import { publishConnectorSource } from "../../apps/worker/src/connectors/publish-source";

let f: OpeningFixture;

beforeAll(async () => {
  f = await createOpeningFixture();
});
afterAll(async () => {
  if (f) {
    await f.sql`DELETE FROM workspaces WHERE id IN (${f.scope.workspaceId},${f.otherScope.workspaceId})`;
    await f.close();
  }
});
beforeEach(async () => {
  await f.sql`TRUNCATE opening_import_receipts, opening_import_cursors, opening_sources RESTART IDENTITY CASCADE`;
  await f.sql`DELETE FROM opening_connections WHERE workspace_id IN (${f.scope.workspaceId},${f.otherScope.workspaceId})`;
});

async function seedConnection(scope = f.scope, version = 1, kind: "imap" | "dingtalk" = "imap") {
  const id = randomUUID();
  await f.sql`INSERT INTO opening_connections
    (id,workspace_id,owner_user_id,version,kind,label,create_client_key)
    VALUES (${id},${scope.workspaceId},${scope.ownerUserId},${version},${kind},'Test',${'ck-' + id})`;
  return { id, version };
}

async function seedSource(scope = f.scope) {
  const id = randomUUID();
  await f.sql`INSERT INTO opening_sources (id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
    VALUES (${id},${scope.workspaceId},'import.eml','message/rfc822',12,${'a'.repeat(64)},0,'uploaded','not_started')`;
  return id;
}

describe("opening import receipts", () => {
  it("commits receipt and cursor transactionally", async () => {
    const c = await seedConnection();
    const sourceId = await seedSource();
    const identity = importIdentitySchema.parse({
      connectionId: c.id,
      container: "INBOX",
      generation: "1",
      remoteId: "9",
    });
    const repo = createOpeningImportsRepository(f.sql);

    const first = await repo.commit(f.scope, {
      connectionVersion: c.version,
      identity,
      sourceId,
      cursor: { expected: null, next: { folder: "INBOX", uidValidity: "1", lastUid: 9 } },
    });
    expect(first.duplicate).toBe(false);
    expect(first.sourceIds).toEqual([sourceId]);
    expect(first.connectionVersion).toBe(c.version);

    const second = await repo.commit(f.scope, {
      connectionVersion: c.version,
      identity,
      sourceId,
    });
    expect(second).toEqual({
      id: first.id,
      sourceIds: [sourceId],
      duplicate: true,
      connectionVersion: c.version,
    });

    const cursors = await f.sql`SELECT generation, cursor FROM opening_import_cursors
      WHERE connection_id=${c.id} AND container='INBOX'`;
    expect(cursors[0]?.generation).toBe("1");
    expect(cursors[0]?.cursor).toEqual({ folder: "INBOX", uidValidity: "1", lastUid: 9 });
  });

  it("changes UIDVALIDITY only from the exact persisted generation and UID", async () => {
    const connection = await seedConnection();
    const sourceId = await seedSource();
    const repo = createOpeningImportsRepository(f.sql);
    const folder = "INBOX";
    const original = { folder, uidValidity: "42", lastUid: 99 };
    const next = { folder, uidValidity: "43", lastUid: 1 };
    function commit(expected: typeof original | null, target: typeof original) {
      return repo.commit(f.scope, {
        connectionVersion: connection.version, sourceId,
        identity: { connectionId: connection.id, container: folder, generation: target.uidValidity, remoteId: String(target.lastUid) },
        cursor: { expected, next: target },
      });
    }
    await commit(null, original);
    await expect(commit({ ...original, lastUid: 98 }, next)).rejects.toMatchObject({ code: "CONFLICT" });
    await commit(original, next);
    await expect(commit(original, { ...original, lastUid: 100 })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repo.readImapCursor(f.scope, connection.id, folder)).resolves.toEqual(next);
    expect(await f.sql`SELECT id FROM opening_import_receipts WHERE connection_id=${connection.id}`).toHaveLength(2);
  });
});

describe("opening import isolation and protection", () => {
  it("isolates generations and workspaces", async () => {
    const c = await seedConnection();
    const sourceId = await seedSource();
    const repo = createOpeningImportsRepository(f.sql);
    const base = { connectionId: c.id, container: "INBOX", generation: "1", remoteId: "9" };

    await repo.commit(f.scope, {
      connectionVersion: c.version,
      identity: importIdentitySchema.parse(base),
      sourceId,
    });

    const generationTwo = await repo.commit(f.scope, {
      connectionVersion: c.version,
      identity: importIdentitySchema.parse({ ...base, generation: "2" }),
      sourceId,
    });
    expect(generationTwo.duplicate).toBe(false);

    await expect(repo.commit(f.otherScope, {
      connectionVersion: c.version,
      identity: importIdentitySchema.parse(base),
      sourceId,
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects revoked, stale, and foreign connections", async () => {
    const c = await seedConnection();
    const sourceId = await seedSource();
    const identity = importIdentitySchema.parse({
      connectionId: c.id,
      container: "INBOX",
      generation: "1",
      remoteId: "9",
    });
    const repo = createOpeningImportsRepository(f.sql);

    await f.sql`UPDATE opening_connections SET state='revoked', version=2 WHERE id=${c.id}`;
    await expect(repo.commit(f.scope, {
      connectionVersion: c.version,
      identity,
      sourceId,
    })).rejects.toMatchObject({ code: "CONFLICT" });

    await f.sql`UPDATE opening_connections SET state='ready' WHERE id=${c.id}`;
    await expect(repo.commit(f.scope, {
      connectionVersion: c.version,
      identity,
      sourceId,
    })).rejects.toMatchObject({ code: "CONFLICT" });

    const invalidIdentity = { ...identity, connectionId: randomUUID() } as const;
    await expect(repo.commit(f.scope, {
      connectionVersion: c.version,
      identity: invalidIdentity,
      sourceId,
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("revocation closes queued import work", () => {
  it.each(["dingtalk", "imap"] as const)("cancels current and legacy queued %s parse jobs", async kind => {
    const connection = await seedConnection(f.scope, 1, kind);
    const other = await seedConnection(f.scope, 1, kind);
    const revokeRepo = createOpeningConnectionsRepository(f.sql);
    const imports = createOpeningImportsRepository(f.sql);
    const storage = { upload: async () => {}, remove: async () => {} };
    async function publish(target: typeof connection, uid: number) {
      const receipt = await publishConnectorSource(imports, storage, f.scope, {
        connectionVersion: target.version,
        identity: {
          connectionId: target.id,
          container: kind === "imap" ? "INBOX" : "dingtalk-callback",
          generation: kind === "imap" ? "42" : "callback",
          remoteId: String(uid),
        },
        name: kind === "imap" ? "fixture.eml" : "fixture.md",
        mime: kind === "imap" ? "message/rfc822" : "text/markdown",
        bytes: Buffer.from("Subject: Fixture\r\n\r\nTest message"),
      });
      return receipt.sourceIds[0]!;
    }
    const sourceId = await publish(connection, 11);
    const legacyId = await publish(connection, 12);
    const otherId = await publish(other, 11);
    const [queued] = await f.sql`SELECT kind, state, payload FROM opening_jobs
      WHERE workspace_id=${f.scope.workspaceId} AND payload->>'sourceId'=${sourceId}`;
    await f.sql`UPDATE opening_jobs SET payload=payload - 'connectionId'
      WHERE workspace_id=${f.scope.workspaceId} AND payload->>'sourceId'=${legacyId}`;

    const revoked = await revokeRepo.revoke(f.scope, connection.id, connection.version, "revoke-client");
    expect(revoked.state).toBe("revoked");

    const jobs = await f.sql`SELECT state, payload FROM opening_jobs
      WHERE workspace_id=${f.scope.workspaceId} AND payload->>'sourceId' IN (${sourceId},${legacyId},${otherId})`;
    expect(new Map(jobs.map(job => [String(job.payload.sourceId), String(job.state)]))).toEqual(new Map([
      [sourceId, "cancelled"], [legacyId, "cancelled"], [otherId, "queued"],
    ]));
    expect(queued).toMatchObject({ kind: "parse", state: "queued", payload: {
      sourceId, sourceVersion: 0, connectionId: connection.id,
    } });
  });
});

describe("import identity and receipt contracts", () => {
  it("keeps mailbox generations distinct and validates receipt shape", () => {
    const base = {
      connectionId: randomUUID(),
      container: "INBOX",
      generation: "1",
      remoteId: "9",
    };
    expect(importIdentityKey(base)).not.toBe(importIdentityKey({ ...base, generation: "2" }));
    expect(importReceiptSchema.safeParse({
      id: randomUUID(),
      sourceIds: [randomUUID()],
      duplicate: false,
      connectionVersion: 1,
    }).success).toBe(true);
    expect(connectionViewSchema.safeParse({ id: randomUUID(), secret: "private" }).success).toBe(false);
    expect(imapCursorSchema.safeParse({ folder: "INBOX", uidValidity: "1", lastUid: 1 }).success).toBe(true);
  });
});
