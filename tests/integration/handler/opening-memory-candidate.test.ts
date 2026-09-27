import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, createSqlClient } from "@aistudy/database";
import { POST as decideCandidate } from "../../../apps/web/src/app/api/opening/candidates/[id]/memory-decision/route";
import { POST as register } from "../../../apps/web/src/app/api/auth/register/route";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import {
  insertCompleteTurn,
  insertOwnedConversation,
  insertPendingMemoryCandidate,
} from "./opening-memory-candidate-fixture";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for memory candidate handler tests");

const cookieName = "aistudy_session";
const sql = createSqlClient(databaseUrl);
let runtime: ReturnType<typeof createAuthRuntime> | undefined;
let cookie: string;
let otherCookie: string;
let owner: { userId: string; workspaceId: string };

function req(
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
  authCookie = cookie,
) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      ...(authCookie ? { cookie: authCookie } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function registerUser(label: string): Promise<{ cookie: string; userId: string; workspaceId: string }> {
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
  const body = await response.json() as { user: { id: string; workspaceId: string } };
  return {
    cookie: `${cookieName}=${response.headers.get("set-cookie")!.match(/aistudy_session=([^;]+)/)![1]}`,
    userId: body.user.id,
    workspaceId: body.user.workspaceId,
  };
}

async function seed(text = "handler fact") {
  const conversationId = await insertOwnedConversation(sql, owner);
  const sourceTurnId = await insertCompleteTurn(sql, owner, conversationId);
  const id = await insertPendingMemoryCandidate(sql, owner, { conversationId, sourceTurnId, text });
  return id;
}

beforeAll(async () => {
  await applyMigrations(sql);
  runtime = createAuthRuntime({
    databaseUrl,
    authSecret: "opening-memory-candidate-secret-32ch!!",
    sessionCookieSecure: false,
    sessionTtlSeconds: 3600,
    authCookieName: cookieName,
  });
  setAuthRuntimeForTests(runtime);
  const registered = await registerUser("candidate-owner");
  owner = { userId: registered.userId, workspaceId: registered.workspaceId };
  cookie = registered.cookie;
  otherCookie = (await registerUser("candidate-other")).cookie;
});

beforeEach(async () => {
  await sql`TRUNCATE opening_memories, opening_assistant_candidates, opening_turns, opening_conversations RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  setAuthRuntimeForTests(null);
  await runtime?.close();
  await sql.end({ timeout: 5 });
});

describe("opening memory candidate decision handler", () => {
  it("returns 401 without a session and 403 for model or worker callers", async () => {
    const id = randomUUID();
    const anonymous = await decideCandidate(
      req(`/api/opening/candidates/${id}/memory-decision`, {
        expectedVersion: 0, clientKey: "handler-anon-1", action: "confirm",
      }, undefined, ""),
      { params: Promise.resolve({ id }) },
    );
    expect(anonymous.status).toBe(401);
    const owned = await seed();
    const worker = await decideCandidate(
      req(`/api/opening/candidates/${owned}/memory-decision`, {
        expectedVersion: 0, clientKey: "handler-worker-1", action: "confirm",
      }, { "x-opening-caller": "worker" }),
      { params: Promise.resolve({ id: owned }) },
    );
    expect(worker.status).toBe(403);
  });

  it("confirms an owned candidate once and replays the same key", async () => {
    const id = await seed("owned confirm");
    const body = { expectedVersion: 0, clientKey: "handler-confirm-1", action: "confirm" };
    const first = await decideCandidate(
      req(`/api/opening/candidates/${id}/memory-decision`, body),
      { params: Promise.resolve({ id }) },
    );
    expect(first.status).toBe(200);
    const confirmed = await first.json() as { id: string; kind: string; version: number };
    expect(confirmed).toMatchObject({ id, kind: "confirmed", version: 1 });
    const again = await decideCandidate(
      req(`/api/opening/candidates/${id}/memory-decision`, body),
      { params: Promise.resolve({ id }) },
    );
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ id, version: 1 });
    const [candidate] = await sql<{ status: string }[]>`
      SELECT status FROM opening_assistant_candidates WHERE id = ${id}`;
    expect(candidate!.status).toBe("accepted");
  });

  it("returns 404 for a foreign candidate and 400 for an invalid body", async () => {
    const id = await seed("foreign");
    const foreign = await decideCandidate(
      req(`/api/opening/candidates/${id}/memory-decision`, {
        expectedVersion: 0, clientKey: "handler-foreign-1", action: "confirm",
      }, undefined, otherCookie),
      { params: Promise.resolve({ id }) },
    );
    expect(foreign.status).toBe(404);
    const invalid = await decideCandidate(
      req(`/api/opening/candidates/${id}/memory-decision`, {
        expectedVersion: 1, clientKey: "short", action: "confirm",
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(invalid.status).toBe(400);
    const [row] = await sql<{ status: string }[]>`
      SELECT status FROM opening_assistant_candidates WHERE id = ${id}`;
    expect(row!.status).toBe("pending");
  });

  it("returns 409 when a consumed candidate is replayed with another version", async () => {
    const id = await seed("stale version");
    const confirmed = await decideCandidate(
      req(`/api/opening/candidates/${id}/memory-decision`, {
        expectedVersion: 0, clientKey: "handler-stale-1", action: "confirm",
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(confirmed.status).toBe(200);
    const stale = await decideCandidate(
      req(`/api/opening/candidates/${id}/memory-decision`, {
        expectedVersion: 1, clientKey: "handler-stale-1", action: "confirm",
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(stale.status).toBe(409);
    const body = await stale.json() as { error: { code: string } };
    expect(body.error.code).toBe("CONFLICT");
  });
});
