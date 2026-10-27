/**
 * PR-H §7.3: the browser's capabilities match what the backend authorizes, for the
 * same code under different server environments (real DB sessions, no mocks).
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { applyMigrations, createSqlClient } from "@aistudy/database";
import { openingCapabilitiesResponseSchema } from "@aistudy/config/public";
import { POST as register } from "../../../apps/web/src/app/api/auth/register/route";
import { GET as capabilitiesRoute } from "../../../apps/web/src/app/api/opening/capabilities/route";
import { GET as resumeRoute } from "../../../apps/web/src/app/api/opening/teaching/activities/[id]/resume/route";
import { POST as commandsRoute } from "../../../apps/web/src/app/api/opening/teaching/activities/[id]/commands/route";
import { POST as checkpointRoute } from "../../../apps/web/src/app/api/opening/teaching/activities/[id]/checkpoint/route";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for capabilities handler tests");
const cookieName = "aistudy_session";
const activityId = "11111111-1111-4111-8111-111111111111";

function request(path: string, method: string, cookie?: string, body?: unknown) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("opening capabilities vs backend authorization (PR-H)", () => {
  const sql = createSqlClient(databaseUrl);
  let runtime: ReturnType<typeof createAuthRuntime> | undefined;
  const cookies: string[] = [];

  beforeAll(async () => {
    await applyMigrations(sql);
    runtime = createAuthRuntime({ databaseUrl, authSecret: "capabilities-handler-secret-at-least-32", sessionCookieSecure: false, sessionTtlSeconds: 3600, authCookieName: cookieName });
    setAuthRuntimeForTests(runtime);
    vi.stubEnv("OPENING_RELEASE", "0");
    for (let i = 0; i < 12; i += 1) {
      const res = await register(request("/api/auth/register", "POST", undefined, { email: `caps-${i}-${randomUUID()}@example.com`, password: "password123", displayName: `caps ${i}` }));
      expect(res.status).toBe(201);
      cookies.push(res.headers.get("set-cookie")!.split(";")[0]!);
    }
    vi.unstubAllEnvs();
  });

  afterEach(() => vi.unstubAllEnvs());

  afterAll(async () => {
    setAuthRuntimeForTests(null);
    await runtime?.close();
    await sql.end({ timeout: 5 });
  });

  async function caps(cookie?: string) {
    const res = await capabilitiesRoute(request("/api/opening/capabilities", "GET", cookie));
    expect(res.status).toBe(200);
    return openingCapabilitiesResponseSchema.parse(await res.json());
  }

  /** True when the guard (not the service) rejected: generic 404 "Not found". */
  async function guardDenied(cookie: string): Promise<boolean> {
    const params = { params: Promise.resolve({ id: activityId }) };
    const results = await Promise.all([
      resumeRoute(request(`/api/opening/teaching/activities/${activityId}/resume`, "GET", cookie), params),
      commandsRoute(request(`/api/opening/teaching/activities/${activityId}/commands`, "POST", cookie, {}), params),
      checkpointRoute(request(`/api/opening/teaching/activities/${activityId}/checkpoint`, "POST", cookie, {}), params),
    ]);
    const denied = await Promise.all(results.map(async (r) => r.status === 404 && (await r.json()).error?.message === "Not found"));
    expect(new Set(denied).size, "all three teaching routes agree").toBe(1);
    return denied[0]!;
  }

  const envs: [string, Record<string, string>, { api: boolean; ui: boolean }][] = [
    ["A off", { OPENING_TEACHING_LOOP: "0", OPENING_TEACHING_WORKSPACE: "0" }, { api: false, ui: false }],
    ["B dark launch (api only)", { OPENING_TEACHING_LOOP: "1", OPENING_TEACHING_WORKSPACE: "0" }, { api: true, ui: false }],
    ["C api+ui", { OPENING_TEACHING_LOOP: "1", OPENING_TEACHING_WORKSPACE: "1" }, { api: true, ui: true }],
    ["D retired rollout 50%", { OPENING_TEACHING_LOOP: "1", OPENING_TEACHING_WORKSPACE: "1", OPENING_TEACHING_LOOP_ROLLOUT_PERCENT: "50" }, { api: true, ui: true }],
    ["E retired rollout 0%", { OPENING_TEACHING_LOOP: "1", OPENING_TEACHING_WORKSPACE: "1", OPENING_TEACHING_LOOP_ROLLOUT_PERCENT: "0" }, { api: true, ui: true }],
    ["F off with retired rollout", { OPENING_TEACHING_LOOP: "0", OPENING_TEACHING_WORKSPACE: "0", OPENING_TEACHING_LOOP_ROLLOUT_PERCENT: "100" }, { api: false, ui: false }],
  ];

  it.each(envs)("env %s: capabilities.teachingLoop.api == backend allows, per user", async (_label, env, expected) => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    for (const cookie of cookies) {
      const body = await caps(cookie);
      expect(body.authenticated).toBe(true);
      const { api, ui } = body.capabilities.teachingLoop;
      expect({ api, ui }).toEqual(expected);
      expect(ui && !api, "UI never shown without API").toBe(false);
      expect(await guardDenied(cookie)).toBe(!api);
    }
  });

  it("a client that ignores capabilities (direct request with LOOP=0) is still rejected", async () => {
    vi.stubEnv("OPENING_TEACHING_LOOP", "0");
    vi.stubEnv("OPENING_TEACHING_WORKSPACE", "0");
    expect((await caps(cookies[0])).capabilities.teachingLoop.api).toBe(false);
    expect(await guardDenied(cookies[0]!)).toBe(true);
  });

  it("anonymous capabilities are closed and carry the build digest", async () => {
    vi.stubEnv("OPENING_TEACHING_LOOP", "1");
    const body = await caps();
    expect(body.authenticated).toBe(false);
    expect(body.capabilities.teachingLoop).toEqual({ api: false, ui: false });
    expect(body.buildConfigDigest).toMatch(/^v1-[0-9a-f]{16}$/);
  });
});
