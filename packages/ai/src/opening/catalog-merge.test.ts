import { describe, expect, it } from "vitest";
import { mergeOpeningCatalog, type WorkspaceCatalogModel } from "./catalog-merge";

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
  inputCentsPerMillion: 1, outputCentsPerMillion: 2, createdAt: "2026-01-01T00:00:00.000Z", ...over,
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
});
