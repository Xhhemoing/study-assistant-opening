import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_OPENING_AI_SETTINGS } from "@aistudy/contracts";
const mocks = vi.hoisted(() => ({ catalog: vi.fn(), get: vi.fn(), provider: vi.fn(), models: vi.fn() }));
vi.mock("@aistudy/config", async original => ({ ...await original<typeof import("@aistudy/config")>(), loadOpeningModelCatalog: mocks.catalog }));
vi.mock("@aistudy/database", async original => ({
  ...await original<typeof import("@aistudy/database")>(),
  createOpeningAiSettingsRepository: () => ({ get: mocks.get }),
  createOpeningModelProvidersRepository: () => ({ listResolvableModels: mocks.models }),
}));
vi.mock("@aistudy/ai", async original => ({ ...await original<typeof import("@aistudy/ai")>(), createOpeningProvider: mocks.provider }));
import { resolveTutorModel } from "./tutor-model";
const scope = { workspaceId: "workspace", ownerUserId: "owner" };
const model = { id: "chosen", providerId: "secondary", providerLabel: "Secondary", label: "Chosen", modelName: "actual-model", availability: "available", inputCentsPerMillion: 5, outputCentsPerMillion: 7, apiKey: "private", baseUrl: "https://provider.example/v1", supportsVision: true };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.catalog.mockReturnValue({ models: [model], defaultModelId: "chosen", dailyCapCents: 100 });
  mocks.get.mockResolvedValue({ settings: DEFAULT_OPENING_AI_SETTINGS, saved: false, invalidStoredSettings: false });
  mocks.provider.mockReturnValue({ complete: vi.fn() });
  mocks.models.mockResolvedValue([]);
});
describe("shared tutor model selection", () => {
  it("joins one owner-scoped choice to provider options and the exact ledger prices", async () => {
    const selected = await resolveTutorModel({} as never, scope, "hint");
    expect(mocks.get).toHaveBeenCalledWith(scope);
    expect(mocks.provider).toHaveBeenCalledWith({ baseUrl: model.baseUrl, apiKey: model.apiKey, model: model.modelName, supportsVision: true });
    expect(selected.modelSnapshot).toEqual({ id: "chosen", providerId: "secondary", modelName: "actual-model", inputCentsPerMillion: 5, outputCentsPerMillion: 7 });
    expect(selected.inputCentsPerMillion).toBe(5);
    expect(selected.outputCentsPerMillion).toBe(7);
    expect(JSON.stringify(selected.modelSnapshot)).not.toContain("private");
  });
  it("honors stored mappings over the deployment default", async () => {
    const other = { ...model, id: "default", modelName: "different-model" };
    mocks.catalog.mockReturnValue({ models: [other, model], defaultModelId: "default", dailyCapCents: 100 });
    mocks.get.mockResolvedValue({ settings: { ...DEFAULT_OPENING_AI_SETTINGS, routes: { ...DEFAULT_OPENING_AI_SETTINGS.routes, explain: "chosen" } }, saved: true, invalidStoredSettings: false });
    expect((await resolveTutorModel({} as never, scope, "explain")).modelSnapshot.id).toBe("chosen");
    expect((await resolveTutorModel({} as never, scope, "listen")).modelSnapshot.id).toBe("default");
  });
  it("blocks invalid stored settings before constructing a provider", async () => {
    mocks.get.mockResolvedValue({ settings: DEFAULT_OPENING_AI_SETTINGS, saved: true, invalidStoredSettings: true });
    await expect(resolveTutorModel({} as never, scope, "hint")).rejects.toThrow(/重新保存/);
    expect(mocks.provider).not.toHaveBeenCalled();
  });
  it("blocks a removed manual selection instead of using the deployment default", async () => {
    mocks.get.mockResolvedValue({ settings: { ...DEFAULT_OPENING_AI_SETTINGS, mode: "manual", manualModelId: "removed" }, saved: true, invalidStoredSettings: false });
    await expect(resolveTutorModel({} as never, scope, "hint")).rejects.toThrow(/重新选择/);
    expect(mocks.provider).not.toHaveBeenCalled();
  });
  it("prefers workspace Lant/glm when env default is a missing_key stub and workspace budget is on", async () => {
    const stub = {
      id: "default", providerId: "default", providerLabel: "默认供应商", label: "gpt-4o-mini",
      modelName: "gpt-4o-mini", availability: "missing_key" as const, inputCentsPerMillion: 0, outputCentsPerMillion: 0,
      apiKey: "", baseUrl: "https://api.openai.com/v1", supportsVision: false,
    };
    const lant = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      providerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      providerLabel: "Lant", label: "Lant GLM 5.3", modelName: "glm-5.3",
      baseUrl: "https://lant.example/v1", apiKey: "lant-key", supportsVision: true,
      inputCentsPerMillion: 10, outputCentsPerMillion: 20,
    };
    mocks.catalog.mockReturnValue({ models: [stub], defaultModelId: "default", dailyCapCents: 0 });
    mocks.models.mockResolvedValue([lant]);
    mocks.get.mockResolvedValue({
      settings: {
        ...DEFAULT_OPENING_AI_SETTINGS,
        dailyCapCents: 500,
        budgetConfirmedAt: "2026-10-10T00:00:00.000Z",
      },
      saved: true,
      invalidStoredSettings: false,
    });
    const selected = await resolveTutorModel({} as never, scope, "explain");
    expect(selected.modelSnapshot).toEqual({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      providerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      modelName: "glm-5.3",
      inputCentsPerMillion: 10,
      outputCentsPerMillion: 20,
    });
    expect(mocks.provider).toHaveBeenCalledWith({
      baseUrl: lant.baseUrl, apiKey: lant.apiKey, model: "glm-5.3", supportsVision: true,
    });
  });
  it("keeps budget 0 as a hard block even when a workspace Lant key exists", async () => {
    const stub = {
      id: "default", providerId: "default", providerLabel: "默认供应商", label: "gpt-4o-mini",
      modelName: "gpt-4o-mini", availability: "missing_key" as const, inputCentsPerMillion: 0, outputCentsPerMillion: 0,
      apiKey: "", baseUrl: "https://api.openai.com/v1", supportsVision: false,
    };
    const lant = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      providerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      providerLabel: "Lant", label: "Lant GLM 5.3", modelName: "glm-5.3",
      baseUrl: "https://lant.example/v1", apiKey: "lant-key", supportsVision: true,
      inputCentsPerMillion: 10, outputCentsPerMillion: 20,
    };
    mocks.catalog.mockReturnValue({ models: [stub], defaultModelId: "default", dailyCapCents: 0 });
    mocks.models.mockResolvedValue([lant]);
    mocks.get.mockResolvedValue({ settings: DEFAULT_OPENING_AI_SETTINGS, saved: false, invalidStoredSettings: false });
    await expect(resolveTutorModel({} as never, scope, "explain")).rejects.toThrow(/不会自动切换供应商|暂不可用/);
    expect(mocks.provider).not.toHaveBeenCalled();
  });
});
