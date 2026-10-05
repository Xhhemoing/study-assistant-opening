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
let owner: { userId: string; workspaceId: string };

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
  const registered = await registerUser("owner");
  owner = { userId: registered.userId, workspaceId: registered.workspaceId };
  cookie = registered.cookie;
  otherCookie = (await registerUser("other")).cookie;
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
    // Explicit manual candidate may be confirmed for display, but source-less rows never enter model context.
    expect(afterBody.context).toEqual([]);
  });

  it("corrects a confirmed memory into a new version and replays idempotently", async () => {
    const conversationId = randomUUID();
    const turnId = randomUUID();
    await sql`INSERT INTO opening_conversations (id, workspace_id, owner_user_id, title)
      VALUES (${conversationId}, ${owner.workspaceId}, ${owner.userId}, 'memory correction')`;
    await sql`INSERT INTO opening_turns (id, workspace_id, conversation_id, role, text, mode, status)
      VALUES (${turnId}, ${owner.workspaceId}, ${conversationId}, 'user', 'owned source', 'listen', 'complete')`;
    const created = await proposeMemory(req("/api/opening/memory", "POST", { text: "先看例题", sourceTurnIds: [turnId] }));
    expect(created.status).toBe(201);
    const candidate = await created.json() as { id: string; version: number };
    const confirmed = await decideMemory(req(`/api/opening/memory/${candidate.id}/decision`, "POST", {
      expectedVersion: candidate.version,
      action: "confirm",
      clientKey: "confirm-before-replace",
    }), { params: Promise.resolve({ id: candidate.id }) });
    expect(confirmed.status).toBe(200);
    const previous = await confirmed.json() as { id: string; version: number };

    const input = {
      expectedVersion: previous.version,
      action: "replace",
      clientKey: "handler-replace-memory-1",
      text: "先看定义",
      sourceTurnIds: [turnId],
    };
    const replacement = await decideMemory(req(`/api/opening/memory/${previous.id}/decision`, "POST", input), {
      params: Promise.resolve({ id: previous.id }),
    });
    expect(replacement.status).toBe(200);
    const corrected = await replacement.json() as { id: string; kind: string; version: number; status: string; text: string };
    expect(corrected).toMatchObject({ kind: "confirmed", version: previous.version + 1, status: "active", text: "先看定义" });
    expect(corrected.id).not.toBe(previous.id);

    const replay = await decideMemory(req(`/api/opening/memory/${previous.id}/decision`, "POST", input), {
      params: Promise.resolve({ id: previous.id }),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(corrected);
    const rows = await sql`SELECT id, status, text FROM opening_memories WHERE workspace_id = ${owner.workspaceId} ORDER BY created_at`;
    expect(rows).toEqual([
      expect.objectContaining({ id: previous.id, status: "superseded", text: "先看例题" }),
      expect.objectContaining({ id: corrected.id, status: "active", text: "先看定义" }),
    ]);
  });

  it("deletes source conversation text only when the user selected it", async () => {
    const conversationId = randomUUID();
    const turnId = randomUUID();
    const sourceId = randomUUID();
    await sql`INSERT INTO opening_sources (id, workspace_id, name, mime, bytes, sha256, version, upload_state, parse_state)
      VALUES (${sourceId}, ${owner.workspaceId}, 'privacy.pdf', 'application/pdf', 1, ${"c".repeat(64)}, 0, 'uploaded', 'ready')`;
    await sql`INSERT INTO opening_conversations (id, workspace_id, owner_user_id, title)
      VALUES (${conversationId}, ${owner.workspaceId}, ${owner.userId}, 'privacy deletion')`;
    await sql`INSERT INTO opening_turns (id, workspace_id, conversation_id, role, text, mode, status, source_ids)
      VALUES (${turnId}, ${owner.workspaceId}, ${conversationId}, 'user', 'private conversation text', 'listen', 'complete', ${[sourceId]})`;
    const [before] = await sql<{ privacy_epoch: number }[]>`SELECT privacy_epoch FROM workspaces WHERE id=${owner.workspaceId}`;
    const proposed = await proposeMemory(req("/api/opening/memory", "POST", {
      text: "private memory",
      sourceTurnIds: [turnId],
    }));
    expect(proposed.status).toBe(201);
    const item = await proposed.json() as { id: string; version: number };
    const confirmed = await decideMemory(req(`/api/opening/memory/${item.id}/decision`, "POST", {
      expectedVersion: item.version,
      action: "confirm",
      clientKey: "confirm-private-memory",
    }), { params: Promise.resolve({ id: item.id }) });
    expect(confirmed.status).toBe(200);
    const memory = await confirmed.json() as { version: number };

    const deleted = await decideMemory(req(`/api/opening/memory/${item.id}/decision`, "POST", {
      expectedVersion: memory.version,
      action: "delete",
      deleteSourceText: true,
      clientKey: "delete-private-memory-text",
    }), { params: Promise.resolve({ id: item.id }) });
    expect(deleted.status).toBe(200);
    const receipt = await deleted.json();
    expect(JSON.stringify(receipt)).not.toContain("private memory");
    expect(JSON.stringify(receipt)).not.toContain("private conversation text");
    const [turn] = await sql<{ text: string }[]>`SELECT text FROM opening_turns WHERE id=${turnId}`;
    const [tombstone] = await sql<{ status: string }[]>`SELECT status FROM opening_memories WHERE id=${item.id}`;
    const [after] = await sql<{ privacy_epoch: number }[]>`SELECT privacy_epoch FROM workspaces WHERE id=${owner.workspaceId}`;
    expect(turn?.text).toBe("");
    expect(tombstone?.status).toBe("deleted");
    expect(Number(after?.privacy_epoch)).toBe(Number(before?.privacy_epoch) + 1);
    expect(await sql`SELECT source_id FROM opening_privacy_exclusions WHERE workspace_id=${owner.workspaceId} AND source_id=${sourceId}`).toEqual([{ source_id: sourceId }]);
  });

  it("does not reuse a confirmation clientKey to delete the same memory", async () => {
    const created = await proposeMemory(req("/api/opening/memory", "POST", { text: "keep this memory" }));
    const item = await created.json() as { id: string; version: number };
    const confirmed = await decideMemory(req(`/api/opening/memory/${item.id}/decision`, "POST", {
      expectedVersion: item.version,
      action: "confirm",
      clientKey: "shared-decision-key-1",
    }), { params: Promise.resolve({ id: item.id }) });
    expect(confirmed.status).toBe(200);
    const memory = await confirmed.json() as { version: number };

    const reused = await decideMemory(req(`/api/opening/memory/${item.id}/decision`, "POST", {
      expectedVersion: memory.version,
      action: "delete",
      clientKey: "shared-decision-key-1",
    }), { params: Promise.resolve({ id: item.id }) });
    expect(reused.status).toBe(409);
    const [row] = await sql<{ status: string; text: string }[]>`SELECT status, text FROM opening_memories WHERE id=${item.id}`;
    expect(row).toEqual({ status: "active", text: "keep this memory" });
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
    const me = owner;
    const turn = randomUUID();
    const conversationId = randomUUID();
    await sql`
      INSERT INTO opening_conversations (id, workspace_id, owner_user_id, title)
      VALUES (${conversationId}, ${me.workspaceId}, ${me.userId}, 'memory source')`;
    await sql`
      INSERT INTO opening_turns (id, workspace_id, conversation_id, role, text, mode, status)
      VALUES (${turn}, ${me!.workspaceId}, ${conversationId}, 'user', 'source', 'explain', 'complete')`;
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
