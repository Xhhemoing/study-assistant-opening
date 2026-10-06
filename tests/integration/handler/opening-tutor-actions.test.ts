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
let ownerUserId = "";
let workspaceId = "";
let courseId = "";
let sessionId = "";
let otherCookie = "";

type RegisterResult = {
  cookie: string;
  workspaceId: string;
  userId: string;
};

async function registerUser(label: string): Promise<RegisterResult> {
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
    userId: body.user.id,
  };
}

async function countRows(table: string): Promise<number> {
  const rows = await sql`SELECT count(*)::int AS count FROM ${sql(table)}
    WHERE workspace_id = ${workspaceId}`;
  return Number(rows[0]!.count);
}

function get(
  requestedCourseId: string,
  query: Record<string, string>,
  auth = cookie,
) {
  const params = new URLSearchParams(query);
  return getTutorActions(
    new Request(
      `http://localhost/api/opening/courses/${requestedCourseId}/tutor-actions?${params}`,
      { headers: { cookie: auth } },
    ),
    { params: Promise.resolve({ id: requestedCourseId }) },
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
  const owner = await registerUser("k02a-owner");
  const other = await registerUser("k02a-other");
  cookie = owner.cookie;
  otherCookie = other.cookie;
  workspaceId = owner.workspaceId;
  ownerUserId = owner.userId;

  courseId = randomUUID();
  await sql`INSERT INTO courses (id, workspace_id, title, slug)
    VALUES (${courseId}, ${workspaceId}, 'K02a tutor actions', ${`k02a-${courseId}`})`;

  sessionId = randomUUID();
  await sql`INSERT INTO opening_learning_sessions
    (id, workspace_id, owner_user_id, course_id, skill_label)
    VALUES (${sessionId}, ${workspaceId}, ${ownerUserId}, ${courseId}, 'chain rule')`;

  await sql`INSERT INTO opening_help_exposures
    (id, workspace_id, session_id, turn_id, level, delivered)
    VALUES (${randomUUID()}, ${workspaceId}, ${sessionId}, ${randomUUID()}, 'revealed', TRUE)`;

  const taskId = randomUUID();
  await sql`INSERT INTO opening_tasks (id, workspace_id, owner_user_id, title, minutes, status)
    VALUES (${taskId}, ${workspaceId}, ${ownerUserId}, 'Integration retest', 15, 'pending')`;
  const dueAt = new Date(Date.now() - 60_000).toISOString();
  // Due activity lives on a different skill so the revealed-exposure cases below
  // stay isolated from retestDue; the delayed_retest case then also proves the
  // frozen K02a baseline priority (retestDue wins over revealed exposures).
  await sql`INSERT INTO opening_retest_activities
    (id, workspace_id, owner_user_id, course_id, skill_label, purpose, evidence_cycle_id,
      task_id, status, scheduled_start_at, accepted_at)
    VALUES (${randomUUID()}, ${workspaceId}, ${ownerUserId}, ${courseId}, 'integration by parts',
      'retest', ${randomUUID()}, ${taskId}, 'accepted', ${dueAt}, ${dueAt})`;
});

afterAll(async () => {
  await runtime?.close();
  await sql.end({ timeout: 5 });
});

describe("K02a tutor-actions route", () => {
  it("returns guided from server-validated page/skillLabel", async () => {
    const response = await get(courseId, {
      skillLabel: "derivatives",
      currentPage: "5",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      actions: Array<{ kind: string; nodeId: string | null }>;
    };
    expect(body.actions).toHaveLength(1);
    expect(body.actions[0]!.kind).toBe("guided");
    expect(body.actions[0]!.nodeId).toBeNull();
    expect(body.actions[0]!).not.toHaveProperty("masteryPercent");
    expect(body.actions[0]!).not.toHaveProperty("mastery");
  });

  it("rejects client-supplied observation inputs", async () => {
    const response = await get(courseId, {
      skillLabel: "derivatives",
      currentPage: "5",
      assistedSuccess: "1",
    });
    expect(response.status).toBe(400);
  });

  it("derives independent_variant from delivered revealed exposure", async () => {
    const response = await get(courseId, {
      skillLabel: "chain rule",
      sessionId,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      actions: Array<{ kind: string; problemRef: string | null }>;
    };
    expect(body.actions[0]!.kind).toBe("independent_variant");
    expect(body.actions[0]!.problemRef).toBe("variant:1");
  });

  it("derives worked_example from a hint without masking later reveals", async () => {
    await sql`INSERT INTO opening_help_exposures
      (id, workspace_id, session_id, turn_id, level, delivered)
      VALUES (${randomUUID()}, ${workspaceId}, ${sessionId}, ${randomUUID()}, 'hinted', TRUE)`;
    const response = await get(courseId, {
      skillLabel: "chain rule",
      sessionId,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { actions: Array<{ kind: string }> };
    expect(body.actions[0]!.kind).toBe("independent_variant");
  });

  it("derives delayed_retest from an accepted due activity", async () => {
    // Session has revealed exposures, yet retestDue must win per K02a baseline.
    const response = await get(courseId, {
      skillLabel: "integration by parts",
      currentPage: "2",
      sessionId,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { actions: Array<{ kind: string }> };
    expect(body.actions[0]!.kind).toBe("delayed_retest");
    expect(JSON.stringify(body)).not.toMatch(/masteryPercent|mastery_pct/);
  });

  it("rejects a course outside the caller workspace", async () => {
    const response = await get(courseId, {
      skillLabel: "derivatives",
      currentPage: "5",
    }, otherCookie);
    expect(response.status).toBe(404);
  });

  it("performs a read-only recommendation", async () => {
    const beforeSessionCount = await countRows("opening_learning_sessions");
    const beforeExposureCount = await countRows("opening_help_exposures");
    const beforeTaskCount = await countRows("opening_tasks");
    const response = await get(courseId, {
      skillLabel: "chain rule",
      currentPage: "2",
      sessionId,
    });
    expect(response.status).toBe(200);
    expect(await countRows("opening_learning_sessions")).toBe(beforeSessionCount);
    expect(await countRows("opening_help_exposures")).toBe(beforeExposureCount);
    expect(await countRows("opening_tasks")).toBe(beforeTaskCount);
  });
});
