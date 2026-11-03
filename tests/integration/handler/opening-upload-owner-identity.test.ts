import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createSqlClient } from "@aistudy/database";
import { createOpeningTestStorage, pdfBytes } from "../opening-storage-fixture";
import { POST as register } from "../../../apps/web/src/app/api/auth/register/route";
import { GET as me } from "../../../apps/web/src/app/api/auth/me/route";
import { POST as begin } from "../../../apps/web/src/app/api/opening/sources/route";
import { POST as complete } from "../../../apps/web/src/app/api/opening/sources/[id]/complete/route";
import { POST as refresh } from "../../../apps/web/src/app/api/opening/sources/[id]/upload-ticket/route";
import { PUT as staging } from "../../../apps/web/src/app/api/opening/sources/[id]/staging/route";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import { publishVerifiedSessionIdentity, type SessionIdentity } from "../../../apps/web/src/features/auth/session-identity";
import { createOpeningApi, resolveUploadPutUrl } from "../../../apps/web/src/features/opening/client/api";
import { createUploadClient } from "../../../apps/web/src/features/opening/inbox/upload-client";
import { createUploadQueue } from "../../../apps/web/src/features/opening/inbox/upload-queue";

const databaseUrl = process.env.DATABASE_URL!;
const sql = createSqlClient(databaseUrl);
const storage = createOpeningTestStorage();
const runtime = createAuthRuntime({ databaseUrl, authSecret: "upload-owner-regression-secret-32chars!!", sessionCookieSecure: false, sessionTtlSeconds: 3600, authCookieName: "aistudy_session" });
const users: Array<{ cookie: string; identity: SessionIdentity }> = [];
const keys: string[] = [];
let cookie = "";
let release: (() => void) | undefined;
let dropBegin = true;
const statuses: number[] = [];
const nativeFetch = globalThis.fetch;
const transport: typeof fetch = async (input, init) => {
  const path = String(input);
  if (!path.startsWith("/api/")) return nativeFetch(input, init);
  if (path === "/api/opening/sources" && dropBegin) { dropBegin = false; throw new TypeError("begin never delivered"); }
  const headers = new Headers(init?.headers);
  headers.set("cookie", cookie);
  const request = new Request(`http://localhost${path}`, { ...init, headers });
  const id = path.split("/")[4]!;
  const context = { params: Promise.resolve({ id }) };
  const response = path === "/api/auth/me" ? await me(request)
    : path === "/api/opening/sources" ? await begin(request)
      : path.endsWith("/complete") ? await complete(request, context)
        : path.endsWith("/upload-ticket") ? await refresh(request, context)
          : await staging(request, context);
  statuses.push(response.status);
  console.info("upload boundary", path, response.status);
  return response;
};

beforeAll(async () => {
  setAuthRuntimeForTests(runtime);
  for (let i = 0; i < 2; i++) {
    const response = await register(new Request("http://localhost/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: `owner-${randomUUID()}@example.com`, password: "password123", displayName: "Owner regression" }) }));
    expect(response.status).toBe(201);
    const body = await response.json() as { user: SessionIdentity };
    users.push({ cookie: response.headers.get("set-cookie")!.split(";")[0]!, identity: body.user });
  }
  // Keep JWT/WebCrypto in Node's realm; only install the window needed by the verified identity store.
  vi.stubGlobal("window", Object.assign(new EventTarget(), { location: new URL("http://localhost/opening") }));
  vi.stubGlobal("fetch", transport);
});
afterAll(async () => {
  release?.(); vi.unstubAllGlobals();
  for (const key of keys) await storage.deleteObject(key);
  for (const { identity } of users) {
    await sql`DELETE FROM opening_outbox WHERE workspace_id = ${identity.workspaceId}`;
    await sql`DELETE FROM opening_jobs WHERE workspace_id = ${identity.workspaceId}`;
    await sql`DELETE FROM opening_sources WHERE workspace_id = ${identity.workspaceId}`;
  }
  setAuthRuntimeForTests(null); await runtime.close(); await sql.end({ timeout: 5 });
});

it("retains A's undelivered upload across B login and resumes the same operation only as A", async () => {
  const [a, b] = users;
  cookie = a!.cookie;
  const verified = await transport("/api/auth/me");
  expect(verified.status).toBe(200);
  release = publishVerifiedSessionIdentity((await verified.json() as { user: SessionIdentity }).user);
  const api = createOpeningApi(transport);
  const client = createUploadClient({ begin: api.beginUpload, complete: api.completeUpload, refreshTicket: api.refreshUploadTicket, resolvePutUrl: resolveUploadPutUrl,
    put: async (url, bytes, _progress, mime, identity) => {
      // The production PUT transport receives the same expected identity as JSON boundaries.
      const response = await transport(url, { method: "PUT", headers: { "content-type": mime, ...(identity ? { "x-upload-user-id": identity.id, "x-upload-workspace-id": identity.workspaceId } : {}) }, body: bytes });
      if (!response.ok) throw new Error(`PUT ${response.status}`);
    } });
  const file = { name: "private-a.pdf", type: "application/pdf", bytes: new Uint8Array(pdfBytes) };
  const queue = createUploadQueue(client, [file]);
  const uploadId = queue.items[0]!.id;
  keys.push(storage.stagingKey(uploadId), storage.finalKey(uploadId, 0));
  await queue.start();
  expect(queue.items[0]!.state).toBe("failed");
  expect(await sql`SELECT id FROM opening_sources WHERE id = ${uploadId}`).toHaveLength(0);
  cookie = b!.cookie;
  await queue.retry(uploadId);
  expect(queue.items[0]!.state).toBe("failed");
  expect(queue.items[0]!.file.bytes).toEqual(file.bytes);
  expect(await sql`SELECT id FROM opening_sources WHERE workspace_id = ${b!.identity.workspaceId}`).toHaveLength(0);
  expect(await sql`SELECT id FROM opening_jobs WHERE workspace_id = ${b!.identity.workspaceId}`).toHaveLength(0);
  expect(statuses).not.toContain(401);
  // A verified preflight can race a cookie change: each real HTTP boundary must reject B.
  const expectedHeaders = { "x-upload-user-id": a!.identity.id, "x-upload-workspace-id": a!.identity.workspaceId };
  const input = { name: file.name, mime: "application/pdf" as const, bytes: file.bytes.length, sha256: await (await import("../../../apps/web/src/features/opening/inbox/upload-client")).sha256Hex(file.bytes), uploadId };
  expect((await transport("/api/opening/sources", { method: "POST", headers: expectedHeaders, body: JSON.stringify(input) })).status).toBe(409);
  expect((await storage.headObject(storage.stagingKey(uploadId))).exists).toBe(false);
  console.info("no B object");
  cookie = a!.cookie;
  const first = await api.beginUpload(input, a!.identity);
  const replay = await api.beginUpload(input, a!.identity);
  expect(replay.source.id).toBe(first.source.id);
  cookie = b!.cookie;
  for (const suffix of ["staging", "complete", "upload-ticket"]) {
    expect((await transport(`/api/opening/sources/${uploadId}/${suffix}`, { method: suffix === "staging" ? "PUT" : "POST", headers: expectedHeaders, body: suffix === "staging" ? file.bytes : "{}" })).status).toBe(409);
  }
  // Supplying B as expected identity cannot grant B access to A's existing ticket.
  await expect(api.refreshUploadTicket(uploadId, b!.identity)).rejects.toMatchObject({ status: 404 });
  cookie = a!.cookie;
  await queue.retry(uploadId);
  expect(queue.items[0]).toMatchObject({ id: uploadId, state: "saved", source: { id: uploadId, uploadState: "uploaded" } });
  const rows = await sql`SELECT id FROM opening_sources WHERE workspace_id = ${a!.identity.workspaceId}`;
  expect(rows).toHaveLength(1);
  expect(await sql`SELECT id FROM opening_jobs WHERE workspace_id = ${a!.identity.workspaceId}`).toHaveLength(1);
});
