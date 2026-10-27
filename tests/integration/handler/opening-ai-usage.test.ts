import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openingAiSettingsResponseSchema } from "@aistudy/contracts";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import { GET } from "../../../apps/web/src/app/api/opening/ai-settings/route";
import { createOpeningFixture, type OpeningFixture } from "../opening-fixture";

let fixture: OpeningFixture;
let runtime: ReturnType<typeof createAuthRuntime>;
const request = (query = "", authenticated = true) => new Request(`http://localhost/api/opening/ai-settings${query}`, {
  headers: authenticated ? { cookie: fixture.cookie } : {},
});
beforeAll(async () => {
  fixture = await createOpeningFixture();
  runtime = createAuthRuntime({ databaseUrl: process.env.DATABASE_URL!, authSecret: process.env.AUTH_SECRET ?? "opening-fixture-secret-opening-fixture-secret", sessionCookieSecure: false, sessionTtlSeconds: 3600, authCookieName: "aistudy_session" });
  setAuthRuntimeForTests(runtime);
});
beforeEach(async () => {
  await fixture.reset();
  await fixture.sql`DELETE FROM workspace_preferences WHERE workspace_id=${fixture.scope.workspaceId}`;
  vi.stubEnv("OPENING_MODEL_DAILY_QUOTA_MODE", "unlimited");
  vi.stubEnv("OPENING_MODEL_DAILY_CAP_CENTS", "0");
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  setAuthRuntimeForTests(null);
  await runtime?.close();
  await fixture?.close();
});

describe("AI usage authenticated handler", () => {
  it("reads actual ledger totals in unlimited mode and ignores a supplied foreign workspace", async () => {
    await fixture.sql`INSERT INTO opening_budget_reservations (workspace_id,purpose,amount_cents,request_id,state)
      VALUES (${fixture.scope.workspaceId},'tutor',13,${randomUUID()},'completed'),
             (${fixture.scope.workspaceId},'tutor',7,${randomUUID()},'reserved'),
             (${fixture.otherScope.workspaceId},'tutor',900,${randomUUID()},'completed')`;
    const response = await GET(request(`?workspaceId=${fixture.otherScope.workspaceId}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const data = openingAiSettingsResponseSchema.parse(await response.json());
    expect(data.dailyQuota).toEqual({ mode: "unlimited" });
    expect(data.dailyUsage).toMatchObject({ spentCents: 13, reservedCents: 7, timeZone: "Asia/Shanghai" });
    expect(await fixture.sql`SELECT amount_cents,state FROM opening_budget_reservations WHERE workspace_id=${fixture.scope.workspaceId} ORDER BY amount_cents`)
      .toEqual([{ amount_cents: 7, state: "reserved" }, { amount_cents: 13, state: "completed" }]);
  });

  it("returns unknown usage when its local day cannot be resolved, retaining the model settings response", async () => {
    await fixture.sql`INSERT INTO workspace_preferences (workspace_id,planning_settings) VALUES (${fixture.scope.workspaceId},'{"timeZone":"Mars/Olympus_Mons"}'::jsonb)`;
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(openingAiSettingsResponseSchema.parse(await response.json()).dailyUsage).toBeNull();
  });

  it("does not expose usage to an unauthenticated request", async () => {
    const response = await GET(request("", false));
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("dailyUsage");
  });
});
