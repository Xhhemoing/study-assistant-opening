import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOpeningFixture, type OpeningFixture } from "../opening-fixture";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import { GET as inventory } from "../../../apps/web/src/app/api/opening/material-organization/route";
import { POST as add, DELETE as remove } from "../../../apps/web/src/app/api/courses/[id]/memberships/route";
import { POST as createCourse } from "../../../apps/web/src/app/api/courses/route";

let fixture: OpeningFixture;
let runtime: ReturnType<typeof createAuthRuntime>;
function request(path: string, method = "GET", body?: unknown, authenticated = true) {
  return new Request(`http://localhost${path}`, { method, headers: {
    ...(authenticated ? { cookie: fixture.cookie } : {}), ...(body ? { "content-type": "application/json" } : {}),
  }, body: body ? JSON.stringify(body) : undefined });
}
beforeAll(async () => {
  fixture = await createOpeningFixture();
  runtime = createAuthRuntime({ databaseUrl: process.env.OPENING_TEST_DATABASE_URL!,
    authSecret: process.env.AUTH_SECRET ?? "opening-fixture-secret-opening-fixture-secret",
    sessionCookieSecure: false, sessionTtlSeconds: 3600, authCookieName: "aistudy_session" });
  setAuthRuntimeForTests(runtime);
});
afterAll(async () => { setAuthRuntimeForTests(null); await runtime?.close(); await fixture?.close(); });
describe("material course-space handlers", () => {
  it("requires authentication without exposing the course inventory", async () => {
    expect((await inventory(request("/api/opening/material-organization", "GET", undefined, false))).status).toBe(401);
  });
  it("creates courses, references the same original twice and removes only one reference", async () => {
    const courses: string[] = [];
    for (const title of ["微积分", "物理"]) {
      const response = await createCourse(request("/api/courses", "POST", { title, slug: `materials-${randomUUID()}` }));
      expect(response.status).toBe(201);
      courses.push((await response.json()).course.id);
    }
    const source = randomUUID(), foreign = randomUUID();
    await fixture.sql`INSERT INTO opening_sources(id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state) VALUES
      (${source},${fixture.scope.workspaceId},'shared.pdf','application/pdf',8,${'ab'.repeat(32)},0,'uploaded','ready'),
      (${foreign},${fixture.otherScope.workspaceId},'private.pdf','application/pdf',8,${'cd'.repeat(32)},0,'uploaded','ready')`;
    const body = { assetType: "source", assetId: source, role: "reference", visibility: "private", sortOrder: 0 };
    for (const id of courses) {
      expect((await add(request(`/api/courses/${id}/memberships`, "POST", body), { params: Promise.resolve({ id }) })).status).toBe(201);
    }
    const duplicate = await add(request(`/api/courses/${courses[0]}/memberships`, "POST", body), { params: Promise.resolve({ id: courses[0]! }) });
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).error.code).toBe("CONFLICT");
    const denied = await add(request(`/api/courses/${courses[0]}/memberships`, "POST", { ...body, assetId: foreign }), { params: Promise.resolve({ id: courses[0]! }) });
    expect([403,404]).toContain(denied.status);
    const before = await inventory(request("/api/opening/material-organization"));
    expect(before.status).toBe(200);
    expect(before.headers.get("cache-control")).toBe("private, no-store");
    const data = await before.json();
    expect(data.courses).toHaveLength(2);
    expect(data.memberships).toHaveLength(2);
    expect(data.memberships.every((item: { sourceId: string }) => item.sourceId === source)).toBe(true);
    expect((await remove(request(`/api/courses/${courses[0]}/memberships`, "DELETE", { assetType: "source", assetId: source }), { params: Promise.resolve({ id: courses[0]! }) })).status).toBe(204);
    const after = await (await inventory(request("/api/opening/material-organization"))).json();
    expect(after.memberships).toEqual([{ courseId: courses[1], sourceId: source, role: "reference" }]);
    expect((await fixture.sql`SELECT id FROM opening_sources WHERE id=${source}`)).toHaveLength(1);
  });
});
