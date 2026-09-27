import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, createSqlClient } from "@aistudy/database";
import { POST as acceptRetest } from "../../../apps/web/src/app/api/opening/retests/[id]/accept/route";
import { POST as register } from "../../../apps/web/src/app/api/auth/register/route";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for retest accept handler tests");

const cookieName = "aistudy_session";
const sql = createSqlClient(databaseUrl);
let runtime: ReturnType<typeof createAuthRuntime> | undefined;
let cookie: string;
let workspaceId: string;
let ownerUserId: string;

function req(path: string, body: unknown, authCookie = cookie) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      cookie: authCookie,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function insertCandidate(kind: "task" | "memory") {
  const id = randomUUID();
  const courseId = randomUUID();
  const sourceId = randomUUID();
  const payload = {
    kind,
    id,
    courseId,
    skillLabel: "fractions",
    prompt: "Retest fractions from source stem",
    sourceIds: [sourceId],
    dueAt: "2026-09-14T10:00:00.000Z",
    accepted: false,
  };
  await sql`
    INSERT INTO opening_jobs (
      id, workspace_id, owner_user_id, key, kind, payload, state
    ) VALUES (
      ${id}, ${workspaceId}, ${ownerUserId}, ${`retest:${id}`}, ${"retest"},
      ${sql.json(payload as never)}, ${"succeeded"}
    )`;
  return { id, payload };
}

beforeAll(async () => {
  await applyMigrations(sql);
  runtime = createAuthRuntime({
    databaseUrl,
    authSecret: "opening-retest-handler-secret-32ch!",
    sessionCookieSecure: false,
    sessionTtlSeconds: 3600,
    authCookieName: cookieName,
  });
  setAuthRuntimeForTests(runtime);
  const response = await register(
    new Request("http://localhost/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: `retest-${randomUUID()}@example.com`,
        password: "password123",
        displayName: "retest",
      }),
    }),
  );
  expect(response.status).toBe(201);
  cookie = `${cookieName}=${response.headers.get("set-cookie")!.match(/aistudy_session=([^;]+)/)![1]}`;
  const session = await runtime.sessions.resolve(cookie.match(/aistudy_session=([^;]+)/)![1]!);
  workspaceId = session!.workspaceId;
  ownerUserId = session!.userId;
});

beforeEach(async () => {
  await sql`TRUNCATE opening_jobs, opening_tasks, opening_plan_acceptances RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  setAuthRuntimeForTests(null);
  await runtime?.close();
  await sql.end({ timeout: 5 });
});

describe("retest accept handler", () => {
  it("creates a P02 task and consumes a kind=task candidate", async () => {
    const candidate = await insertCandidate("task");
    const response = await acceptRetest(
      req(`/api/opening/retests/${candidate.id}/accept`, { clientKey: "retest-handler-01" }),
      { params: Promise.resolve({ id: candidate.id }) },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.taskId).toEqual(expect.any(String));
    expect(body.scheduled).toBe(false);

    const tasks = await sql`SELECT title, due_at, candidate_id FROM opening_tasks`;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      title: candidate.payload.prompt,
      candidate_id: candidate.id,
    });
    expect(tasks[0]?.due_at).toBeNull();

    const jobs = await sql`SELECT payload FROM opening_jobs WHERE id = ${candidate.id}`;
    expect((jobs[0]?.payload as { accepted: boolean }).accepted).toBe(true);
  });

  it("rejects a candidate whose payload.kind is not task and does not consume it", async () => {
    const candidate = await insertCandidate("memory");
    const response = await acceptRetest(
      req(`/api/opening/retests/${candidate.id}/accept`, { clientKey: "retest-handler-02" }),
      { params: Promise.resolve({ id: candidate.id }) },
    );
    expect([400, 409]).toContain(response.status);
    const tasks = await sql`SELECT id FROM opening_tasks`;
    expect(tasks).toHaveLength(0);
    const jobs = await sql`SELECT payload FROM opening_jobs WHERE id = ${candidate.id}`;
    expect((jobs[0]?.payload as { accepted: boolean }).accepted).toBe(false);
  });

  it("replays the same clientKey and conflicts when the payload changes", async () => {
    const candidate = await insertCandidate("task");
    const first = await acceptRetest(
      req(`/api/opening/retests/${candidate.id}/accept`, { clientKey: "retest-handler-03" }),
      { params: Promise.resolve({ id: candidate.id }) },
    );
    expect(first.status).toBe(200);
    const replay = await acceptRetest(
      req(`/api/opening/retests/${candidate.id}/accept`, { clientKey: "retest-handler-03" }),
      { params: Promise.resolve({ id: candidate.id }) },
    );
    expect(replay.status).toBe(200);
    const tasks = await sql`SELECT id FROM opening_tasks`;
    expect(tasks).toHaveLength(1);

    const other = await insertCandidate("task");
    const conflict = await acceptRetest(
      req(`/api/opening/retests/${other.id}/accept`, { clientKey: "retest-handler-03" }),
      { params: Promise.resolve({ id: other.id }) },
    );
    expect(conflict.status).toBe(409);
    const still = await sql`SELECT payload FROM opening_jobs WHERE id = ${other.id}`;
    expect((still[0]?.payload as { accepted: boolean }).accepted).toBe(false);
  });
});
