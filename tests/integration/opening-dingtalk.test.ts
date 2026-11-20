import { createCipheriv, createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpeningConnectionsRepository } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { receiveDingTalkCallback } from "../../apps/web/src/features/opening/connections/dingtalk-callback-service";
import type { ConnectorSourceStorage } from "../../apps/worker/src/connectors/publish-source";

let f: OpeningFixture;

const token = "opening-callback-token";
const encodingAesKey = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP1234567".slice(0, 43);
const corpId = "ding-corp-id";
const defaultScope = "conversation";
const otherScope = "calendar";
const content = "# Meeting\n\nOpening callback body.";

const connections: Record<string, {
  workspaceId: string;
  ownerUserId: string;
  connectionId: string;
}> = {};

beforeAll(async () => {
  f = await createOpeningFixture();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  if (f) {
    await f.sql`DELETE FROM workspaces WHERE id IN (${f.scope.workspaceId},${f.otherScope.workspaceId})`;
    await f.close();
  }
});

beforeEach(async () => {
  vi.stubEnv("OPENING_DINGTALK_CALLBACK_TOKEN", token);
  vi.stubEnv("OPENING_DINGTALK_ENCODING_AES_KEY", encodingAesKey);
  vi.stubEnv("OPENING_DINGTALK_CORP_ID", corpId);
  await f.sql`TRUNCATE opening_import_receipts, opening_import_cursors, opening_jobs, opening_outbox, opening_sources RESTART IDENTITY CASCADE`;
  await f.sql`DELETE FROM opening_connections WHERE workspace_id IN (${f.scope.workspaceId},${f.otherScope.workspaceId})`;

  const id = randomUUID();
  await f.sql`INSERT INTO opening_connections
    (id,workspace_id,owner_user_id,version,kind,label,state,allowed_scopes,requested_scopes,create_client_key)
    VALUES (${id},${f.scope.workspaceId},${f.scope.ownerUserId},1,'dingtalk','DingTalk','ready',
      ${f.sql.array([defaultScope, otherScope])},${f.sql.array([defaultScope, otherScope])},${'ck-' + id})`;
  connections[corpId] = {
    workspaceId: f.scope.workspaceId,
    ownerUserId: f.scope.ownerUserId,
    connectionId: id,
  };
  vi.stubEnv("OPENING_DINGTALK_CALLBACK_CONNECTIONS", JSON.stringify(connections));
});

afterEach(() => {
  vi.stubEnv("OPENING_DINGTALK_ALLOWED_DOWNLOAD_HOSTS", "");
});

function encryptDingTalkEvent(input: {
  encodingAesKey: string;
  corpIdOrKey: string;
  event: Record<string, unknown>;
}) {
  const key = Buffer.from(`${input.encodingAesKey}=`, "base64");
  const message = Buffer.from(JSON.stringify(input.event), "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(message.byteLength);
  const plain = Buffer.concat([
    Buffer.from(randomUUID().replace(/-/g, ""), "hex"),
    length,
    message,
    Buffer.from(input.corpIdOrKey, "ascii"),
  ]);
  const padding = 32 - (plain.byteLength % 32);
  const padded = Buffer.concat([plain, Buffer.alloc(padding, padding)]);
  const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64");
}

function signedCallback(event: Record<string, unknown>, now = Date.now) {
  const timestamp = String(Math.floor(now() / 1000));
  const nonce = randomUUID();
  const encrypted = encryptDingTalkEvent({ encodingAesKey, corpIdOrKey: corpId, event });
  const signature = createHash("sha1")
    .update([token, timestamp, nonce, encrypted].sort().join(""))
    .digest("hex");
  return { signature, timestamp, nonce, encrypted, encryptedBody: encrypted, now };
}

function storage(onUpload?: () => Promise<void>) {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    upload: vi.fn<ConnectorSourceStorage["upload"]>(async ({ key, bytes }) => {
      objects.set(key, bytes);
      await onUpload?.();
    }),
    remove: vi.fn<ConnectorSourceStorage["remove"]>(async key => { objects.delete(key); }),
  };
}

async function counts() {
  const [sources] = await f.sql`SELECT count(*)::int AS count FROM opening_sources`;
  const [receipts] = await f.sql`SELECT count(*)::int AS count FROM opening_import_receipts`;
  return { sources: Number(sources!.count), receipts: Number(receipts!.count) };
}

describe("opening DingTalk callback service", () => {
  it("rejects a forged signature without creating source or receipt", async () => {
    const callback = signedCallback({
      eventId: "forged-signature",
      requiredScope: defaultScope,
      content,
    });
    const deps = { sql: f.sql, storage: storage() };

    await expect(receiveDingTalkCallback({ ...callback, signature: "0".repeat(40) }, deps))
      .rejects.toMatchObject({ code: "SIGNATURE" });
    await expect(counts()).resolves.toEqual({ sources: 0, receipts: 0 });
    expect(deps.storage.upload).not.toHaveBeenCalled();
  });

  it("rejects a stale signed timestamp", async () => {
    const callback = signedCallback({
      eventId: "stale-event",
      requiredScope: defaultScope,
      content,
    }, () => Date.now() + 301 * 1000);
    const deps = { sql: f.sql, storage: storage() };

    await expect(receiveDingTalkCallback(callback, deps))
      .rejects.toMatchObject({ code: "FORMAT", message: "callback timestamp is stale" });
    await expect(counts()).resolves.toEqual({ sources: 0, receipts: 0 });
  });

  it("imports a signed valid event with source and receipt", async () => {
    const callback = signedCallback({
      eventId: "valid-event",
      requiredScope: defaultScope,
      content,
    });
    const deps = { sql: f.sql, storage: storage() };

    const result = await receiveDingTalkCallback(callback, deps);
    expect(result).toMatchObject({ eventId: "valid-event", duplicate: false, imported: 1 });
    expect(result.sourceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(result.receiptId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(deps.storage.upload).toHaveBeenCalledOnce();
    expect(deps.storage.objects.has(`opening/sources/${result.sourceId}/v0`)).toBe(true);

    const [source] = await f.sql`SELECT name,mime,upload_state FROM opening_sources WHERE id=${result.sourceId}`;
    expect(source).toMatchObject({
      name: "dingtalk-event-valid-event.md",
      mime: "text/markdown",
      upload_state: "uploaded",
    });
    const [receipt] = await f.sql`SELECT connection_version,identity_key FROM opening_import_receipts WHERE id=${result.receiptId}`;
    expect(receipt!.connection_version).toBe(1);
    expect(JSON.parse(String(receipt!.identity_key))).toEqual([
      connections[corpId]!.connectionId,
      "dingtalk-callback",
      "callback",
      "valid-event",
    ]);
  });

  it("is idempotent for the same eventId and does not create another source", async () => {
    const first = await receiveDingTalkCallback(signedCallback({
      eventId: "repeat-event",
      requiredScope: defaultScope,
      content,
    }), { sql: f.sql, storage: storage() });
    expect(first.duplicate).toBe(false);

    const replayStorage = storage();
    const second = await receiveDingTalkCallback(signedCallback({
      eventId: "repeat-event",
      requiredScope: defaultScope,
      content,
    }), { sql: f.sql, storage: replayStorage });

    expect(second).toMatchObject({
      eventId: "repeat-event",
      duplicate: true,
      imported: 0,
      receiptId: first.receiptId,
      sourceId: null,
    });
    await expect(counts()).resolves.toEqual({ sources: 1, receipts: 1 });
    expect(replayStorage.upload).not.toHaveBeenCalled();
  });

  it("publishes only once when concurrent redeliveries have both staged their objects", async () => {
    const event = { eventId: "concurrent-delivery", requiredScope: defaultScope, content };
    const bothStaged = Promise.withResolvers<void>();
    let staged = 0;
    const objectStore = storage(async () => {
      if (++staged === 2) bothStaged.resolve();
      await bothStaged.promise;
    });
    const deps = { sql: f.sql, storage: objectStore };
    const deliveries = await Promise.all([receiveDingTalkCallback(signedCallback(event), deps), receiveDingTalkCallback(signedCallback(event), deps)]);
    const published = deliveries.find(delivery => !delivery.duplicate)!;
    expect(deliveries.map(delivery => delivery.imported).sort()).toEqual([0, 1]);
    expect(deliveries[0]!.receiptId).toBe(deliveries[1]!.receiptId);
    await expect(counts()).resolves.toEqual({ sources: 1, receipts: 1 });
    expect(await f.sql`SELECT 1 FROM opening_jobs WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(1);
    expect(await f.sql`SELECT 1 FROM opening_outbox WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(1);
    expect([...objectStore.objects.keys()]).toEqual([`opening/sources/${published.sourceId}/v0`]);
    expect(objectStore.remove).toHaveBeenCalledOnce();
  });

  it("rejects submission when the stored connection version changed", async () => {
    const callback = signedCallback({
      eventId: "version-changed",
      requiredScope: defaultScope,
      content,
    });
    const objectStore = storage(async () => {
      await f.sql`UPDATE opening_connections SET version=3 WHERE id=${connections[corpId]!.connectionId}`;
    });
    const deps = { sql: f.sql, storage: objectStore };

    await expect(receiveDingTalkCallback(callback, deps))
      .rejects.toMatchObject({ code: "CONFLICT", message: "connection version changed; import discarded" });
    await expect(counts()).resolves.toEqual({ sources: 0, receipts: 0 });
    expect(await f.sql`SELECT 1 FROM opening_jobs WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
    expect(await f.sql`SELECT 1 FROM opening_outbox WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
    expect(objectStore.objects.size).toBe(0);
    expect(objectStore.remove).toHaveBeenCalledOnce();
  });

  it("cleans up unpublished data if revocation wins after staging", async () => {
    const callback = signedCallback({ eventId: "revoked-during-upload", requiredScope: defaultScope, content });
    const connectionId = connections[corpId]!.connectionId;
    const objectStore = storage(async () => {
      await createOpeningConnectionsRepository(f.sql).revoke(f.scope, connectionId, 1, "integration-revoke");
    });
    await expect(receiveDingTalkCallback(callback, { sql: f.sql, storage: objectStore }))
      .rejects.toMatchObject({ code: "CONFLICT", message: "connection is revoked" });
    await expect(counts()).resolves.toEqual({ sources: 0, receipts: 0 });
    expect(await f.sql`SELECT 1 FROM opening_jobs WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
    expect(await f.sql`SELECT 1 FROM opening_outbox WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
    expect(objectStore.objects.size).toBe(0);
  });
  it("rejects a revoked connection", async () => {
    await f.sql`UPDATE opening_connections SET state='revoked' WHERE id=${connections[corpId]!.connectionId}`;
    const callback = signedCallback({
      eventId: "revoked-event",
      requiredScope: defaultScope,
      content,
    });
    const deps = { sql: f.sql, storage: storage() };

    await expect(receiveDingTalkCallback(callback, deps))
      .rejects.toMatchObject({ code: "CONFLICT", message: "connection cannot receive callbacks" });
    await expect(counts()).resolves.toEqual({ sources: 0, receipts: 0 });
  });
  it("does not promote allowedScopes for a callback", async () => {
    await f.sql`UPDATE opening_connections
      SET allowed_scopes=${f.sql.array([defaultScope])}
      WHERE id=${connections[corpId]!.connectionId}`;
    const callback = signedCallback({
      eventId: "scope-escalation",
      requiredScope: otherScope,
      content,
    });
    const deps = { sql: f.sql, storage: storage() };

    await expect(receiveDingTalkCallback(callback, deps))
      .rejects.toMatchObject({ code: "FORMAT", message: "callback is not authorized by connection scopes" });
    await expect(counts()).resolves.toEqual({ sources: 0, receipts: 0 });
    const rows = await f.sql`SELECT allowed_scopes FROM opening_connections WHERE id=${connections[corpId]!.connectionId}`;
    expect(rows[0]!.allowed_scopes).toEqual([defaultScope]);
  });

  it("rejects an attachment whose host is not allowlisted before download", async () => {
    const download = vi.fn(async () => new Uint8Array([1]));
    const callback = signedCallback({
      eventId: "bad-attachment-host",
      requiredScope: defaultScope,
      attachment: {
        url: "https://untrusted.example.invalid/file.bin",
        mime: "application/pdf",
        name: "file.pdf",
      },
    });
    const deps = { sql: f.sql, storage: storage(), download };

    await expect(receiveDingTalkCallback(callback, deps))
      .rejects.toMatchObject({ code: "FORMAT", message: "attachment host is not authorized" });
    expect(download).not.toHaveBeenCalled();
    await expect(counts()).resolves.toEqual({ sources: 0, receipts: 0 });
  });

  it("fails closed when mapping is missing", async () => {
    const callback = signedCallback({
      eventId: "missing-mapping",
      requiredScope: defaultScope,
      content,
    });
    vi.stubEnv("OPENING_DINGTALK_CALLBACK_CONNECTIONS", "{}");
    const deps = { sql: f.sql, storage: storage() };

    await expect(receiveDingTalkCallback(callback, deps))
      .rejects.toMatchObject({ code: "INVALID_CONFIG", message: "callback routing is not configured" });
    await expect(counts()).resolves.toEqual({ sources: 0, receipts: 0 });
  });
});









