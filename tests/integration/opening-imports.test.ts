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

async function seedConnection(scope = f.scope, version = 1) {
  const id = randomUUID();
  await f.sql`INSERT INTO opening_connections
    (id,workspace_id,owner_user_id,version,kind,label,create_client_key)
    VALUES (${id},${scope.workspaceId},${scope.ownerUserId},${version},'imap','Test',${'ck-' + id})`;
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
      cursor: { generation: "1", cursor: { folder: "INBOX", uidValidity: "1", lastUid: 9 } },
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
  it("cancels queued jobs for only the revoked connection", async () => {
    const connectionA = await seedConnection();
    const connectionB = await seedConnection();
    const sourceId = await seedSource();
    const revokeRepo = createOpeningConnectionsRepository(f.sql);
    const queuedA = randomUUID();
    const queuedB = randomUUID();

    await f.sql`INSERT INTO opening_jobs (workspace_id,owner_user_id,key,kind,payload)
      VALUES (${f.scope.workspaceId},${f.scope.ownerUserId},${queuedA},'parse',
        ${f.sql.json({ connectionId: connectionA.id, sourceId })}),
        (${f.scope.workspaceId},${f.scope.ownerUserId},${queuedB},'parse',
        ${f.sql.json({ connectionId: connectionB.id, sourceId })})`;

    const revoked = await revokeRepo.revoke(f.scope, connectionA.id, connectionA.version, "revoke-client");
    expect(revoked.state).toBe("revoked");

    const jobs = await f.sql`SELECT key, state FROM opening_jobs WHERE key IN (${queuedA},${queuedB}) ORDER BY key`;
    const stateByKey = new Map(jobs.map(job => [String(job.key), String(job.state)]));
    expect(stateByKey.get(queuedA)).toBe("cancelled");
    expect(stateByKey.get(queuedB)).toBe("queued");
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
