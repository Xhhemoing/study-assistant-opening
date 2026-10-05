import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOpeningConnectionsRepository } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
let f: OpeningFixture;
beforeAll(async () => { f = await createOpeningFixture(); });
afterAll(async () => { if (f) { await f.sql`DELETE FROM workspaces WHERE id IN (${f.scope.workspaceId},${f.otherScope.workspaceId})`; await f.close(); } });
const input = () => ({ label: "School mail", host: "mail.example.edu", port: 993, tlsMode: "implicit" as const, username: "student", folders: ["INBOX"], since: "2026-09-01T00:00:00.000Z", clientKey: randomUUID() });
const envelope = (fingerprint = "test-fingerprint") => ({ keyId: "test", nonce: Buffer.alloc(12, 1), ciphertext: Buffer.from("encrypted"), authTag: Buffer.alloc(16, 1), payloadHash: fingerprint });
describe("connection repository", () => {
  it("replays creation but rejects changed input and forged owners", async () => {
    const repo = createOpeningConnectionsRepository(f.sql); const setup = input();
    const a = await repo.createImap(f.scope, setup);
    expect((await repo.createImap(f.scope, setup)).id).toBe(a.id);
    await expect(repo.createImap(f.scope, { ...setup, label: "changed" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repo.createImap({ ...f.scope, ownerUserId: f.otherScope.ownerUserId }, input())).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("does not expose secrets or grant requested DingTalk scopes", async () => {
    const repo = createOpeningConnectionsRepository(f.sql);
    const view = await repo.createDingtalk(f.scope, { label: "Notifications", requestedScopes: ["messages.read"], clientKey: randomUUID() });
    expect(view.allowedScopes).toEqual([]); expect(view.state).not.toBe("ready");
    expect(Object.keys(view).sort()).toEqual(["id", "version", "kind", "label", "state", "allowedScopes", "lastSuccessAt", "errorCode"].sort());
    await expect(repo.get(f.otherScope, view.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("makes credential replay idempotent, rejects changed secrets and deletes on revoke", async () => {
    const repo = createOpeningConnectionsRepository(f.sql); const c = await repo.createImap(f.scope, input()); const key = randomUUID();
    await repo.putCredential(f.scope, c.id, envelope(), key);
    await repo.putCredential(f.scope, c.id, envelope(), key);
    expect((await repo.get(f.scope, c.id)).version).toBe(1);
    await expect(repo.putCredential(f.scope, c.id, envelope("different"), key)).rejects.toMatchObject({ code: "CONFLICT" });
    const revokeKey = randomUUID();
    const revoked = await repo.revoke(f.scope, c.id, 1, revokeKey);
    expect((await repo.revoke(f.scope, c.id, 1, revokeKey)).version).toBe(revoked.version);
    await expect(repo.putCredential(f.scope, c.id, envelope(), randomUUID())).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await f.sql`SELECT 1 FROM opening_connection_credentials WHERE connection_id=${c.id}`).toHaveLength(0);
  });
  it("serializes a credential/revocation race without resurrecting credentials", async () => {
    const repo = createOpeningConnectionsRepository(f.sql); const c = await repo.createImap(f.scope, input());
    const results = await Promise.allSettled([repo.putCredential(f.scope, c.id, envelope(), randomUUID()), repo.revoke(f.scope, c.id, 0, randomUUID())]);
    const current = await repo.get(f.scope, c.id);
    if (current.state !== "revoked") await repo.revoke(f.scope, c.id, current.version, randomUUID());
    expect(results.some(r => r.status === "fulfilled")).toBe(true);
    expect((await repo.get(f.scope, c.id)).state).toBe("revoked");
    expect(await f.sql`SELECT 1 FROM opening_connection_credentials WHERE connection_id=${c.id}`).toHaveLength(0);
  });
});
