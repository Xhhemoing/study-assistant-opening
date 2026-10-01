import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, createOpeningLearningRepository, createSqlClient } from "@aistudy/database";
import { courseLearningHistoryPageSchema, type LearningObservation, type Scope } from "@aistudy/contracts";
import { POST as register } from "../../../apps/web/src/app/api/auth/register/route";
import { GET } from "../../../apps/web/src/app/api/opening/courses/[id]/observations/history/route";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";

const databaseUrl = process.env.DATABASE_URL ?? "";
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const sql = createSqlClient(databaseUrl);
const repository = createOpeningLearningRepository(sql);
let runtime: ReturnType<typeof createAuthRuntime> | undefined;
let cookie = "", foreignCookie = "";
let scope: Scope;

async function registerUser(label: string) {
  const response = await register(new Request("http://localhost/api/auth/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `${label}-${randomUUID()}@example.com`, password: "password123", displayName: label }),
  }));
  expect(response.status).toBe(201);
  const body = await response.json() as { user: { id: string; workspaceId: string } };
  const token = response.headers.get("set-cookie")!.match(/aistudy_session=([^;]+)/)![1];
  return { cookie: `aistudy_session=${token}`, scope: { workspaceId: body.user.workspaceId, ownerUserId: body.user.id } };
}
async function createCourse() {
  const id = randomUUID();
  await sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${id},${scope.workspaceId},'History',${`history-${id}`})`;
  return id;
}
async function seed(courseId: string, count: number) {
  const session = await repository.createSession(scope, { courseId, skillLabel: "fractions", sourceIds: [] });
  const observations: LearningObservation[] = [];
  for (let index = 0; index < count; index += 1) {
    observations.push(await repository.insertObservation(scope, { sessionId: session.id, courseId, skillLabel: "fractions", sourceIds: [],
      answer: `Original ${index}`, outcome: "unverified", assistance: "unknown", clientKey: randomUUID(), verdictSource: "self_report" }));
  }
  return observations;
}
function revise(record: LearningObservation, requirementKey: string | null, answer = record.answer) {
  return repository.reviseObservation(scope, { rootObservationId: record.id, revisesObservationId: record.id, expectedHead: record.id,
    revisionKind: "replace", reason: "Correct course history", clientKey: randomUUID(),
    replacement: { answer, outcome: "unverified", assistance: "unknown", requirementKey, verdictSource: "self_report" } });
}
function read(courseId: string, query: Record<string, string> = {}, auth = cookie) {
  return GET(new Request(`http://localhost/api/opening/courses/${courseId}/observations/history?${new URLSearchParams(query)}`,
    { headers: { cookie: auth } }), { params: Promise.resolve({ id: courseId }) });
}
async function page(courseId: string, query: Record<string, string> = {}) {
  const response = await read(courseId, query);
  expect(response.status).toBe(200);
  return courseLearningHistoryPageSchema.parse(await response.json());
}

beforeAll(async () => {
  await applyMigrations(sql);
  runtime = createAuthRuntime({ databaseUrl, authSecret: "opening-history-handler-secret-32bytes!", sessionCookieSecure: false,
    sessionTtlSeconds: 3600, authCookieName: "aistudy_session" });
  setAuthRuntimeForTests(runtime);
  const owner = await registerUser("history-owner");
  cookie = owner.cookie;
  scope = owner.scope;
  foreignCookie = (await registerUser("history-foreign")).cookie;
});
afterAll(async () => {
  setAuthRuntimeForTests(null);
  await runtime?.close();
  await sql.end({ timeout: 5 });
});

describe("GET /api/opening/courses/[id]/observations/history", () => {
  it("returns an owned empty page, authenticates and conceals foreign courses", async () => {
    const courseId = await createCourse();
    expect(await page(courseId)).toEqual({ observations: [], snapshotRevision: 0, nextCursor: null, totalCount: 0, visibilityChanged: false });
    expect((await read(courseId, {}, "")).status).toBe(401);
    expect((await read(courseId, {}, foreignCookie)).status).toBe(404);
    expect((await read(randomUUID())).status).toBe(404);
  });
  it("rejects malformed or forged HTTP input without accepting partial limit values", async () => {
    const courseId = await createCourse();
    const invalidQueries: Array<Record<string, string>> = [{ limit: "2x" }, { limit: "201" }, { requirement: "all" }, { requirement: "unassigned", requirementKey: "x" }, { ownerUserId: scope.ownerUserId }];
    for (const query of invalidQueries) {
      expect((await read(courseId, query)).status).toBe(400);
    }
    expect((await read("invalid")).status).toBe(400);
  });
  it("continues one committed revision through later inserts and corrections, then refreshes", async () => {
    const courseId = await createCourse();
    const original = await seed(courseId, 3);
    const first = await page(courseId, { limit: "1" });
    expect(first.totalCount).toBe(3);
    expect(first.nextCursor).not.toBeNull();
    const pending = original.find(record => record.id !== first.observations[0]!.id)!;
    const corrected = await revise(pending, null, "Corrected after snapshot");
    const [later] = await seed(courseId, 1);
    const rest = await page(courseId, { cursor: first.nextCursor!, limit: "2" });
    expect(rest).toMatchObject({ snapshotRevision: first.snapshotRevision, totalCount: 3, nextCursor: null, visibilityChanged: false });
    const snapshotIds = [...first.observations, ...rest.observations].map(record => record.id);
    expect(new Set(snapshotIds)).toEqual(new Set(original.map(record => record.id)));
    expect(rest.observations.find(record => record.id === pending.id)?.effectiveHeadId).toBe(pending.id);
    const current = await page(courseId);
    expect(current.snapshotRevision).toBeGreaterThan(first.snapshotRevision);
    expect(current.totalCount).toBe(4);
    expect(current.observations.map(record => record.id)).toContain(corrected.headObservationId);
    expect(current.observations.map(record => record.id)).toContain(later!.id);
    expect(current.observations.map(record => record.id)).not.toContain(pending.id);
  });
  it("distinguishes all, null, empty and exact untrimmed requirement keys over HTTP", async () => {
    const courseId = await createCourse();
    const [unassigned, blank, exact] = await seed(courseId, 3);
    const blankHead = await revise(blank!, "");
    const exactHead = await revise(exact!, " 第一章 ");
    expect((await page(courseId)).totalCount).toBe(3);
    expect((await page(courseId, { requirement: "unassigned" })).observations.map(record => record.id)).toEqual([unassigned!.id]);
    expect((await page(courseId, { requirementKey: "" })).observations.map(record => record.id)).toEqual([blankHead.headObservationId]);
    expect((await page(courseId, { requirementKey: " 第一章 " })).observations.map(record => record.id)).toEqual([exactHead.headObservationId]);
    expect((await page(courseId, { requirementKey: "第一章" })).totalCount).toBe(0);
  });
  it("rejects cursor reuse across authenticated owners, courses and filters", async () => {
    const courseId = await createCourse();
    await seed(courseId, 2);
    const cursor = (await page(courseId, { limit: "1" })).nextCursor!;
    expect((await read(courseId, { cursor }, foreignCookie)).status).toBe(400);
    expect((await read(await createCourse(), { cursor })).status).toBe(400);
    expect((await read(courseId, { cursor, requirement: "unassigned" })).status).toBe(400);
    expect((await read(courseId, { cursor: "malformed" })).status).toBe(400);
  });
});

