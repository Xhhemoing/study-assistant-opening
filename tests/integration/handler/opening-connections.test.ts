import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import { createOpeningFixture, type OpeningFixture } from "../opening-fixture";
import { createOpeningConnectionsRepository, decryptConnectionCredential } from "@aistudy/database";
import { readOpeningBackupRecords } from "../../../packages/database/src/repositories/opening-backup-records";
import { GET as list } from "../../../apps/web/src/app/api/opening/connections/route";
import { POST as createImap } from "../../../apps/web/src/app/api/opening/connections/imap/route";
import { POST as createDingtalk } from "../../../apps/web/src/app/api/opening/connections/dingtalk/route";
import { PUT as credential } from "../../../apps/web/src/app/api/opening/connections/[id]/credential/route";
import { POST as revoke } from "../../../apps/web/src/app/api/opening/connections/[id]/revoke/route";
import { POST as check } from "../../../apps/web/src/app/api/opening/connections/[id]/check/route";
import { POST as sync } from "../../../apps/web/src/app/api/opening/connections/[id]/sync/route";
let f: OpeningFixture;
let runtime: ReturnType<typeof createAuthRuntime>;
const secret = "do-not-expose-this-password";
function req(method: string, body?: unknown, cookie?: string) {
  return new Request("https://localhost/api/opening/connections", {
    method, headers: { cookie: cookie ?? f.cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const setup = () => ({ label: "School mail", host: "mail.example.edu", port: 993, tlsMode: "implicit", username: "student", folders: ["INBOX"], since: "2026-09-01T00:00:00.000Z", clientKey: randomUUID() });
const create = async () => { const response = await createImap(req("POST", setup())); expect(response.status).toBe(201); return response.json(); };
beforeAll(async () => {
  f = await createOpeningFixture();
  runtime = createAuthRuntime({ databaseUrl: process.env.DATABASE_URL!, authSecret: process.env.AUTH_SECRET ?? "opening-fixture-secret-opening-fixture-secret", sessionCookieSecure: false, sessionTtlSeconds: 3600, authCookieName: "aistudy_session" });
  setAuthRuntimeForTests(runtime);
});
beforeEach(() => {
  vi.stubEnv("OPENING_CONNECTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  vi.stubEnv("OPENING_CONNECTION_KEY_ID", "test-key");
  vi.stubEnv("OPENING_CONNECTION_PREVIOUS_KEYS", "{}");
  vi.stubEnv("OPENING_IMAP_ALLOWED_HOSTS", "mail.example.edu");
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  setAuthRuntimeForTests(null); await runtime?.close();
  if (f) { await f.sql`DELETE FROM workspaces WHERE id IN (${f.scope.workspaceId},${f.otherScope.workspaceId})`; await f.close(); }
});
describe("connection handlers", () => {
  it("requires a session and validates host, UUID and strict inputs", async () => {
    expect((await list(req("GET", undefined, ""))).status).toBe(401);
    expect((await createImap(req("POST", { ...setup(), host: "169.254.169.254" }))).status).toBe(400);
    expect((await createImap(req("POST", { ...setup(), host: "user:password@mail.example.edu/path" }))).status).toBe(400);
    expect((await createImap(req("POST", { ...setup(), secret }))).status).toBe(400);
    expect((await credential(req("PUT", { secret, clientKey: randomUUID() }), context("invalid"))).status).toBe(400);
  });
  it("never exposes credentials or treats requested scopes as grants", async () => {
    const response = await createDingtalk(req("POST", { label: "School notifications", requestedScopes: ["messages.read"], clientKey: randomUUID() }));
    expect(response.status).toBe(201); const c = await response.json();
    expect(c.allowedScopes).toEqual([]); expect(c.state).toBe("needs_authorization");
    // C03 durable local check: no remote probe; needs_authorization returns 200 with ok:false (not the old 503 stub).
    const checkNeedsAuth = await check(req("POST", { clientKey: randomUUID() }), context(c.id));
    expect(checkNeedsAuth.status).toBe(200);
    expect(await checkNeedsAuth.json()).toMatchObject({
      ok: false,
      kind: "dingtalk",
      status: "needs_authorization",
      allowedScopes: [],
    });
    const needsAuth = await sync(req("POST", { clientKey: randomUUID() }), context(c.id));
    expect(needsAuth.status).toBe(200);
    expect(await needsAuth.json()).toMatchObject({ status: "needs_authorization", imported: 0, skipped: 0, allowedScopes: [] });
    const text = await (await list(req("GET"))).text(); expect(text).not.toContain(secret); expect(text).not.toContain("ciphertext");

    await f.sql`UPDATE opening_connections SET state='ready', allowed_scopes=${f.sql.array(["messages.read"])} WHERE id=${c.id}`;
    const ready = await sync(req("POST", { clientKey: randomUUID() }), context(c.id));
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({

      status: "unsupported_history_read",
      imported: 0,
      skipped: 0,
      allowedScopes: ["messages.read"],
    });
  });
  it("fails closed without a key and does not mutate the connection", async () => {
    const c = await create(); vi.stubEnv("OPENING_CONNECTION_KEY", "");
    const response = await credential(req("PUT", { secret, clientKey: randomUUID() }), context(c.id));
    expect(response.status).toBe(503); expect(await response.text()).not.toContain(secret);
    expect((await createOpeningConnectionsRepository(f.sql).get(f.scope, c.id)).version).toBe(0);
  });
  it("rejects a foreign workspace and owner", async () => {
    const repo = createOpeningConnectionsRepository(f.sql);
    const c = await repo.createImap(f.otherScope, { ...setup(), tlsMode: "implicit" });
    expect((await credential(req("PUT", { secret, clientKey: randomUUID() }), context(c.id))).status).toBe(404);
    expect((await revoke(req("POST", { expectedVersion: 0, clientKey: randomUUID() }), context(c.id))).status).toBe(404);
  });
  it("stores only ciphertext, replays across key rotation, excludes backups and revokes", async () => {
    const c = await create(); const key = randomUUID();
    expect((await credential(req("PUT", { secret, clientKey: key }), context(c.id))).status).toBe(204);
    const [stored] = await f.sql`SELECT * FROM opening_connection_credentials WHERE connection_id=${c.id}`;
    expect(stored!.ciphertext.toString()).not.toContain(secret);
    expect(decryptConnectionCredential({ workspaceId: f.scope.workspaceId, connectionId: c.id, keyId: stored!.key_id, nonce: stored!.nonce, ciphertext: stored!.ciphertext, authTag: stored!.auth_tag, payloadHash: stored!.payload_hash })).toBe(secret);
    vi.stubEnv("OPENING_CONNECTION_PREVIOUS_KEYS", JSON.stringify({ "test-key": process.env.OPENING_CONNECTION_KEY }));
    vi.stubEnv("OPENING_CONNECTION_KEY", Buffer.alloc(32, 8).toString("base64")); vi.stubEnv("OPENING_CONNECTION_KEY_ID", "next-key");
    expect((await credential(req("PUT", { secret, clientKey: key }), context(c.id))).status).toBe(204);
    expect((await credential(req("PUT", { secret: "changed", clientKey: key }), context(c.id))).status).toBe(409);
    const repo = createOpeningConnectionsRepository(f.sql); expect((await repo.get(f.scope, c.id)).version).toBe(1);
    const backup = await readOpeningBackupRecords(f.sql, f.scope);
    expect(JSON.stringify(backup)).not.toContain(secret); expect(Object.keys(backup.tables)).not.toContain("opening_connection_credentials");
    const revokeKey = randomUUID();
    expect((await revoke(req("POST", { expectedVersion: 0, clientKey: revokeKey }), context(c.id))).status).toBe(409);
    expect((await revoke(req("POST", { expectedVersion: 1, clientKey: revokeKey }), context(c.id))).status).toBe(200);
    expect((await revoke(req("POST", { expectedVersion: 1, clientKey: revokeKey }), context(c.id))).status).toBe(200);
    expect((await credential(req("PUT", { secret, clientKey: randomUUID() }), context(c.id))).status).toBe(409);
    expect(await f.sql`SELECT 1 FROM opening_connection_credentials WHERE connection_id=${c.id}`).toHaveLength(0);
  });
  it("rejects revoked IMAP check and sync with 409 without calling a remote adapter stub message", async () => {
    const c = await create();
    const key = randomUUID();
    expect((await credential(req("PUT", { secret, clientKey: key }), context(c.id))).status).toBe(204);
    const ready = await createOpeningConnectionsRepository(f.sql).get(f.scope, c.id);
    expect((await revoke(req("POST", { expectedVersion: ready.version, clientKey: randomUUID() }), context(c.id))).status).toBe(200);
    const checkResponse = await check(req("POST", { clientKey: randomUUID() }), context(c.id));
    expect(checkResponse.status).toBe(409);
    const checkBody = await checkResponse.json();
    expect(checkBody.error?.code).toBe("CONFLICT");
    expect(JSON.stringify(checkBody)).not.toContain("连接适配器尚未实现");
    const syncResponse = await sync(req("POST", { clientKey: randomUUID() }), context(c.id));
    expect(syncResponse.status).toBe(409);
    const syncBody = await syncResponse.json();
    expect(syncBody.error?.code).toBe("CONFLICT");
    expect(JSON.stringify(syncBody)).not.toContain("连接适配器尚未实现");
  });
});
