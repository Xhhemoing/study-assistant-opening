import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createOpeningLearningRepository,
  createSqlClient,
} from "@aistudy/database";
import {
  courseLearningSummaryPageSchema,
  type Scope,
} from "@aistudy/contracts";
import { POST as login } from "../../../apps/web/src/app/api/auth/login/route";
import { POST as register } from "../../../apps/web/src/app/api/auth/register/route";
import { GET as readSummary } from "../../../apps/web/src/app/api/opening/courses/[id]/learning/summary/route";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";

const databaseUrl = process.env.DATABASE_URL ?? "";
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const sql = createSqlClient(databaseUrl);
const learning = createOpeningLearningRepository(sql);
let runtime: ReturnType<typeof createAuthRuntime> | undefined;
let ownerCookie = "";
let foreignCookie = "";
let ownerEmail = "";
let scope: Scope;

async function registerUser(label: string) {
  const email = `${label}-${randomUUID()}@example.com`;
  const response = await register(new Request("http://localhost/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123", displayName: label }),
  }));
  expect(response.status).toBe(201);
  const body = await response.json() as { user: { id: string; workspaceId: string } };
  const token = response.headers.get("set-cookie")!.match(/aistudy_session=([^;]+)/)![1];
  return {
    email,
    cookie: `aistudy_session=${token}`,
    scope: { workspaceId: body.user.workspaceId, ownerUserId: body.user.id },
  };
}

async function loginUser(email: string) {
  const response = await login(new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  }));
  expect(response.status).toBe(200);
  const token = response.headers.get("set-cookie")!.match(/aistudy_session=([^;]+)/)![1];
  return `aistudy_session=${token}`;
}

async function createCourse() {
  const id = randomUUID();
  await sql`INSERT INTO courses(id,workspace_id,title,slug)
    VALUES(${id},${scope.workspaceId},'Learning summary',${`learning-summary-${id}`})`;
  return id;
}

function read(courseId: string, query: Record<string, string> = {}, cookie = ownerCookie) {
  const search = new URLSearchParams(query);
  return readSummary(
    new Request(`http://localhost/api/opening/courses/${courseId}/learning/summary?${search}`, {
      headers: { cookie },
    }),
    { params: Promise.resolve({ id: courseId }) },
  );
}

async function page(courseId: string, query: Record<string, string> = {}, cookie = ownerCookie) {
  const response = await read(courseId, query, cookie);
  expect(response.status).toBe(200);
  return courseLearningSummaryPageSchema.parse(await response.json());
}

async function seedGroups(courseId: string) {
  for (const skillLabel of ["fractions", "geometry"]) {
    const session = await learning.createSession(scope, {
      courseId,
      skillLabel,
      sourceIds: [],
    });
    await learning.insertObservation(scope, {
      sessionId: session.id,
      courseId,
      skillLabel,
      sourceIds: [],
      answer: `self report for ${skillLabel}`,
      outcome: "unverified",
      assistance: "unknown",
      clientKey: randomUUID(),
      verdictSource: "self_report",
    });
  }
}

beforeAll(async () => {
  await applyMigrations(sql);
  runtime = createAuthRuntime({
    databaseUrl,
    authSecret: "opening-learning-summary-handler-secret-32!",
    sessionCookieSecure: false,
    sessionTtlSeconds: 3600,
    authCookieName: "aistudy_session",
  });
  setAuthRuntimeForTests(runtime);

  const owner = await registerUser("learning-summary-owner");
  ownerCookie = owner.cookie;
  ownerEmail = owner.email;
  scope = owner.scope;
  foreignCookie = (await registerUser("learning-summary-foreign")).cookie;
});

afterAll(async () => {
  setAuthRuntimeForTests(null);
  await runtime?.close();
  await sql.end({ timeout: 5 });
});

describe("GET /api/opening/courses/[id]/learning/summary", () => {
  it("returns an empty owned page and enforces authentication and ownership", async () => {
    const courseId = await createCourse();
    const empty = await page(courseId);
    expect(empty).toMatchObject({
      status: "ready",
      groups: [],
      snapshotRevision: 0,
      nextCursor: null,
      pendingProjectionCount: 0,
    });
    expect(empty.evaluatedAt).toEqual(expect.any(String));

    expect((await read(courseId, {}, "")).status).toBe(401);
    expect((await read(courseId, {}, foreignCookie)).status).toBe(404);
    expect((await read(randomUUID())).status).toBe(404);
  });

  it("rejects malformed query input at the HTTP boundary", async () => {
    const courseId = await createCourse();
    for (const query of [
      { limit: "2x" },
      { limit: "0" },
      { limit: "51" },
      { limit: "1", unknown: "value" },
      { limit: "1", groupCursor: "" },
    ]) {
      expect((await read(courseId, query)).status).toBe(400);
    }
    expect((await read("invalid")).status).toBe(400);
  });

  it("keeps group pagination stable and lets a separate login reread committed evidence", async () => {
    const courseId = await createCourse();
    await seedGroups(courseId);

    const first = await page(courseId, { limit: "1" });
    expect(first.status).toBe("ready");
    expect(first.groups).toHaveLength(1);
    expect(first.groups[0]?.sampleCount).toBe(1);
    expect(first.nextCursor).not.toBeNull();

    const secondCookie = await loginUser(ownerEmail);
    const second = await page(courseId, {
      limit: "1",
      groupCursor: first.nextCursor!,
    }, secondCookie);
    expect(second).toMatchObject({
      status: "ready",
      snapshotRevision: first.snapshotRevision,
      evaluatedAt: first.evaluatedAt,
      pendingProjectionCount: 0,
    });
    expect(second.groups).toHaveLength(1);
    expect(second.groups[0]?.sampleCount).toBe(1);
    expect(second.groups[0]?.identity.courseId).toBe(courseId);
    expect(second.nextCursor).toBeNull();

    await learning.insertObservation(scope, {
      sessionId: (await learning.createSession(scope, {
        courseId,
        skillLabel: "fractions",
        sourceIds: [],
      })).id,
      courseId,
      skillLabel: "fractions",
      sourceIds: [],
      answer: "new observation",
      outcome: "unverified",
      assistance: "unknown",
      clientKey: randomUUID(),
      verdictSource: "self_report",
    });
    expect((await read(courseId, {
      limit: "1",
      groupCursor: first.nextCursor!,
    }, secondCookie)).status).toBe(409);

    const refreshed = await page(courseId, {}, secondCookie);
    expect(refreshed.groups.find((group) => group.identity.skillLabel === "fractions")?.sampleCount).toBe(2);
  });
});
