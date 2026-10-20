import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOpeningFixture, type OpeningFixture } from "../opening-fixture";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import { POST } from "../../../apps/web/src/app/api/opening/first-learning/route";

let fixture: OpeningFixture;
let runtime: ReturnType<typeof createAuthRuntime>;
beforeAll(async () => {
  fixture = await createOpeningFixture();
  runtime = createAuthRuntime({ databaseUrl: process.env.DATABASE_URL!,
    authSecret: process.env.AUTH_SECRET ?? "opening-fixture-secret-opening-fixture-secret",
    sessionCookieSecure: false, sessionTtlSeconds: 3600, authCookieName: "aistudy_session" });
  setAuthRuntimeForTests(runtime);
});
afterAll(async () => { setAuthRuntimeForTests(null); await runtime?.close(); await fixture?.close(); });
const body = () => ({ clientKey: randomUUID(), topic: "矩阵与线性变换", goal: "能画出基向量变换",
  targetDate: null, minutes: 30, startTime: "19:00", timeZone: "Asia/Shanghai", sourceIds: [] });
function request(input: unknown, cookie: string) {
  return new Request("http://localhost/api/opening/first-learning", { method: "POST",
    headers: { "content-type": "application/json", cookie }, body: JSON.stringify(input) });
}
describe("authenticated first-learning handler", () => {
  it("binds the real cookie scope and replays the same actual activity and task", async () => {
    const input = body();
    const first = await POST(request(input, fixture.cookie));
    expect(first.status).toBe(201);
    const result = await first.json();
    const replay = await POST(request(input, fixture.cookie));
    expect(replay.status).toBe(201);
    expect(await replay.json()).toMatchObject({ activityId: result.activityId, taskId: result.taskId });
    const [row] = await fixture.sql`SELECT workspace_id,owner_user_id FROM opening_teaching_activities WHERE id=${result.activityId}`;
    expect(row).toMatchObject({ workspace_id: fixture.scope.workspaceId, owner_user_id: fixture.scope.ownerUserId });
    expect(first.headers.get("cache-control")).toBe("no-store");
  });
  it("requires authentication", async () => {
    expect((await POST(request(body(), ""))).status).toBe(401);
  });
  it("rejects a forged workspace instead of moving a request to another scope", async () => {
    const input = { ...body(), workspaceId: fixture.otherScope.workspaceId };
    expect((await POST(request(input, fixture.cookie))).status).toBe(400);
    const [row] = await fixture.sql`SELECT count(*)::int AS count FROM opening_teaching_activities WHERE client_key=${`first-learning:${input.clientKey}:activity`}`;
    expect(row!.count).toBe(0);
  });
});
