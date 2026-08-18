import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, createSqlClient } from "@aistudy/database";
import { POST as register } from "../../../apps/web/src/app/api/auth/register/route";
import { POST as createCard } from "../../../apps/web/src/app/api/cards/route";
import { POST as exportAnki } from "../../../apps/web/src/app/api/exports/anki/route";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for anki export handler tests");
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

describe("anki export route", () => {
  const sql = createSqlClient(databaseUrl);
  let runtime: ReturnType<typeof createAuthRuntime> | undefined;

  beforeAll(async () => {
    await applyMigrations(sql);
    runtime = createAuthRuntime({
      databaseUrl,
      authSecret: "anki-export-handler-secret-at-least-32",
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
    expect((await exportAnki(request("/api/exports/anki", "POST"))).status).toBe(401);
    const cookie = await user("owner");
    const created = await createCard(
      request("/api/cards", "POST", cookie, { front: "导数", back: "极限定义", tags: ["高数"] }),
    );
    const cardId = (await created.json() as { card: { id: string } }).card.id;
    const exported = await exportAnki(
      request("/api/exports/anki", "POST", cookie, { cardId, workspaceId: randomUUID() }),
    );
    expect(exported.status).toBe(200);
    const body = await exported.json() as {
      format: string;
      notes: Array<{ fields: { Front: string } }>;
      lossReport: { claimedLossless: boolean };
      ankiTsv: string;
    };
    expect(body.format).toBe("anki");
    expect(body.lossReport.claimedLossless).toBe(false);
    expect(body.notes[0]?.fields.Front).toBe("导数");
    expect(body.ankiTsv).toContain("极限定义");
  });

  it("rejects exporting a card from another workspace", async () => {
    const owner = await user("owner");
    const other = await user("other");
    const created = await createCard(
      request("/api/cards", "POST", owner, { front: "私有", back: "secret", tags: ["x"] }),
    );
    const cardId = (await created.json() as { card: { id: string } }).card.id;
    const denied = await exportAnki(
      request("/api/exports/anki", "POST", other, { cardId, workspaceId: randomUUID() }),
    );
    expect(denied.status).toBe(404);
  });
});
