import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, createSqlClient } from "@aistudy/database";
import { POST as register } from "../../../apps/web/src/app/api/auth/register/route";
import { GET as listExplorations, POST as createExploration } from "../../../apps/web/src/app/api/explorations/route";
import { GET as getExploration } from "../../../apps/web/src/app/api/explorations/[id]/route";
import { POST as createBranch } from "../../../apps/web/src/app/api/explorations/[id]/branches/route";
import { POST as createBlock } from "../../../apps/web/src/app/api/explorations/[id]/blocks/route";
import { PATCH as setStatus } from "../../../apps/web/src/app/api/explorations/[id]/status/route";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for exploration handler tests");
const authSecret = "exploration-handler-test-secret-at-least-32-characters";
const cookieName = "aistudy_session";

type Context = { params: Promise<{ id: string }> };
function cookieFrom(response: Response): string {
  const match = response.headers.get("set-cookie")?.match(new RegExp(`${cookieName}=([^;]+)`));
  if (!match) throw new Error("missing auth cookie");
  return `${cookieName}=${match[1]}`;
}
function jsonRequest(url: string, method: string, cookie?: string, body?: unknown): Request {
  return new Request(`http://localhost${url}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
}

describe("exploration handlers", () => {
  const sql = createSqlClient(databaseUrl);
  let runtime: ReturnType<typeof createAuthRuntime>;
  beforeAll(async () => {
    await applyMigrations(sql);
    runtime = createAuthRuntime({ databaseUrl, authSecret, sessionCookieSecure: false, sessionTtlSeconds: 3600, authCookieName: cookieName });
    setAuthRuntimeForTests(runtime);
  });
  beforeEach(async () => {
    await sql`TRUNCATE exploration_blocks, exploration_branches, explorations, workspace_preferences, course_asset_memberships, courses, library_properties, library_relations, library_revisions, library_blocks, library_documents, sessions, workspaces, users RESTART IDENTITY CASCADE`;
  });
  afterAll(async () => { setAuthRuntimeForTests(null); await runtime.close(); await sql.end({ timeout: 5 }); });

  async function registerAs(label: string) {
    const response = await register(jsonRequest("/api/auth/register", "POST", undefined, { email: `${label}-${randomUUID()}@example.com`, password: "password123", displayName: label }));
    expect(response.status).toBe(201);
    const body = await response.json() as { user: { workspaceId: string } };
    return { cookie: cookieFrom(response), user: body.user };
  }

  it("requires authentication and validates create input", async () => {
    expect((await listExplorations(jsonRequest("/api/explorations", "GET"))).status).toBe(401);
    const user = await registerAs("invalid");
    const response = await createExploration(jsonRequest("/api/explorations", "POST", user.cookie, { title: " " }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("VALIDATION");
  });

  it("creates, lists, details, branches, blocks, and closes/resumes using the session workspace", async () => {
    const user = await registerAs("owner");
    const createdResponse = await createExploration(jsonRequest("/api/explorations", "POST", user.cookie, { title: "Persisted", workspaceId: randomUUID() }));
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as { exploration: { id: string; workspaceId: string; rootBranch: { id: string } } };
    expect(created.exploration.workspaceId).toBe(user.user.workspaceId);
    const list = await listExplorations(jsonRequest("/api/explorations", "GET", user.cookie));
    expect((await list.json()).explorations).toHaveLength(1);
    const detail = await getExploration(jsonRequest(`/api/explorations/${created.exploration.id}`, "GET", user.cookie), { params: Promise.resolve({ id: created.exploration.id }) } satisfies Context);
    expect(detail.status).toBe(200);
    const detailBody = await detail.json() as { branches: Array<{ id: string }> };
    const branch = await createBranch(jsonRequest(`/api/explorations/${created.exploration.id}/branches`, "POST", user.cookie, { title: "Alternative", parentBranchId: detailBody.branches[0]!.id }), { params: Promise.resolve({ id: created.exploration.id }) } satisfies Context);
    expect(branch.status).toBe(201);
    const block = await createBlock(jsonRequest(`/api/explorations/${created.exploration.id}/blocks`, "POST", user.cookie, { branchId: detailBody.branches[0]!.id, kind: "hypothesis", content: "It persists", position: 0 }), { params: Promise.resolve({ id: created.exploration.id }) } satisfies Context);
    expect(block.status).toBe(201);
    expect((await setStatus(jsonRequest(`/api/explorations/${created.exploration.id}/status`, "PATCH", user.cookie, { status: "closed" }), { params: Promise.resolve({ id: created.exploration.id }) } satisfies Context)).status).toBe(200);
    expect((await setStatus(jsonRequest(`/api/explorations/${created.exploration.id}/status`, "PATCH", user.cookie, { status: "open" }), { params: Promise.resolve({ id: created.exploration.id }) } satisfies Context)).status).toBe(200);
  });

  it("denies another authenticated workspace", async () => {
    const owner = await registerAs("owner");
    const other = await registerAs("other");
    const created = await createExploration(jsonRequest("/api/explorations", "POST", owner.cookie, { title: "Private" }));
    const id = (await created.json() as { exploration: { id: string } }).exploration.id;
    const denied = await getExploration(jsonRequest(`/api/explorations/${id}`, "GET", other.cookie), { params: Promise.resolve({ id }) });
    expect(denied.status).toBe(403);
    expect((await denied.json()).error.code).toBe("WORKSPACE_FORBIDDEN");
  });
});
