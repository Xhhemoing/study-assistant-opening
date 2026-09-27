import { randomUUID } from "node:crypto";
import { expect, vi } from "vitest";
import { applyMigrations, createSqlClient, hashSessionToken } from "@aistudy/database";
import { POST as register } from "../../../apps/web/src/app/api/auth/register/route";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import { setEphemeralTutorDepsForTests } from "../../../apps/web/src/features/opening/runtime";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for ephemeral handler tests");

export const cookieName = "aistudy_session";
export const sql = createSqlClient(databaseUrl);
export const complete = vi.fn();
let runtime: ReturnType<typeof createAuthRuntime> | undefined;
let cookie = "";

export async function startEphemeralHandler() {
  await applyMigrations(sql);
  runtime = createAuthRuntime({
    databaseUrl,
    authSecret: "opening-ephemeral-handler-secret-32!",
    sessionCookieSecure: false,
    sessionTtlSeconds: 3600,
    authCookieName: cookieName,
  });
  setAuthRuntimeForTests(runtime);
  const response = await register(new Request("http://localhost/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: `${randomUUID()}@example.com`,
      password: "password123",
      displayName: "Ephemeral Handler",
    }),
  }));
  expect(response.status).toBe(201);
  cookie = `aistudy_session=${response.headers.get("set-cookie")!.match(/aistudy_session=([^;]+)/)![1]}`;
  setEphemeralTutorDepsForTests({
    provider: { complete },
    config: {
      maxContextCharacters: 12_000,
      reservedCents: 10,
      maxOutputTokens: 128,
      inputCentsPerMillion: 100,
      outputCentsPerMillion: 200,
    },
  });
}

export async function resetEphemeralRows() {
  complete.mockReset();
  await sql`TRUNCATE opening_assistant_candidates, opening_tutor_jobs, opening_turns, opening_source_chunks, opening_sources, opening_conversations, opening_budget_reservations, opening_memories, opening_help_exposures, opening_learning_sessions RESTART IDENTITY CASCADE`;
}

export async function stopEphemeralHandler() {
  setEphemeralTutorDepsForTests(null);
  await runtime?.close();
  await sql.end({ timeout: 5 });
}

export function postEphemeral(body: unknown, signal?: AbortSignal) {
  return new Request("http://localhost/api/opening/ephemeral", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

export async function ephemeralCounts() {
  const [row] = await sql`
    SELECT
      (SELECT count(*)::int FROM opening_conversations) AS conversations,
      (SELECT count(*)::int FROM opening_turns) AS turns,
      (SELECT count(*)::int FROM opening_tutor_jobs) AS jobs,
      (SELECT count(*)::int FROM opening_assistant_candidates) AS candidates,
      (SELECT count(*)::int FROM opening_memories) AS memories,
      (SELECT count(*)::int FROM opening_learning_sessions) AS learning_sessions,
      (SELECT count(*)::int FROM opening_help_exposures) AS learning_observations,
      (SELECT count(*)::int FROM opening_budget_reservations) AS reservations
  `;
  return row as {
    conversations: number; turns: number; jobs: number; candidates: number;
    memories: number; learning_sessions: number; learning_observations: number; reservations: number;
  };
}

export async function workspaceForCookie() {
  const sessionToken = cookie.slice(`${cookieName}=`.length);
  return (await sql`
    SELECT w.id AS workspace_id
    FROM sessions s JOIN workspaces w ON w.owner_user_id = s.user_id
    WHERE s.token_hash = ${hashSessionToken(sessionToken)}
  `)[0].workspace_id as string;
}
