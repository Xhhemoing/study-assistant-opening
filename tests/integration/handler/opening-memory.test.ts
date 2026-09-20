import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, createSqlClient } from "@aistudy/database";
import { GET as listMemory, POST as proposeMemory } from "../../../apps/web/src/app/api/opening/memory/route";
import { POST as decideMemory } from "../../../apps/web/src/app/api/opening/memory/[id]/decision/route";
import { POST as register } from "../../../apps/web/src/app/api/auth/register/route";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for memory handler tests");

const cookieName = "aistudy_session";
const sql = createSqlClient(databaseUrl);
let runtime: ReturnType<typeof createAuthRuntime> | undefined;
let cookie: string;
let otherCookie: string;

function req(
  path: string,
  method = "GET",
  body?: unknown,
  extraHeaders?: Record<string, string>,
  authCookie = cookie,
) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      ...(authCookie ? { cookie: authCookie } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function registerUser(label: string): Promise<string> {
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
  return `${cookieName}=${response.headers.get("set-cookie")!.match(/aistudy_session=([^;]+)/)![1]}`;
}

beforeAll(async () => {
  await applyMigrations(sql);
  runtime = createAuthRuntime({
    databaseUrl,
    authSecret: "opening-memory-handler-secret-32chars!!",
    sessionCookieSecure: false,
    sessionTtlSeconds: 3600,
    authCookieName: cookieName,
  });
  setAuthRuntimeForTests(runtime);
  cookie = await registerUser("owner");
  otherCookie = await registerUser("other");
});

beforeEach(async () => {
  await sql`TRUNCATE opening_memories RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  setAuthRuntimeForTests(null);
  await runtime?.close();
  await sql.end({ timeout: 5 });
});

describe("opening memory handlers", () => {
  it("returns 401 without a session", async () => {
    const response = await listMemory(req("/api/opening/memory", "GET", undefined, undefined, ""));
    expect(response.status).toBe(401);
  });

  it("rejects model/worker callers on decision", async () => {
    const created = await proposeMemory(req("/api/opening/memory", "POST", { text: "hint style" }));
    expect(created.status).toBe(201);
    const item = await created.json() as { id: string; version: number };
    const denied = await decideMemory(
      req(`/api/opening/memory/${item.id}/decision`, "POST", {
        expectedVersion: item.version,
        action: "confirm",
        clientKey: "decision-worker-1",
      }, { "x-opening-caller": "worker" }),
      { params: Promise.resolve({ id: item.id }) },
    );
    expect(denied.status).toBe(403);
  });

  it("proposes candidates that are not facts; confirm once; idempotent clientKey", async () => {
    const created = await proposeMemory(req("/api/opening/memory", "POST", {
      text: "喜欢提示",
      sourceTurnIds: [],
    }));
    expect(created.status).toBe(201);
    const item = await created.json() as {
      id: string; kind: string; version: number; why: string[]; when: string;
    };
    expect(item.kind).toBe("candidate");
    expect(item.when).toBeTruthy();
    expect(Array.isArray(item.why)).toBe(true);

    const listed = await listMemory(req("/api/opening/memory"));
    const body = await listed.json() as { context: unknown[]; review: Array<{ id: string }> };
    expect(body.context).toEqual([]);
    expect(body.review.map((r) => r.id)).toEqual([item.id]);

    const first = await decideMemory(
      req(`/api/opening/memory/${item.id}/decision`, "POST", {
        expectedVersion: item.version,
        action: "confirm",
        clientKey: "decision-confirm-1",
      }),
      { params: Promise.resolve({ id: item.id }) },
    );
    expect(first.status).toBe(200);
    const confirmed = await first.json() as { kind: string; version: number };
    expect(confirmed.kind).toBe("confirmed");

    const again = await decideMemory(
      req(`/api/opening/memory/${item.id}/decision`, "POST", {
        expectedVersion: item.version,
        action: "confirm",
        clientKey: "decision-confirm-1",
      }),
      { params: Promise.resolve({ id: item.id }) },
    );
    expect(again.status).toBe(200);
    expect((await again.json() as { version: number }).version).toBe(confirmed.version);

    const after = await listMemory(req("/api/opening/memory"));
    const afterBody = await after.json() as { context: Array<{ id: string }>; review: unknown[] };
    expect(afterBody.review).toEqual([]);
    expect(afterBody.context.map((c) => c.id)).toEqual([item.id]);
  });

  it("returns 409 on stale expectedVersion", async () => {
    const created = await proposeMemory(req("/api/opening/memory", "POST", { text: "stale check" }));
    const item = await created.json() as { id: string; version: number };
    const stale = await decideMemory(
      req(`/api/opening/memory/${item.id}/decision`, "POST", {
        expectedVersion: item.version + 5,
        action: "confirm",
        clientKey: "decision-stale-1",
      }),
      { params: Promise.resolve({ id: item.id }) },
    );
    expect(stale.status).toBe(409);
  });

  it("returns 404 for cross-workspace decision", async () => {
    const created = await proposeMemory(req("/api/opening/memory", "POST", { text: "private" }));
    const item = await created.json() as { id: string; version: number };
    const denied = await decideMemory(
      req(`/api/opening/memory/${item.id}/decision`, "POST", {
        expectedVersion: item.version,
        action: "confirm",
        clientKey: "decision-cross-1",
      }, undefined, otherCookie),
      { params: Promise.resolve({ id: item.id }) },
    );
    expect(denied.status).toBe(404);
  });

  it("suppresses equivalent re-proposal after reject", async () => {
    const turn = randomUUID();
    const created = await proposeMemory(req("/api/opening/memory", "POST", {
      text: "same text",
      sourceTurnIds: [turn],
    }));
    const item = await created.json() as { id: string; version: number };
    const rejected = await decideMemory(
      req(`/api/opening/memory/${item.id}/decision`, "POST", {
        expectedVersion: item.version,
        action: "reject",
        clientKey: "decision-reject-1",
      }),
      { params: Promise.resolve({ id: item.id }) },
    );
    expect(rejected.status).toBe(200);
    const again = await proposeMemory(req("/api/opening/memory", "POST", {
      text: "same text",
      sourceTurnIds: [turn],
    }));
    expect(again.status).toBe(409);
  });
});
