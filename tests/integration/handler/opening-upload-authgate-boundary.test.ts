import { randomUUID } from "node:crypto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createSqlClient } from "@aistudy/database";
import { POST as register } from "../../../apps/web/src/app/api/auth/register/route";
import { GET as me } from "../../../apps/web/src/app/api/auth/me/route";
import { POST as begin } from "../../../apps/web/src/app/api/opening/sources/route";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import { AuthGate } from "../../../apps/web/src/features/auth/auth-gate";
import { getVerifiedSessionNamespace } from "../../../apps/web/src/features/auth/session-identity";
import { createOpeningApi } from "../../../apps/web/src/features/opening/client/api";
import { createUploadClient } from "../../../apps/web/src/features/opening/inbox/upload-client";
import { createUploadQueue } from "../../../apps/web/src/features/opening/inbox/upload-queue";

const { router } = vi.hoisted(() => ({ router: { replace: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
const databaseUrl = process.env.DATABASE_URL!;
const sql = createSqlClient(databaseUrl);
const runtime = createAuthRuntime({ databaseUrl, authSecret: "ur02-boundary-secret-32-characters!!", sessionCookieSecure: false, sessionTtlSeconds: 3600, authCookieName: "aistudy_session" });
type Account = { cookie: string; identity: { id: string; workspaceId: string } };
const accounts: Account[] = [];
let root: Root | undefined;
let dom: JSDOM | undefined;

async function account(): Promise<Account> {
  const response = await register(new Request("http://localhost/api/auth/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `ur02-boundary-${randomUUID()}@example.com`, password: "password123", displayName: "Boundary" }),
  }));
  expect(response.status, await response.clone().text()).toBe(201);
  const session = response.headers.get("set-cookie")?.match(/aistudy_session=([^;]+)/)?.[1];
  expect(session).toBeTruthy();
  const cookie = `aistudy_session=${session}`;
  const verified = await me(new Request("http://localhost/api/auth/me", { headers: { cookie } }));
  expect(verified.status).toBe(200);
  const body = await verified.json() as { user: Account["identity"] };
  return { cookie, identity: { id: body.user.id, workspaceId: body.user.workspaceId } };
}

beforeAll(async () => {
  // The existing handler globalSetup already validates the synthetic DB and migrates it.
  // Keep Node Request/WebCrypto/typed-array realms intact during real registration.
  setAuthRuntimeForTests(runtime);
  accounts.push(await account(), await account());
  console.info("UR02 boundary: real registration ready");
}, 30000);

afterAll(async () => {
  try {
    if (root) await act(async () => root!.unmount());
    expect(getVerifiedSessionNamespace()).toBeNull();
  } finally {
    dom?.window.close();
    vi.unstubAllGlobals();
    for (const user of accounts) {
      await sql`DELETE FROM opening_jobs WHERE workspace_id=${user.identity.workspaceId}`;
      await sql`DELETE FROM opening_sources WHERE workspace_id=${user.identity.workspaceId}`;
    }
    setAuthRuntimeForTests(null);
    await runtime.close();
    await sql.end({ timeout: 5 });
  }
});

it("binds real AuthGate A selection and rejects a B cookie at real begin before body consumption", async () => {
  const [a, b] = accounts;
  if (!a || !b) throw new Error("real registration did not finish");
  let cookie = a.cookie;
  let delivered: Request | undefined;
  let response: Response | undefined;
  const transport: typeof fetch = async (input, init) => {
    const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
    if (path === "/api/auth/me") return me(new Request("http://localhost/api/auth/me", { ...init, headers: { cookie } }));
    if (path !== "/api/opening/sources" || init?.method !== "POST") throw new Error(`unexpected app request: ${path}`);
    // /me verified A; only the actual authenticated begin is delivered with B's cookie.
    cookie = b.cookie;
    const headers = new Headers(init.headers);
    headers.set("cookie", cookie);
    delivered = new Request("http://localhost/api/opening/sources", { ...init, headers });
    response = await begin(delivered);
    console.info("UR02 boundary: real begin status", response.status);
    return response;
  };
  dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://localhost/opening" });
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("navigator", dom.window.navigator);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let verified!: () => void;
  const gateVerified = new Promise<void>(resolve => { verified = resolve; });
  const gateFetch: typeof fetch = async (input, init) => {
    const response = await transport(input, init);
    if (input === "/api/auth/me" && response.ok) {
      // Publication happens inside the actual AuthGate after its response.json().
      const decode = response.json.bind(response);
      response.json = async () => { const body: unknown = await decode(); verified(); return body; };
    }
    return response;
  };
  vi.stubGlobal("fetch", gateFetch);
  Object.defineProperty(dom.window, "fetch", { configurable: true, get: () => globalThis.fetch, set: value => { globalThis.fetch = value; } });
  root = createRoot(document.getElementById("root")!);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gateDeadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("AuthGate /me did not finish")), 5000);
  });
  try {
    await act(async () => {
      root!.render(createElement(AuthGate, null, createElement("span", { "data-upload-ready": true }, "ready")));
    });
    await act(async () => { await Promise.race([gateVerified, gateDeadline]); });
  } finally { if (timer) clearTimeout(timer); }
  expect(document.querySelector("[data-upload-ready]")?.textContent).toBe("ready");
  expect(getVerifiedSessionNamespace()).toBe(JSON.stringify([a.identity.id, a.identity.workspaceId]));
  console.info("UR02 boundary: actual AuthGate opened child as A");
  const api = createOpeningApi(transport);
  const client = createUploadClient({ begin: api.beginUpload, complete: api.completeUpload, put: async () => { throw new Error("negative boundary must not upload any bytes"); } });
  const file = { name: "a-private.pdf", type: "application/pdf", bytes: new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]) };
  const queue = createUploadQueue(client, [file]);
  const uploadId = queue.items[0]!.id;
  await queue.start();
  expect(delivered).toBeDefined();
  expect.soft(delivered!.headers.get("x-upload-user-id")).toBe(a.identity.id);
  expect.soft(delivered!.headers.get("x-upload-workspace-id")).toBe(a.identity.workspaceId);
  expect.soft(response?.status).toBe(409);
  expect.soft(delivered!.bodyUsed).toBe(false);
  expect.soft(queue.items[0]?.state).toBe("failed");
  expect.soft(queue.items[0]?.id).toBe(uploadId);
  expect.soft(queue.items[0]?.file.bytes).toEqual(file.bytes);
  expect.soft(await sql`SELECT id FROM opening_sources WHERE workspace_id=${b.identity.workspaceId}`).toHaveLength(0);
  expect(await sql`SELECT id FROM opening_jobs WHERE workspace_id=${b.identity.workspaceId}`).toHaveLength(0);
}, 20000);
