import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, createSqlClient } from "@aistudy/database";
import { GET as list, POST as create } from "../../../apps/web/src/app/api/documents/[id]/revision-proposals/route";
import { POST as createDocument } from "../../../apps/web/src/app/api/documents/route";
import { POST as review } from "../../../apps/web/src/app/api/revision-proposals/[id]/review/route";
import { POST as resolve } from "../../../apps/web/src/app/api/revision-proposals/[id]/resolve/route";
import { POST as register } from "../../../apps/web/src/app/api/auth/register/route";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for revision proposal handler tests");
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const request = (method: string, cookie?: string, body?: unknown) => new Request("http://localhost/api", { method, headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });

describe("revision proposal handlers", () => {
  const sql = createSqlClient(databaseUrl);
  let runtime: ReturnType<typeof createAuthRuntime>;
  beforeAll(async () => { await applyMigrations(sql); runtime = createAuthRuntime({ databaseUrl, authSecret: "revision-handler-secret-at-least-32-chars", sessionCookieSecure: false, sessionTtlSeconds: 3600, authCookieName: "aistudy_session" }); setAuthRuntimeForTests(runtime); });
  beforeEach(async () => { await sql`TRUNCATE revision_proposals, library_revisions, library_blocks, library_documents, sessions, workspaces, users RESTART IDENTITY CASCADE`; });
  afterAll(async () => { setAuthRuntimeForTests(null); await runtime.close(); await sql.end({ timeout: 5 }); });

  it("requires authentication before listing or creating", async () => {
    const response = await list(request("GET"), context(randomUUID()));
    expect(response.status).toBe(401);
  });

  it("keeps review actions principal-bound and returns malformed payload errors", async () => {
    const response = await create(request("POST", undefined, { proposedBlocks: [] }), context(randomUUID()));
    expect(response.status).toBe(401);
    const reviewResponse = await review(request("POST", undefined, { action: "accept" }), context(randomUUID()));
    expect(reviewResponse.status).toBe(401);
    const resolveResponse = await resolve(request("POST", undefined, { action: "preserve_both" }), context(randomUUID()));
    expect(resolveResponse.status).toBe(401);
  });

  it("validates malformed payloads after authentication", async () => {
    const registered = await register(request("POST", undefined, {
      email: `revision-handler-${randomUUID()}@example.com`,
      password: "password123",
      displayName: "Revision handler",
    }));
    expect(registered.status).toBe(201);
    const cookie = registered.headers.get("set-cookie")!.match(/aistudy_session=([^;]+)/)![0];

    const response = await create(request("POST", cookie, { proposedBlocks: [] }), context(randomUUID()));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VALIDATION" } });
  });

  it("denies listing a document from another authenticated workspace", async () => {
    const registerUser = async (label: string) => {
      const response = await register(request("POST", undefined, {
        email: `${label}-${randomUUID()}@example.com`,
        password: "password123",
        displayName: label,
      }));
      expect(response.status).toBe(201);
      return response.headers.get("set-cookie")!.match(/aistudy_session=([^;]+)/)![0]!;
    };
    const ownerCookie = await registerUser("revision-owner");
    const otherCookie = await registerUser("revision-other");
    const documentResponse = await createDocument(request("POST", ownerCookie, {
      title: "Owner note",
      lifecycle: "confirmed",
      blocks: [{ id: randomUUID(), type: "paragraph", content: { text: "owner" } }],
    }));
    expect(documentResponse.status).toBe(201);
    const documentId = (await documentResponse.json()).document.id as string;

    const response = await list(request("GET", otherCookie), context(documentId));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "WORKSPACE_FORBIDDEN" } });
  });
});
