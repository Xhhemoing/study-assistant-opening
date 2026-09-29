import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOpeningSourceRepository } from "@aistudy/database";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import { GET as impact } from "../../../apps/web/src/app/api/opening/sources/[id]/impact/route";
import { POST as action } from "../../../apps/web/src/app/api/opening/sources/[id]/actions/route";
import { GET as deletions } from "../../../apps/web/src/app/api/opening/sources/deletions/route";
import { createOpeningFixture, type OpeningFixture } from "../opening-fixture";

let f: OpeningFixture, runtime: ReturnType<typeof createAuthRuntime>;
beforeAll(async () => {
  f = await createOpeningFixture();
  runtime = createAuthRuntime({ databaseUrl: process.env.DATABASE_URL!, authSecret: process.env.AUTH_SECRET ?? "opening-fixture-secret-opening-fixture-secret",
    sessionCookieSecure: false, sessionTtlSeconds: 3600, authCookieName: "aistudy_session" });
  setAuthRuntimeForTests(runtime);
});
afterAll(async () => { setAuthRuntimeForTests(null); await runtime?.close(); await f?.close(); });
function request(path: string, body?: unknown, authenticated = true) {
  return new Request(`http://localhost/api/opening/sources/${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { ...(authenticated ? { cookie: f.cookie } : {}), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function source(other = false) {
  return createOpeningSourceRepository(f.sql).create(other ? f.otherScope : f.scope, { name: "handler.pdf", mime: "application/pdf", bytes: 4, sha256: "a".repeat(64) });
}
describe("source actions HTTP boundary", () => {
  it("requires a session for impact, actions and cleanup receipts", async () => {
    const s = await source(), params = { params: Promise.resolve({ id: s.id }) };
    expect((await impact(request(`${s.id}/impact`, undefined, false), params)).status).toBe(401);
    expect((await action(request(`${s.id}/actions`, { action: "retry_cleanup" }, false), params)).status).toBe(401);
    expect((await deletions(request("deletions", undefined, false))).status).toBe(401);
  });
  it("requires explicit action/version/reference input and rejects client scope", async () => {
    const s = await source(), params = { params: Promise.resolve({ id: s.id }) };
    for (const input of [{ action: "delete" }, { action: "exclude", expectedVersion: 0, expectedMembershipIds: [], workspaceId: f.otherScope.workspaceId }]) {
      expect((await action(request(`${s.id}/actions`, input), params)).status).toBe(400);
    }
    expect((await impact(request("bad/impact"), { params: Promise.resolve({ id: "bad" }) })).status).toBe(400);
    expect(await f.sql`SELECT id FROM opening_sources WHERE id=${s.id}`).toHaveLength(1);
  });
  it("returns an owner-scoped impact and confirms an exclusion without deleting the source", async () => {
    const s = await source(), params = { params: Promise.resolve({ id: s.id }) };
    const preview = await impact(request(`${s.id}/impact`), params);
    expect(preview.status).toBe(200); expect(await preview.json()).toMatchObject({ sourceId: s.id, aiExcluded: false, courses: [] });
    const response = await action(request(`${s.id}/actions`, { action: "exclude", expectedVersion: 0, expectedMembershipIds: [] }), params);
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ deleted: false, aiExcluded: true, cleanupPending: 0 });
    expect(await f.sql`SELECT id FROM opening_sources WHERE id=${s.id}`).toHaveLength(1);
    expect((await deletions(request("deletions"))).status).toBe(200);
  });
  it("does not reveal another owner's source or deletion receipt", async () => {
    const s = await source(true), params = { params: Promise.resolve({ id: s.id }) };
    expect((await impact(request(`${s.id}/impact`), params)).status).toBe(404);
    expect((await action(request(`${s.id}/actions`, { action: "retry_cleanup" }), params)).status).toBe(404);
  });
});
