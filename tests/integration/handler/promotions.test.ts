import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, createSqlClient } from "@aistudy/database";
import { POST as register } from "../../../apps/web/src/app/api/auth/register/route";
import {
  GET as list,
  POST as create,
} from "../../../apps/web/src/app/api/explorations/[id]/promotions/route";
import { POST as accept } from "../../../apps/web/src/app/api/promotions/[id]/accept/route";
import { POST as reject } from "../../../apps/web/src/app/api/promotions/[id]/reject/route";
import { GET as getPromotionSource } from "../../../apps/web/src/app/api/documents/[id]/promotion-source/route";
import { POST as createExploration } from "../../../apps/web/src/app/api/explorations/route";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl)
  throw new Error("DATABASE_URL is required for promotion handler tests");
const cookieName = "aistudy_session";
const context = (id: string) => ({ params: Promise.resolve({ id }) });
function request(
  path: string,
  method: string,
  cookie?: string,
  body?: unknown,
) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
describe("promotion handlers", () => {
  const sql = createSqlClient(databaseUrl);
  let runtime: ReturnType<typeof createAuthRuntime>;
  beforeAll(async () => {
    await applyMigrations(sql);
    runtime = createAuthRuntime({
      databaseUrl,
      authSecret: "promotion-handler-secret-at-least-32-chars",
      sessionCookieSecure: false,
      sessionTtlSeconds: 3600,
      authCookieName: cookieName,
    });
    setAuthRuntimeForTests(runtime);
  });
  beforeEach(async () => {
    await sql`TRUNCATE promotion_targets,promotion_records,exploration_blocks,exploration_branches,explorations,course_asset_memberships,courses,library_revisions,library_blocks,library_documents,sessions,workspaces,users RESTART IDENTITY CASCADE`;
  });
  afterAll(async () => {
    setAuthRuntimeForTests(null);
    await runtime.close();
    await sql.end({ timeout: 5 });
  });
  async function user(label: string) {
    const response = await register(
      request("/api/auth/register", "POST", undefined, {
        email: `${label}-${randomUUID()}@example.com`,
        password: "password123",
        displayName: label,
      }),
    );
    const token = response.headers
      .get("set-cookie")!
      .match(/aistudy_session=([^;]+)/)![1];
    return `${cookieName}=${token}`;
  }
  async function source(cookie: string) {
    const response = await createExploration(
      request("/api/explorations", "POST", cookie, { title: "Source" }),
    );
    return (await response.json()).exploration.id as string;
  }
  it("requires authentication and validates payloads", async () => {
    expect(
      (
        await list(
          request("/api/explorations/x/promotions", "GET"),
          context(randomUUID()),
        )
      ).status,
    ).toBe(401);
    const cookie = await user("invalid");
    const id = await source(cookie);
    expect(
      (
        await create(
          request("/api/explorations/x/promotions", "POST", cookie, {
            kind: "note",
            title: "",
            body: "x",
          }),
          context(id),
        )
      ).status,
    ).toBe(400);
  });
  it("binds workspace and preserves independent terminal outcomes", async () => {
    const owner = await user("owner"),
      other = await user("other"),
      id = await source(owner);
    const one = (
      await (
        await create(
          request("/x", "POST", owner, {
            kind: "note",
            title: "One",
            body: "First",
          }),
          context(id),
        )
      ).json()
    ).promotion;
    const two = (
      await (
        await create(
          request("/x", "POST", owner, {
            kind: "note",
            title: "Two",
            body: "Second",
          }),
          context(id),
        )
      ).json()
    ).promotion;
    expect((await list(request("/x", "GET", other), context(id))).status).toBe(
      403,
    );
    const accepted = (
      await (await accept(request("/x", "POST", owner), context(one.id))).json()
    ).promotion;
    const rejected = (
      await (await reject(request("/x", "POST", owner), context(two.id))).json()
    ).promotion;
    expect(accepted.status).toBe("accepted");
    expect(rejected.status).toBe("rejected");
    expect(
      (
        await (
          await accept(request("/x", "POST", owner), context(one.id))
        ).json()
      ).promotion.targetId,
    ).toBe(accepted.targetId);
  });
  it("returns document provenance only to its workspace", async () => {
    const owner = await user("source-owner"),
      other = await user("source-other"),
      id = await source(owner);
    const candidate = (
      await (
        await create(
          request("/x", "POST", owner, {
            kind: "note",
            title: "Source note",
            body: "Body",
          }),
          context(id),
        )
      ).json()
    ).promotion;
    const promoted = (
      await (
        await accept(request("/x", "POST", owner), context(candidate.id))
      ).json()
    ).promotion;
    const sourceResponse = await getPromotionSource(
      request("/x", "GET", owner),
      context(promoted.targetId),
    );
    expect(sourceResponse.status).toBe(200);
    expect((await sourceResponse.json()).promotion).toMatchObject({
      explorationId: id,
      targetId: promoted.targetId,
    });
    expect(
      (
        await getPromotionSource(
          request("/x", "GET", other),
          context(promoted.targetId),
        )
      ).status,
    ).toBe(403);
  });
});
