import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, createSqlClient, hashSessionToken } from "@aistudy/database";
import { GET as getCandidates } from "../../../apps/web/src/app/api/opening/candidates/route";
import { DELETE as cancelJob, GET as getJob } from "../../../apps/web/src/app/api/opening/jobs/[id]/route";
import { GET as getPendingJob } from "../../../apps/web/src/app/api/opening/conversations/[id]/pending-job/route";
import { POST as submitTurn } from "../../../apps/web/src/app/api/opening/turns/route";
import { POST as createConversation } from "../../../apps/web/src/app/api/opening/conversations/route";
import { POST as register } from "../../../apps/web/src/app/api/auth/register/route";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for tutor handler tests");
}

const cookieName = "aistudy_session";
const sql = createSqlClient(databaseUrl);
let runtime: ReturnType<typeof createAuthRuntime> | undefined;
let cookie: string;

function request(path: string) {
  return new Request(`http://localhost${path}`, {
    headers: { cookie },
  });
}

async function registerOwner(): Promise<string> {
  const response = await register(new Request("http://localhost/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: `${randomUUID()}@example.com`,
      password: "password123",
      displayName: "Tutor Handler",
    }),
  }));
  expect(response.status).toBe(201);
  return response.headers.get("set-cookie")!.match(/aistudy_session=([^;]+)/)![1];
}

beforeAll(async () => {
  await applyMigrations(sql);
  runtime = createAuthRuntime({
    databaseUrl,
    authSecret: "opening-tutor-handler-secret-32chars!",
    sessionCookieSecure: false,
    sessionTtlSeconds: 3600,
    authCookieName: cookieName,
  });
  setAuthRuntimeForTests(runtime);
  cookie = `aistudy_session=${await registerOwner()}`;
});

beforeEach(async () => {
  await sql`TRUNCATE opening_assistant_candidates, opening_tutor_jobs, opening_turns, opening_source_chunks, opening_sources, opening_conversations, opening_budget_reservations RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await runtime?.close();
  await sql.end({ timeout: 5 });
});

describe("opening tutor polling handlers", () => {
  it("returns an empty pending candidate list for the owner", async () => {
    const response = await getCandidates(request("/api/opening/candidates"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it("returns 401 without a session", async () => {
    const response = await getCandidates(new Request("http://localhost/api/opening/candidates"));
    expect(response.status).toBe(401);
  });

  it("returns an empty pending-job discovery result for the owner", async () => {
    const conversationId = randomUUID();
    await sql`
      INSERT INTO opening_conversations (id, workspace_id, owner_user_id, title)
      SELECT ${conversationId}, w.id, w.owner_user_id, 'empty pending'
      FROM workspaces w
      JOIN sessions s ON s.user_id = w.owner_user_id
      WHERE s.token_hash = ${hashSessionToken(cookie.slice(`${cookieName}=`.length))}
    `;

    const response = await getPendingJob(request(`/api/opening/conversations/${conversationId}/pending-job`), {
      params: Promise.resolve({ id: conversationId }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toBeNull();
  });

  it("returns 404 for an unknown job id", async () => {
    const response = await getJob(request(`/api/opening/jobs/${randomUUID()}`), {
      params: Promise.resolve({ id: randomUUID() }),
    });
    expect(response.status).toBe(404);
  });

  it("cancels an owner job and marks its pending assistant turn failed", async () => {
    const conversationResponse = await createConversation(new Request("http://localhost/api/opening/conversations", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "cancel me", courseId: null }),
    }));
    const conversation = await conversationResponse.json() as { id: string };
    const submitted = await submitTurn(new Request("http://localhost/api/opening/turns", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        conversationId: conversation.id,
        text: "cancel this",
        sourceIds: [],
        mode: "explain",
        clientKey: `cancel-${randomUUID()}`,
        privacy: "saved",
      }),
    }));
    expect(submitted.status).toBe(201);
    const ids = await submitted.json() as { jobId: string };
    const response = await cancelJob(request(`/api/opening/jobs/${ids.jobId}`), {
      params: Promise.resolve({ id: ids.jobId }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "cancelled" });
    const turns = await sql`
      SELECT status FROM opening_turns
      WHERE conversation_id = ${conversation.id} AND role = 'assistant'
    `;
    expect(turns[0]?.status).toBe("failed");
  });

  it("returns 404 for a job owned by another user in the same workspace", async () => {
    const sessionToken = cookie.slice(`${cookieName}=`.length);
    const workspaceId = (await sql`
      SELECT w.id AS workspace_id
      FROM sessions s JOIN workspaces w ON w.owner_user_id = s.user_id
      WHERE s.token_hash = ${hashSessionToken(sessionToken)}
    `)[0].workspace_id as string;
    const conversationId = randomUUID();
    const userTurnId = randomUUID();
    const assistantTurnId = randomUUID();
    const jobId = randomUUID();
    await sql`
      INSERT INTO opening_conversations (id, workspace_id, owner_user_id, title)
      VALUES (${conversationId}, ${workspaceId}, ${randomUUID()}, 'foreign owner')
    `;
    await sql`
      INSERT INTO opening_turns (id, workspace_id, conversation_id, role, text, mode, status)
      VALUES
        (${userTurnId}, ${workspaceId}, ${conversationId}, 'user', 'question', 'explain', 'complete'),
        (${assistantTurnId}, ${workspaceId}, ${conversationId}, 'assistant', '', 'explain', 'pending')
    `;
    await sql`
      INSERT INTO opening_tutor_jobs (id, workspace_id, conversation_id, user_turn_id, assistant_turn_id, status, mode)
      VALUES (${jobId}, ${workspaceId}, ${conversationId}, ${userTurnId}, ${assistantTurnId}, 'queued', 'explain')
    `;

    const insertedJob = await sql`
      SELECT id FROM opening_tutor_jobs
      WHERE id = ${jobId} AND workspace_id = ${workspaceId}
    `;
    expect(insertedJob).toHaveLength(1);

    const response = await getJob(request(`/api/opening/jobs/${jobId}`), {
      params: Promise.resolve({ id: jobId }),
    });

    const pendingResponse = await getPendingJob(request(`/api/opening/conversations/${conversationId}/pending-job`), {
      params: Promise.resolve({ id: conversationId }),
    });
    expect(pendingResponse.status).toBe(200);
    await expect(pendingResponse.json()).resolves.toBeNull();

    expect(response.status).toBe(404);
  });

  it("returns 409 when a saved client key is reused for a different intent", async () => {
    const conversationResponse = await createConversation(new Request("http://localhost/api/opening/conversations", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "turn conflict", courseId: null }),
    }));
    expect(conversationResponse.status).toBe(201);
    const conversation = await conversationResponse.json() as { id: string };
    const body = {
      conversationId: conversation.id,
      text: "same request",
      sourceIds: [],
      mode: "explain",
      clientKey: `client-${randomUUID()}`,
      privacy: "saved",
    };
    const first = await submitTurn(new Request("http://localhost/api/opening/turns", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
    expect(first.status).toBe(201);

    const conflict = await submitTurn(new Request("http://localhost/api/opening/turns", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ ...body, text: "changed request" }),
    }));
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ error: { code: "CONFLICT" } });
  });

  it("returns 500 when pending-job discovery fails instead of an empty job", async () => {
    const conversationId = randomUUID();
    await sql`
      INSERT INTO opening_conversations (id, workspace_id, owner_user_id, title)
      SELECT ${conversationId}, w.id, w.owner_user_id, 'pending lookup'
      FROM workspaces w
      JOIN sessions s ON s.user_id = w.owner_user_id
      WHERE s.token_hash = ${hashSessionToken(cookie.slice(`${cookieName}=`.length))}
    `;
    await sql`ALTER TABLE opening_tutor_jobs RENAME TO opening_tutor_jobs_rp3`;
    try {
      const response = await getPendingJob(request(`/api/opening/conversations/${conversationId}/pending-job`), {
        params: Promise.resolve({ id: conversationId }),
      });
      expect(response.status).toBeGreaterThanOrEqual(500);
      const body = await response.json() as { error?: { code?: string } } | null;
      expect(body).not.toBeNull();
    } finally {
      await sql`ALTER TABLE opening_tutor_jobs_rp3 RENAME TO opening_tutor_jobs`;
    }
  });

  it("replays one client key once and conflicts when page or chunk differs", async () => {
    const conversationResponse = await createConversation(new Request("http://localhost/api/opening/conversations", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "rp3 replay", courseId: null }),
    }));
    expect(conversationResponse.status).toBe(201);
    const conversation = await conversationResponse.json() as { id: string };
    const body = {
      conversationId: conversation.id,
      text: "same page request",
      sourceIds: [] as string[],
      mode: "explain",
      clientKey: `client-${randomUUID()}`,
      privacy: "saved",
      currentPage: null,
      chunkId: null,
    };
    const first = await submitTurn(new Request("http://localhost/api/opening/turns", {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    expect(first.status).toBe(201);
    const created = await first.json() as { jobId: string; turnId: string };

    const replay = await submitTurn(new Request("http://localhost/api/opening/turns", {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    expect(replay.status).toBe(201);
    await expect(replay.json()).resolves.toEqual(created);

    const pageConflict = await submitTurn(new Request("http://localhost/api/opening/turns", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ ...body, text: "different page wording" }),
    }));
    expect(pageConflict.status).toBe(409);

    const jobs = await sql`SELECT count(*)::int AS count FROM opening_tutor_jobs WHERE conversation_id = ${conversation.id}`;
    const turns = await sql`SELECT count(*)::int AS count FROM opening_turns WHERE conversation_id = ${conversation.id} AND client_key = ${body.clientKey}`;
    expect(jobs[0].count).toBe(1);
    expect(turns[0].count).toBe(1);
  });
});
