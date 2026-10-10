import { describe, expect, it } from "vitest";
import { mergeOpeningCatalog, resolveMergedDefaultModelId, type WorkspaceCatalogModel } from "./catalog-merge";

const server = {
  id: "server", providerId: "default", providerLabel: "默认供应商", label: "Server Model",
  modelName: "server-model", baseUrl: "https://server.example/v1", apiKey: "env-key",
  supportsVision: false, inputCentsPerMillion: 10, outputCentsPerMillion: 20,
  availability: "available" as const, source: "server" as const,
};
const custom = (over: Partial<WorkspaceCatalogModel> = {}): WorkspaceCatalogModel => ({
  id: "11111111-1111-4111-8111-111111111111", providerId: "22222222-2222-4222-8222-222222222222",
  providerLabel: "我的供应商", label: "My Model", modelName: "my-model",
  baseUrl: "https://mine.example/v1", apiKey: "mine-key", supportsVision: true,
  inputCentsPerMillion: 1, outputCentsPerMillion: 2, ...over,
});

describe("mergeOpeningCatalog", () => {
  it("appends workspace models with availability mirroring env semantics", () => {
    const merged = mergeOpeningCatalog([server], [custom()], { defaultModelId: "server", dailyCapCents: 100 });
    expect(merged.models.map(model => model.id)).toEqual(["server", "11111111-1111-4111-8111-111111111111"]);
    const entry = merged.models[1]!;
    expect(entry.availability).toBe("available");
    expect(entry.source).toBe("workspace");
    expect(entry.apiKey).toBe("mine-key");
    expect(merged.defaultModelId).toBe("server");
    expect(merged.dailyCapCents).toBe(100);
  });
  it("marks missing keys, disabled budgets and broken vault state", () => {
    const base = { defaultModelId: null, dailyCapCents: 100 };
    expect(mergeOpeningCatalog([], [custom({ apiKey: "" })], base).models[0]!.availability).toBe("missing_key");
    expect(mergeOpeningCatalog([], [custom()], { ...base, dailyCapCents: 0 }).models[0]!.availability).toBe("budget_disabled");
    expect(mergeOpeningCatalog([], [custom({ vaultConfigBroken: true })], base).models[0]!.availability).toBe("vault_disabled");
  });
  it("server ids win and the merged list stays capped at 32", () => {
    const clash = custom({ id: "server" });
    expect(mergeOpeningCatalog([server], [clash], { defaultModelId: "server", dailyCapCents: 100 }).models.map(model => model.id)).toEqual(["server"]);
    const filler = Array.from({ length: 32 }, (_, index) => ({ ...server, id: `fill-${index}` }));
    const merged = mergeOpeningCatalog(filler, [custom(), custom({ id: "second" })], { defaultModelId: "fill-0", dailyCapCents: 1 });
    expect(merged.models.length).toBe(32);
    expect(merged.models.some(model => model.source === "workspace")).toBe(false);
  });
  it("falls back to the first server model when the workspace default is null", () => {
    expect(mergeOpeningCatalog([server], [], { defaultModelId: null, dailyCapCents: 5 }).defaultModelId).toBe("server");
  });
  it("recomputes server availability from the effective daily cap", () => {
    const disabled = { ...server, availability: "budget_disabled" as const };
    expect(mergeOpeningCatalog([disabled], [], { defaultModelId: "server", dailyCapCents: 0 }).models[0]!.availability).toBe("budget_disabled");
    expect(mergeOpeningCatalog([disabled], [], { defaultModelId: "server", dailyCapCents: 100 }).models[0]!.availability).toBe("available");
  });
  it("keeps server missing_key and pricing_missing sticky across effective-cap recompute", () => {
    const missing = { ...server, availability: "missing_key" as const };
    const unpriced = { ...server, id: "unpriced", availability: "pricing_missing" as const };
    expect(mergeOpeningCatalog([missing], [], { defaultModelId: "server", dailyCapCents: 100 }).models[0]!.availability).toBe("missing_key");
    expect(mergeOpeningCatalog([unpriced], [], { defaultModelId: "unpriced", dailyCapCents: 100 }).models[0]!.availability).toBe("pricing_missing");
  });
  it("prefers an available workspace model over a missing_key env stub default", () => {
    const stub = {
      ...server,
      id: "default",
      modelName: "gpt-4o-mini",
      apiKey: "",
      availability: "missing_key" as const,
    };
    const lant = custom({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      label: "Lant GLM 5.3",
      modelName: "glm-5.3",
      providerLabel: "Lant",
      supportsVision: true,
    });
    const merged = mergeOpeningCatalog([stub], [lant], { defaultModelId: "default", dailyCapCents: 100 });
    expect(merged.defaultModelId).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(merged.models.find(model => model.id === merged.defaultModelId)?.availability).toBe("available");
  });
  it("keeps an available server default even when workspace models exist", () => {
    const merged = mergeOpeningCatalog([server], [custom()], { defaultModelId: "server", dailyCapCents: 100 });
    expect(merged.defaultModelId).toBe("server");
  });
});

describe("resolveMergedDefaultModelId", () => {
  it("returns requested when available, else first available workspace, else requested stub", () => {
    const models = [
      { id: "default", availability: "missing_key" as const, source: "server" as const },
      { id: "ws", availability: "available" as const, source: "workspace" as const },
    ];
    expect(resolveMergedDefaultModelId(models, "default")).toBe("ws");
    expect(resolveMergedDefaultModelId(
      [{ id: "default", availability: "available" as const, source: "server" as const }, models[1]!],
      "default",
    )).toBe("default");
    expect(resolveMergedDefaultModelId(
      [{ id: "default", availability: "missing_key" as const, source: "server" as const }],
      "default",
    )).toBe("default");
  });
});
