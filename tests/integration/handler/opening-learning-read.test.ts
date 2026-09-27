import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, createSqlClient } from "@aistudy/database";
import { POST as register } from "../../../apps/web/src/app/api/auth/register/route";
import { GET as readLearning } from "../../../apps/web/src/app/api/opening/courses/[id]/learning/route";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const sql = createSqlClient(databaseUrl);
let runtime: ReturnType<typeof createAuthRuntime> | undefined;
let cookie = "";
let workspaceId = "";

async function registerUser(label: string) {
  const response = await register(new Request("http://localhost/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: `${label}-${randomUUID()}@example.com`,
      password: "password123",
      displayName: label,
    }),
  }));
  const body = await response.json() as { user: { workspaceId: string } };
  const token = response.headers.get("set-cookie")!.match(/aistudy_session=([^;]+)/)![1];
  return { cookie: `aistudy_session=${token}`, workspaceId: body.user.workspaceId };
}

function read(courseId: string, auth = cookie) {
  return readLearning(
    new Request(`http://localhost/api/opening/courses/${courseId}/learning`, {
      headers: { cookie: auth },
    }),
    { params: Promise.resolve({ id: courseId }) },
  );
}

beforeAll(async () => {
  await applyMigrations(sql);
  runtime = createAuthRuntime({
    databaseUrl,
    authSecret: "opening-learning-read-secret-32b!!",
    sessionCookieSecure: false,
    sessionTtlSeconds: 3600,
    authCookieName: "aistudy_session",
  });
  setAuthRuntimeForTests(runtime);
  const owner = await registerUser("reader");
  cookie = owner.cookie;
  workspaceId = owner.workspaceId;
});

afterAll(async () => {
  setAuthRuntimeForTests(null);
  await runtime?.close();
  await sql.end({ timeout: 5 });
});

describe("GET /api/opening/courses/[id]/learning", () => {
  it("returns [] for an owned course with no observations and 404 otherwise", async () => {
    const courseId = randomUUID();
    await sql`INSERT INTO courses (id, workspace_id, title, slug)
      VALUES (${courseId}, ${workspaceId}, 'Paper', ${`paper-${courseId.slice(0, 8)}`})`;

    const empty = await read(courseId);
    expect(empty.status).toBe(200);
    await expect(empty.json()).resolves.toEqual([]);

    const missing = await read(randomUUID());
    expect(missing.status).toBe(404);

    const anonymous = await readLearning(
      new Request(`http://localhost/api/opening/courses/${courseId}/learning`),
      { params: Promise.resolve({ id: courseId }) },
    );
    expect(anonymous.status).toBe(401);
  });
});
