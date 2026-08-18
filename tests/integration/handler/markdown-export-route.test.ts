import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, createSqlClient } from "@aistudy/database";
import { POST as register } from "../../../apps/web/src/app/api/auth/register/route";
import { POST as createDocument } from "../../../apps/web/src/app/api/documents/route";
import { POST as exportMarkdown } from "../../../apps/web/src/app/api/exports/markdown/route";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for markdown export handler tests");
}

const cookieName = "aistudy_session";

function request(path: string, method: string, cookie?: string, body?: unknown) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("markdown export route", () => {
  const sql = createSqlClient(databaseUrl);
  let runtime: ReturnType<typeof createAuthRuntime> | undefined;

  beforeAll(async () => {
    await applyMigrations(sql);
    runtime = createAuthRuntime({
      databaseUrl,
      authSecret: "markdown-export-handler-secret-32ch",
      sessionCookieSecure: false,
      sessionTtlSeconds: 3600,
      authCookieName: cookieName,
    });
    setAuthRuntimeForTests(runtime);
  });

  beforeEach(async () => {
    await sql`TRUNCATE learning_events, card_review_states, cards, sessions, workspaces, users RESTART IDENTITY CASCADE`;
  });

  afterAll(async () => {
    setAuthRuntimeForTests(null);
    await runtime?.close();
    await sql.end({ timeout: 5 });
  });

  async function user(label: string) {
    const response = await register(
      request("/api/auth/register", "POST", undefined, {
        email: `${label}-${randomUUID()}@example.com`,
        password: "password123",
        displayName: label,
      }),
    );
    const token = response.headers.get("set-cookie")!.match(/aistudy_session=([^;]+)/)![1];
    return `${cookieName}=${token}`;
  }

  it("requires authentication and derives workspace from the session", async () => {
    expect((await exportMarkdown(request("/api/exports/markdown", "POST"))).status).toBe(401);
    const cookie = await user("owner");
    const created = await createDocument(
      request("/api/documents", "POST", cookie, {
        title: "导数笔记",
        blocks: [{ id: randomUUID(), type: "paragraph", content: { text: "极限定义" } }],
      }),
    );
    const documentId = (await created.json() as { document: { id: string } }).document.id;
    const exported = await exportMarkdown(
      request("/api/exports/markdown", "POST", cookie, {
        documentId,
        workspaceId: randomUUID(),
      }),
    );
    expect(exported.status).toBe(200);
    const body = await exported.json() as {
      format: string;
      markdown: string;
      manifest: { blockIdentities: Array<{ blockId: string }> };
      lossReport: { claimedLossless: boolean };
    };
    expect(body.format).toBe("markdown");
    expect(body.lossReport.claimedLossless).toBe(false);
    expect(body.markdown).toContain("极限定义");
    expect(body.manifest.blockIdentities.length).toBeGreaterThan(0);
  });

  it("rejects exporting a document from another workspace", async () => {
    const owner = await user("owner");
    const other = await user("other");
    const created = await createDocument(
      request("/api/documents", "POST", owner, {
        title: "私有笔记",
        blocks: [{ id: randomUUID(), type: "paragraph", content: { text: "secret" } }],
      }),
    );
    const documentId = (await created.json() as { document: { id: string } }).document.id;
    const denied = await exportMarkdown(
      request("/api/exports/markdown", "POST", other, { documentId, workspaceId: randomUUID() }),
    );
    expect(denied.status).toBe(403);
  });
});
