import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createSqlClient,
} from "@aistudy/database";
import { POST as register } from "../../../apps/web/src/app/api/auth/register/route";
import { GET, PUT } from "../../../apps/web/src/app/api/workspace/preferences/route";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import { createAuthRuntime as createWebAuthRuntime } from "../../../apps/web/src/features/auth/service";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for workspace preference handler tests");
}

const AUTH_SECRET = "workspace-preferences-test-secret-at-least-32-characters";
const COOKIE = "aistudy_session";

function cookieFrom(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  const match = setCookie?.match(new RegExp(`${COOKIE}=([^;]+)`));
  if (!match) throw new Error("missing auth cookie");
  return `${COOKIE}=${match[1]}`;
}

function requestWithCookie(cookie: string, body?: unknown): Request {
  return new Request("http://localhost/api/workspace/preferences", {
    method: body === undefined ? "GET" : "PUT",
    headers: {
      cookie,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("workspace preferences handler", () => {
  const sql = createSqlClient(databaseUrl);
  let runtime: ReturnType<typeof createWebAuthRuntime>;

  beforeAll(async () => {
    await applyMigrations(sql);
    runtime = createWebAuthRuntime({
      databaseUrl,
      authSecret: AUTH_SECRET,
      sessionCookieSecure: false,
      sessionTtlSeconds: 3600,
      authCookieName: COOKIE,
    });
    setAuthRuntimeForTests(runtime);
  });

  beforeEach(async () => {
    await sql`TRUNCATE
      workspace_preferences,
      course_asset_memberships,
      courses,
      library_properties,
      library_relations,
      library_revisions,
      library_blocks,
      library_documents,
      sessions,
      workspaces,
      users
      RESTART IDENTITY CASCADE`;
  });

  afterAll(async () => {
    setAuthRuntimeForTests(null);
    await runtime.close();
    await sql.end({ timeout: 5 });
  });

  async function registerAs(label: string) {
    const response = await register(new Request("http://localhost/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: `${label}-${randomUUID()}@example.com`,
        password: "password123",
        displayName: label,
      }),
    }));
    expect(response.status).toBe(201);
    const body = await response.json() as { user: { workspaceId: string } };
    return { cookie: cookieFrom(response), workspaceId: body.user.workspaceId };
  }

  it("rejects unauthenticated reads and updates", async () => {
    await expect(GET(new Request("http://localhost/api/workspace/preferences")))
      .resolves.toMatchObject({ status: 401 });
    await expect(PUT(new Request("http://localhost/api/workspace/preferences", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ defaultEntry: "explore" }),
    }))).resolves.toMatchObject({ status: 401 });
  });

  it("returns null before a workspace has chosen an entry", async () => {
    const user = await registerAs("unset");
    const response = await GET(requestWithCookie(user.cookie));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ defaultEntry: null });
  });

  it("persists and reads the authenticated workspace preference", async () => {
    const user = await registerAs("owner");
    const updated = await PUT(requestWithCookie(user.cookie, { defaultEntry: "explore" }));

    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toEqual({ defaultEntry: "explore" });
    const current = await GET(requestWithCookie(user.cookie));
    await expect(current.json()).resolves.toEqual({ defaultEntry: "explore" });
  });

  it("ignores a body workspaceId and never updates another workspace", async () => {
    const owner = await registerAs("owner");
    const other = await registerAs("other");

    const updated = await PUT(requestWithCookie(owner.cookie, {
      defaultEntry: "library",
      workspaceId: other.workspaceId,
    }));

    expect(updated.status).toBe(200);
    const ownerCurrent = await GET(requestWithCookie(owner.cookie));
    await expect(ownerCurrent.json()).resolves.toEqual({ defaultEntry: "library" });
    const otherCurrent = await GET(requestWithCookie(other.cookie));
    await expect(otherCurrent.json()).resolves.toEqual({ defaultEntry: null });
  });

  it("rejects malformed preference updates", async () => {
    const user = await registerAs("invalid");
    const response = await PUT(requestWithCookie(user.cookie, { defaultEntry: "invalid" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VALIDATION" } });
  });
});
