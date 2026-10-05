import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import { createOpeningFixture, type OpeningFixture } from "../opening-fixture";
import { GET as listProviders, POST as createProvider } from "../../../apps/web/src/app/api/opening/model-providers/route";
import { DELETE as deleteProvider, PUT as updateProvider } from "../../../apps/web/src/app/api/opening/model-providers/[id]/route";
import { POST as createModel } from "../../../apps/web/src/app/api/opening/model-providers/[id]/models/route";
import { DELETE as deleteModel, PUT as updateModel } from "../../../apps/web/src/app/api/opening/model-providers/[id]/models/[modelId]/route";
import { GET as readSettings, PUT as saveSettings } from "../../../apps/web/src/app/api/opening/ai-settings/route";

let f: OpeningFixture;
let runtime: ReturnType<typeof createAuthRuntime>;
const providerKey = "sk-handler-secret-9876";
function req(method: string, body?: unknown, cookie?: string) {
  return new Request("https://localhost/api/opening/model-providers", {
    method, headers: { cookie: cookie ?? f.cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const providerInput = { label: "自建供应商", baseUrl: "https://api.example.com/v1", apiKey: providerKey };
const modelInput = { label: "主力", modelName: "main-model", inputCentsPerMillion: 2, outputCentsPerMillion: 4, supportsVision: false };
const idContext = (id: string) => ({ params: Promise.resolve({ id }) });
const modelContext = (id: string, modelId: string) => ({ params: Promise.resolve({ id, modelId }) });

beforeAll(async () => {
  f = await createOpeningFixture();
  runtime = createAuthRuntime({ databaseUrl: process.env.DATABASE_URL!, authSecret: process.env.AUTH_SECRET ?? "opening-fixture-secret-opening-fixture-secret", sessionCookieSecure: false, sessionTtlSeconds: 3600, authCookieName: "aistudy_session" });
  setAuthRuntimeForTests(runtime);
});
beforeEach(async () => {
  await f.sql`DELETE FROM opening_model_providers WHERE workspace_id IN (${f.scope.workspaceId},${f.otherScope.workspaceId})`;
  vi.stubEnv("OPENING_CONNECTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  vi.stubEnv("OPENING_CONNECTION_KEY_ID", "test-key");
  vi.stubEnv("OPENING_CONNECTION_PREVIOUS_KEYS", "{}");
  vi.stubEnv("OPENING_MODEL_DAILY_CAP_CENTS", "500");
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  setAuthRuntimeForTests(null); await runtime?.close();
  if (f) { await f.sql`DELETE FROM workspaces WHERE id IN (${f.scope.workspaceId},${f.otherScope.workspaceId})`; await f.close(); }
});

async function createProviderWithKey() {
  const response = await createProvider(req("POST", providerInput));
  expect(response.status).toBe(201);
  const provider = await response.json();
  const modelResponse = await createModel(req("POST", modelInput), idContext(provider.id));
  expect(modelResponse.status).toBe(201);
  const model = await modelResponse.json();
  return { provider, model };
}

describe("model provider handlers", () => {
  it("requires a session and rejects malformed input without partial writes", async () => {
    expect((await listProviders(req("GET", undefined, ""))).status).toBe(401);
    expect((await createProvider(req("POST", { label: "x", baseUrl: "notaurl" }))).status).toBe(422);
    expect((await createProvider(req("POST", { label: "x", baseUrl: "http://remote.example.com", apiKey: "k" }))).status).toBe(422);
    expect((await createProvider(req("POST", { label: "x", baseUrl: "https://ok.example.com", apiKey: "k", extra: 1 }))).status).toBe(422);
    expect((await createProvider(req("POST", { ...providerInput }))).status).toBe(201);
    const body = await (await listProviders(req("GET"))).json();
    expect(body.providers).toHaveLength(1);
    await deleteProvider(req("DELETE"), idContext(body.providers[0].id));
    expect((await listProviders(req("GET"))).status).toBe(200);
  });
  it("never returns key material; only a masked hint and presence flag", async () => {
    const { provider } = await createProviderWithKey();
    expect(provider.hasApiKey).toBe(true);
    expect(provider.apiKeyHint).toBe("9876");
    expect(provider.apiKey).toBeUndefined();
    const listText = await (await listProviders(req("GET"))).text();
    expect(listText).not.toContain(providerKey);
    expect(listText).not.toContain("ciphertext");
    const settingsText = await (await readSettings(req("GET"))).text();
    expect(settingsText).not.toContain(providerKey);
  });
  it("exposes workspace models through the merged ai-settings catalog", async () => {
    const { model } = await createProviderWithKey();
    const data = await (await readSettings(req("GET"))).json();
    const entry = data.models.find((item: { id: string }) => item.id === model.id);
    expect(entry).toBeTruthy();
    expect(entry.availability).toBe("available");
    expect(entry.source).toBe("workspace");
    // Custom default can be saved like any env-catalog model.
    const save = await saveSettings(req("PUT", { mode: "manual", defaultModelId: null, manualModelId: model.id, routes: { listen: null, hint: null, explain: null, think_together: null } }));
    expect(save.status).toBe(200);
    const saved = await save.json();
    expect(saved.settings.manualModelId).toBe(model.id);
    expect(saved.models.some((item: { id: string; source?: string }) => item.id === model.id && item.source === "workspace")).toBe(true);
  });
  it("rejects unknown ids with 404", async () => {
    const { provider, model } = await createProviderWithKey();
    expect((await updateProvider(req("PUT", { label: "X" }), idContext("22222222-2222-4222-8222-222222222222"))).status).toBe(404);
    expect((await deleteProvider(req("DELETE"), idContext("22222222-2222-4222-8222-222222222222"))).status).toBe(404);
    expect((await deleteModel(req("DELETE"), modelContext(provider.id, "22222222-2222-4222-8222-222222222222"))).status).toBe(404);
    expect((await updateModel(req("PUT", { label: "Y" }), modelContext(provider.id, model.id))).status).toBe(200);
  });
  it("surfaces a broken vault as 503 instead of leaking a client error", async () => {
    const response = await createProvider(req("POST", providerInput));
    const provider = await response.json();
    vi.stubEnv("OPENING_CONNECTION_KEY", "");
    const broken = await createProvider(req("POST", { ...providerInput, label: "第二家" }));
    expect(broken.status).toBe(503);
    const update = await updateProvider(req("PUT", { apiKey: "new-key" }), idContext(provider.id));
    expect(update.status).toBe(503);
  });
  it("deletes providers and models through the API", async () => {
    const { provider, model } = await createProviderWithKey();
    expect((await deleteModel(req("DELETE"), modelContext(provider.id, model.id))).status).toBe(204);
    expect((await deleteProvider(req("DELETE"), idContext(provider.id))).status).toBe(204);
    const body = await (await listProviders(req("GET"))).json();
    expect(body.providers).toHaveLength(0);
    expect(body.models).toHaveLength(0);
  });
});
