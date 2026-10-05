import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, createSqlClient } from "@aistudy/database";
import { POST as register } from "../../../apps/web/src/app/api/auth/register/route";
import { GET as getTutorActions } from "../../../apps/web/src/app/api/opening/courses/[id]/tutor-actions/route";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const sql = createSqlClient(databaseUrl);
let runtime: ReturnType<typeof createAuthRuntime> | undefined;
let cookie = "";
let workspaceId = "";

async function registerUser(label: string) {
  const response = await register(
    new Request("http://localhost/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: `${label}-${randomUUID()}@example.com`,
        password: "password123",
        displayName: label,
      }),
    }),
  );
  const body = (await response.json()) as {
    user: { id: string; workspaceId: string };
  };
  const token = response.headers
    .get("set-cookie")!
    .match(/aistudy_session=([^;]+)/)![1];
  return {
    cookie: `aistudy_session=${token}`,
    workspaceId: body.user.workspaceId,
  };
}

async function seedCourse(): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO courses (id, workspace_id, title, slug)
    VALUES (${id}, ${workspaceId}, 'K02a tutor-actions', ${`k02a-${id}`})`;
  return id;
}

function get(
  courseId: string,
  query: Record<string, string>,
  auth = cookie,
) {
  const params = new URLSearchParams(query);
  return getTutorActions(
    new Request(
      `http://localhost/api/opening/courses/${courseId}/tutor-actions?${params}`,
      { headers: { cookie: auth } },
    ),
    { params: Promise.resolve({ id: courseId }) },
  );
}

beforeAll(async () => {
  await applyMigrations(sql);
  runtime = createAuthRuntime({
    databaseUrl,
    authSecret: "opening-k02a-tutor-actions-secret32!",
    sessionCookieSecure: false,
    sessionTtlSeconds: 3600,
    authCookieName: "aistudy_session",
  });
  setAuthRuntimeForTests(runtime);
  const owner = await registerUser("k02a");
  cookie = owner.cookie;
  workspaceId = owner.workspaceId;
});

afterAll(async () => {
  await runtime?.close();
  await sql.end({ timeout: 5 });
});

describe("K02a tutor-actions route", () => {
  it("returns guided from page/skillLabel with empty evidence and no mastery %", async () => {
    const courseId = await seedCourse();
    const response = await get(courseId, {
      skillLabel: "derivatives",
      currentPage: "5",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      actions: Array<Record<string, unknown>>;
    };
    expect(body.actions).toHaveLength(1);
    expect(body.actions[0]!.kind).toBe("guided");
    expect(body.actions[0]!.nodeId).toBeNull();
    expect(body.actions[0]!).not.toHaveProperty("masteryPercent");
    expect(body.actions[0]!).not.toHaveProperty("mastery");
  });

  it("recommends independent_variant after assisted success on a different problemRef", async () => {
    const courseId = await seedCourse();
    const response = await get(courseId, {
      skillLabel: "chain rule",
      currentPage: "2",
      problemRef: "item-A",
      assistedSuccess: "1",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      actions: Array<{ kind: string; problemRef: string | null }>;
    };
    expect(body.actions[0]!.kind).toBe("independent_variant");
    expect(body.actions[0]!.problemRef).not.toBe("item-A");
  });

  it("returns delayed_retest when retest is due", async () => {
    const courseId = await seedCourse();
    const response = await get(courseId, {
      skillLabel: "chain rule",
      currentPage: "2",
      retestDue: "1",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      actions: Array<Record<string, unknown>>;
    };
    expect(body.actions[0]!.kind).toBe("delayed_retest");
    expect(JSON.stringify(body)).not.toMatch(/masteryPercent|mastery_pct/);
  });
});
