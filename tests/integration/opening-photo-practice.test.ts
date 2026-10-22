import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCourseMembershipRepository, createSqlClient } from "@aistudy/database";
import { createAuthRuntime, type AuthRuntime } from "../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../apps/web/src/server/runtime";
import { POST } from "../../apps/web/src/app/api/opening/practice/prepare/route";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { backupRows } from "./opening-backup-records-fixture";

describe("photo practice preparation through authenticated SQL-backed route", () => {
  let fixture: OpeningFixture;
  let runtime: AuthRuntime;
  let courseSql: ReturnType<typeof createSqlClient>;
  let courseId: string;
  beforeAll(async () => {
    fixture = await createOpeningFixture();
    runtime = createAuthRuntime({ databaseUrl: process.env.OPENING_TEST_DATABASE_URL!,
      authSecret: process.env.AUTH_SECRET ?? "opening-fixture-secret-opening-fixture-secret",
      sessionCookieSecure: false, sessionTtlSeconds: 3600, authCookieName: "aistudy_session" });
    // This suite checks sequential retries, not native PostgreSQL concurrency.
    courseSql = createSqlClient(process.env.OPENING_TEST_DATABASE_URL!, { max: 1 });
    runtime.courses = createCourseMembershipRepository(courseSql);
    setAuthRuntimeForTests(runtime);
  });
  afterAll(async () => { setAuthRuntimeForTests(null); await courseSql?.end({ timeout: 5 }); await runtime?.close(); await fixture?.close(); });
  function request(body: unknown, authenticated = true) {
    return new Request("http://localhost/api/opening/practice/prepare", { method: "POST",
      headers: { "content-type": "application/json", ...(authenticated ? { cookie: fixture.cookie } : {}) },
      body: JSON.stringify(body) });
  }

  it("requires authentication before creating a course or membership", async () => {
    const sourceId = await backupRows(fixture.sql, fixture.scope).source();
    expect((await POST(request({ sourceId }, false))).status).toBe(401);
    expect(await runtime.courses.listCourses({ workspaceId: fixture.scope.workspaceId })).toEqual([]);
  });

  it("recovers repeated preparation as one persisted course and private source membership", async () => {
    const sourceId = await backupRows(fixture.sql, fixture.scope).source("uploaded", 2);
    const first = await POST(request({ sourceId, sourceVersion: 2 }));
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    const prepared = await first.json();
    courseId = prepared.courseId;
    expect(prepared).toEqual({ courseId: expect.any(String), sourceId, sourceVersion: 2 });
    const replay = await POST(request({ sourceId, sourceVersion: 2 }));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(prepared);
    expect(await runtime.courses.listCourses({ workspaceId: fixture.scope.workspaceId })).toHaveLength(1);
    const assets = await runtime.courses.listCourseAssets({ workspaceId: fixture.scope.workspaceId, courseId });
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({ assetId: sourceId, assetType: "source", role: "reference", visibility: "private" });
  });

  it("rejects a foreign source without adding a relationship", async () => {
    const sourceId = await backupRows(fixture.sql, fixture.otherScope).source();
    expect((await POST(request({ sourceId, sourceVersion: 1 }))).status).toBe(404);
    expect(await fixture.sql`SELECT id FROM course_asset_memberships WHERE asset_id=${sourceId}`).toHaveLength(0);
  });

  it("rejects a changed source version before attaching it", async () => {
    const sourceId = await backupRows(fixture.sql, fixture.scope).source("uploaded", 3);
    expect((await POST(request({ sourceId, sourceVersion: 2 }))).status).toBe(409);
    expect(await fixture.sql`SELECT id FROM course_asset_memberships WHERE asset_id=${sourceId}`).toHaveLength(0);
  });

  it("does not reopen an archived practice course on a later photo", async () => {
    await fixture.sql`UPDATE courses SET archived_at=now() WHERE id=${courseId}`;
    const sourceId = await backupRows(fixture.sql, fixture.scope).source();
    expect((await POST(request({ sourceId, sourceVersion: 1 }))).status).toBe(409);
    expect(await fixture.sql`SELECT id FROM course_asset_memberships WHERE asset_id=${sourceId}`).toHaveLength(0);
    expect(await runtime.courses.listCourses({ workspaceId: fixture.scope.workspaceId, includeArchived: true })).toHaveLength(1);
  });
});
