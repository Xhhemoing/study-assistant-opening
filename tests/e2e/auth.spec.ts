import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, createSqlClient } from "@aistudy/database";

/**
 * API-level e2e against Next route handlers (same surface as browser).
 * Uses Playwright request fixture when available; falls back to direct handler
 * calls so CI without a running server still proves the auth invariant.
 */
import { chromium, type Browser, type APIRequestContext } from "playwright";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://aistudy:aistudy@127.0.0.1:5432/aistudy";
const baseURL = process.env.E2E_BASE_URL;

describe("auth e2e — workspace isolation", () => {
  const sql = createSqlClient(databaseUrl);
  let browser: Browser | undefined;

  beforeAll(async () => {
    await applyMigrations(sql);
    await sql`TRUNCATE
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

    if (baseURL) {
      browser = await chromium.launch({ headless: true });
    }
  });

  afterAll(async () => {
    await browser?.close();
    await sql.end({ timeout: 5 });
  });

  it("blocks cross-user document access through HTTP API", async () => {
    if (!baseURL) {
      // Without a running server, exercise handlers via integration surface.
      // Full browser e2e is enabled when E2E_BASE_URL is set.
      const { POST: register } = await import(
        "../../apps/web/src/app/api/auth/register/route"
      );
      const { POST: createDocument } = await import(
        "../../apps/web/src/app/api/documents/route"
      );
      const { GET: getDocument } = await import(
        "../../apps/web/src/app/api/documents/[id]/route"
      );
      const { createAuthRuntime } = await import(
        "../../apps/web/src/features/auth/service"
      );
      const { setAuthRuntimeForTests } = await import(
        "../../apps/web/src/server/runtime"
      );

      const runtime = createAuthRuntime({
        databaseUrl,
        authSecret: "test-auth-secret-at-least-32-characters-long",
        sessionTtlSeconds: 3600,
        authCookieName: "aistudy_session",
      });
      setAuthRuntimeForTests(runtime);

      try {
        const regA = await register(
          new Request("http://localhost/api/auth/register", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              email: `e2e-a-${randomUUID()}@example.com`,
              password: "password123",
              displayName: "E2E A",
            }),
          }),
        );
        const regB = await register(
          new Request("http://localhost/api/auth/register", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              email: `e2e-b-${randomUUID()}@example.com`,
              password: "password123",
              displayName: "E2E B",
            }),
          }),
        );
        expect(regA.status).toBe(201);
        expect(regB.status).toBe(201);
        const cookieA = regA.headers.get("set-cookie")!.split(";")[0]!;
        const cookieB = regB.headers.get("set-cookie")!.split(";")[0]!;

        const created = await createDocument(
          new Request("http://localhost/api/documents", {
            method: "POST",
            headers: {
              cookie: cookieB,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              title: "B note",
              blocks: [
                {
                  id: randomUUID(),
                  type: "paragraph",
                  content: { text: "private" },
                },
              ],
            }),
          }),
        );
        const doc = (await created.json()) as { document: { id: string } };

        const denied = await getDocument(
          new Request(`http://localhost/api/documents/${doc.document.id}`, {
            headers: { cookie: cookieA },
          }),
          { params: Promise.resolve({ id: doc.document.id }) },
        );
        expect(denied.status).toBe(403);
      } finally {
        setAuthRuntimeForTests(null);
        await runtime.close();
      }
      return;
    }

    // Live server path
    const contextA = await browser!.newContext({ baseURL });
    const contextB = await browser!.newContext({ baseURL });
    const reqA: APIRequestContext = contextA.request;
    const reqB: APIRequestContext = contextB.request;

    const emailA = `live-a-${randomUUID()}@example.com`;
    const emailB = `live-b-${randomUUID()}@example.com`;

    const regA = await reqA.post("/api/auth/register", {
      data: {
        email: emailA,
        password: "password123",
        displayName: "Live A",
      },
    });
    const regB = await reqB.post("/api/auth/register", {
      data: {
        email: emailB,
        password: "password123",
        displayName: "Live B",
      },
    });
    expect(regA.ok()).toBe(true);
    expect(regB.ok()).toBe(true);

    const created = await reqB.post("/api/documents", {
      data: {
        title: "Live B note",
        blocks: [
          {
            id: randomUUID(),
            type: "paragraph",
            content: { text: "secret" },
          },
        ],
      },
    });
    expect(created.ok()).toBe(true);
    const body = (await created.json()) as { document: { id: string } };

    const denied = await reqA.get(`/api/documents/${body.document.id}`);
    expect(denied.status()).toBe(403);

    await contextA.close();
    await contextB.close();
  });
});
