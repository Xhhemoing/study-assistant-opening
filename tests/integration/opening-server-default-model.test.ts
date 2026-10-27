import { afterAll, beforeAll, expect, it } from "vitest";
import { loadOpeningRouting } from "@aistudy/database";
import { resolveModelForTask } from "@aistudy/ai";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
afterAll(async () => { await fixture?.close(); });

it("routes a new workspace to the configured server model without a user provider or budget confirmation", async () => {
  const server = { id: "server", providerId: "server", providerLabel: "Server", label: "Server model", modelName: "model",
    baseUrl: "https://provider.example/v1", apiKey: "synthetic-key-not-sent", inputCentsPerMillion: 10, outputCentsPerMillion: 20,
    availability: "budget_disabled" as const, supportsVision: false };
  const routing = await loadOpeningRouting(fixture.sql, fixture.scope, { models: [server], defaultModelId: "server", dailyCapCents: 0, dailyQuotaMode: "unlimited" });
  expect(routing.settings).toMatchObject({ mode: "automatic", defaultModelId: null });
  expect(routing.settings.budgetConfirmedAt).toBeUndefined();
  expect(routing.merged.defaultModelId).toBe("server");
  expect(resolveModelForTask(routing.merged.models, routing.settings, "tutor.hint", routing.merged.defaultModelId).id).toBe("server");
  const providers = await fixture.sql`SELECT id FROM opening_model_providers WHERE workspace_id=${fixture.scope.workspaceId}`;
  expect(providers).toHaveLength(0);
});
