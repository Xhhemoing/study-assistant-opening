import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, createSqlClient } from "@aistudy/database";
import { learningSummarySchema } from "@aistudy/contracts";
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
let ownerUserId = "";

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
  const body = await response.json() as { user: { id: string; workspaceId: string } };
  const token = response.headers.get("set-cookie")!.match(/aistudy_session=([^;]+)/)![1];
  return { cookie: `aistudy_session=${token}`, workspaceId: body.user.workspaceId, ownerUserId: body.user.id };
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
  ownerUserId = owner.ownerUserId;
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

it("returns bounded HTTP evidence for 201 effective heads without upgrading legacy unknowns", async () => {
  const courseId = randomUUID(), sessionId = randomUUID();
  const ids = Array.from({ length: 201 }, () => randomUUID());
  await sql`INSERT INTO courses(id,workspace_id,title,slug)
    VALUES(${courseId},${workspaceId},'Many observations',${`many-${courseId.slice(0, 8)}`})`;
  await sql`INSERT INTO opening_learning_sessions(id,workspace_id,owner_user_id,course_id,skill_label)
    VALUES(${sessionId},${workspaceId},${ownerUserId},${courseId},'fractions')`;
  await sql`INSERT INTO opening_learning_observations(
    id,workspace_id,owner_user_id,session_id,course_id,skill_label,requirement_key,
    answer,outcome,assistance,client_key,occurred_at,submitted_at,verdict_source,workspace_history_revision)
    SELECT id,${workspaceId},${ownerUserId},${sessionId},${courseId},'fractions','requirement-1',
      'self report','correct','independent',id::text,'2026-09-30T12:00:00Z'::timestamptz,'2026-09-30T12:00:00Z'::timestamptz,'self_report',0
    FROM unnest(${sql.array(ids)}::uuid[]) id`;
  await sql`UPDATE opening_learning_observations SET outcome='incorrect' WHERE id=${ids[0]!}`;
  const first = await read(courseId);
  expect(first.status).toBe(200);
  const summaries = learningSummarySchema.array().parse(await first.json());
  expect(summaries).toHaveLength(1);
  expect(summaries[0]).toMatchObject({ sampleCount: 201, status: 'needs_check', unverifiedCount: 201,
    recentPerformance: { status: 'needs_check', evidenceCount: 201 } });
  expect(summaries[0]!.evidenceIds).toHaveLength(20);
  expect(summaries[0]!.recentPerformance!.evidenceIds).toHaveLength(20);
  expect(summaries[0]!.evidenceEligibility!.map(entry => entry.observationId)).toEqual(summaries[0]!.evidenceIds);

  const correctedId = randomUUID();
  await sql`INSERT INTO opening_learning_observations(
    id,workspace_id,owner_user_id,session_id,course_id,skill_label,requirement_key,
    answer,outcome,assistance,client_key,occurred_at,submitted_at,verdict_source,
    root_observation_id,revises_observation_id,revision_kind,recorded_at,workspace_history_revision)
    VALUES(${correctedId},${workspaceId},${ownerUserId},${sessionId},${courseId},'fractions','requirement-1',
      'corrected self report','correct','independent',${correctedId},'2026-09-30T12:00:00Z','2026-09-30T12:00:00Z','self_report',
      ${ids[0]!},${ids[0]!},'replace','2026-09-30T13:00:00Z',0)`;
  await sql`UPDATE opening_learning_observations SET effective_head_id=${correctedId} WHERE id=${ids[0]!}`;
  const corrected = await read(courseId);
  expect(corrected.status).toBe(200);
  const [summary] = learningSummarySchema.array().parse(await corrected.json());
  expect(summary).toMatchObject({ sampleCount: 201, status: 'needs_check', unverifiedCount: 201,
    recentPerformance: { status: 'needs_check', evidenceCount: 201 } });
  expect(summary!.evidenceIds).toHaveLength(20);
  expect(summary!.evidenceIds).not.toContain(ids[0]);
  expect(await sql`SELECT id FROM opening_learning_observations WHERE course_id=${courseId}`).toHaveLength(202);
});
