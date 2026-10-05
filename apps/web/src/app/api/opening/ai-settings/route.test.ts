import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_OPENING_AI_SETTINGS } from "@aistudy/contracts";
const mocks = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), catalog: vi.fn(), scope: vi.fn(), models: vi.fn() }));
vi.mock("../../../../features/opening/runtime", () => ({ requireOpeningScope: mocks.scope }));
vi.mock("@aistudy/config", async importOriginal => ({ ...await importOriginal<typeof import("@aistudy/config")>(), loadOpeningModelCatalog: mocks.catalog }));
vi.mock("@aistudy/database", async importOriginal => ({
  ...await importOriginal<typeof import("@aistudy/database")>(),
  createOpeningAiSettingsRepository: () => ({ get: mocks.get, set: mocks.set }),
  createOpeningModelProvidersRepository: () => ({ listResolvableModels: mocks.models }),
}));
import { ApiError } from "../../../../features/auth/service";
import { GET, PUT } from "./route";
import { switchRoutingMode } from "../../../../features/settings/ai-settings-model";
const model = { id: "one", providerId: "p", providerLabel: "P", modelName: "opaque", label: "One", baseUrl: "https://private-endpoint.example", apiKey: "never-return-me", inputCentsPerMillion: 10, outputCentsPerMillion: 20, availability: "available" as const };
const scope = { workspaceId: "w", ownerUserId: "u" };
const put = (body: unknown) => new Request("http://localhost/api/opening/ai-settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.scope.mockResolvedValue({ sql: {}, scope });
  mocks.catalog.mockReturnValue({ models: [model], defaultModelId: "one", dailyCapCents: 100 });
  mocks.get.mockResolvedValue({ settings: DEFAULT_OPENING_AI_SETTINGS, saved: false, invalidStoredSettings: false });
  mocks.set.mockResolvedValue(undefined);
  mocks.models.mockResolvedValue([]);
});
describe("AI settings HTTP boundary", () => {
  it("returns only public model metadata, never keys, endpoints or key variable names", async () => {
    const response = await GET(new Request("http://localhost/api/opening/ai-settings"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(text).toContain("opaque");
    expect(text).not.toContain("never-return-me");
    expect(text).not.toContain("private-endpoint");
    expect(text).not.toContain("apiKey");
    expect(mocks.get).toHaveBeenCalledWith(scope);
  });
  it("saves an explicit manual model scoped to the authenticated owner", async () => {
    const settings = { ...DEFAULT_OPENING_AI_SETTINGS, mode: "manual", manualModelId: "one" };
    expect((await PUT(put(settings))).status).toBe(200);
    expect(mocks.set).toHaveBeenCalledWith(scope, settings);
  });
  it.each([null, "one"])("preserves automatic default %s and all routes across manual save and reload", async defaultModelId => {
    const automatic = { ...DEFAULT_OPENING_AI_SETTINGS, defaultModelId, routes: { listen: "one", hint: "one", explain: "one", think_together: "one" } };
    const manual = switchRoutingMode(automatic, "manual", "one");
    mocks.set.mockImplementation(async (_scope, settings) => { mocks.get.mockResolvedValue({ settings, saved: true, invalidStoredSettings: false }); });
    expect((await PUT(put(manual))).status).toBe(200);
    const loaded = await (await GET(new Request("http://localhost/api/opening/ai-settings"))).json();
    const resumed = switchRoutingMode(loaded.settings, "automatic", "one");
    expect(resumed.defaultModelId).toBe(defaultModelId);
    expect(resumed.routes).toEqual(automatic.routes);
    expect((await PUT(put(resumed))).status).toBe(200);
  });
  it("saves a manual lock with inactive retired mappings, but rejects reactivating them", async () => {
    const manual = { ...DEFAULT_OPENING_AI_SETTINGS, mode: "manual", manualModelId: "one", routes: { ...DEFAULT_OPENING_AI_SETTINGS.routes, explain: "removed" } };
    expect((await PUT(put(manual))).status).toBe(200);
    expect(mocks.set).toHaveBeenCalledWith(scope, manual);
    mocks.set.mockClear();
    expect((await PUT(put({ ...manual, mode: "automatic" }))).status).toBe(422);
    expect(mocks.set).not.toHaveBeenCalled();
  });
  it("rejects manual mode without an explicit model and client endpoint injection", async () => {
    for (const patch of [{ mode: "manual" }, { apiKey: "injected" }, { baseUrl: "https://attacker.example" }]) {
      expect((await PUT(put({ ...DEFAULT_OPENING_AI_SETTINGS, ...patch }))).status).toBe(422);
    }
    expect(mocks.set).not.toHaveBeenCalled();
  });
  it("rejects unknown or unavailable active models without silently selecting another", async () => {
    expect((await PUT(put({ ...DEFAULT_OPENING_AI_SETTINGS, defaultModelId: "missing" }))).status).toBe(422);
    mocks.catalog.mockReturnValue({ models: [{ ...model, availability: "missing_key" }], defaultModelId: "one", dailyCapCents: 100 });
    expect((await PUT(put(DEFAULT_OPENING_AI_SETTINGS))).status).toBe(409);
    expect(mocks.set).not.toHaveBeenCalled();
  });
  it("allows recovery to server defaults even when no models are available", async () => {
    mocks.catalog.mockReturnValue({ models: [], defaultModelId: null, dailyCapCents: 0 });
    expect((await PUT(put(null))).status).toBe(200);
    expect(mocks.set).toHaveBeenCalledWith(scope, null);
  });
  it("requires authentication before reading settings or mutating them", async () => {
    mocks.scope.mockRejectedValue(new ApiError("UNAUTHENTICATED", "Authentication required", 401));
    expect((await GET(new Request("http://localhost/api/opening/ai-settings"))).status).toBe(401);
    expect((await PUT(put(null))).status).toBe(401);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.set).not.toHaveBeenCalled();
  });
  it("bounds request bodies before processing configuration", async () => {
    expect((await PUT(put({ text: "x".repeat(17_000) }))).status).toBe(413);
    expect(mocks.set).not.toHaveBeenCalled();
  });
});
