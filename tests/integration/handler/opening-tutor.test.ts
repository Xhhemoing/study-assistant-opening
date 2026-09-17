import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, createSqlClient } from "@aistudy/database";
import { GET as getCandidates } from "../../../apps/web/src/app/api/opening/candidates/route";
import { GET as getJob } from "../../../apps/web/src/app/api/opening/jobs/[id]/route";
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

  it("returns 404 for an unknown job id", async () => {
    const response = await getJob(request(`/api/opening/jobs/${randomUUID()}`), {
      params: Promise.resolve({ id: randomUUID() }),
    });
    expect(response.status).toBe(404);
  });
});
