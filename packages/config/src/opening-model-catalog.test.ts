import { describe, expect, it } from "vitest";
import { loadOpeningModelCatalog } from "./opening-model-catalog";
const entry = { id: "fast", label: "Fast", providerId: "p", providerLabel: "Provider", modelName: "opaque-model", baseUrl: "https://provider.example/v1", apiKeyEnv: "PROVIDER_KEY", inputCentsPerMillion: 10, outputCentsPerMillion: 20 };
const env = { OPENING_MODEL_CATALOG: JSON.stringify([entry]), OPENING_MODEL_DAILY_CAP_CENTS: "100", PROVIDER_KEY: "private-key" };
describe("server model catalog", () => {
  it("preserves all legacy environment defaults", () => {
    expect(loadOpeningModelCatalog({})).toMatchObject({ defaultModelId: "default", dailyCapCents: 0, models: [{ id: "default", modelName: "gpt-4o-mini", availability: "missing_key" }] });
  });
  it("uses directory pricing without validating the retired legacy model", () => {
    const changed = { ...env, OPENING_MODEL_API_KEY: "old-key", OPENING_MODEL_INPUT_CENTS_PER_MILLION: "0", OPENING_MODEL_OUTPUT_CENTS_PER_MILLION: "0", OPENING_MODEL_BASE_URL: "retired-value" };
    expect(loadOpeningModelCatalog(changed).models[0]!.availability).toBe("available");
    expect(() => loadOpeningModelCatalog({ ...changed, OPENING_MODEL_CATALOG: "" })).toThrow();
    expect(() => loadOpeningModelCatalog({ ...changed, OPENING_MODEL_DAILY_CAP_CENTS: "-1" })).toThrow();
  });  it("resolves only explicitly named server secrets with shared budget", () => {
    expect(loadOpeningModelCatalog(env)).toMatchObject({ dailyCapCents: 100, models: [{ id: "fast", apiKey: "private-key", availability: "available" }] });
  });
  it("reports missing key, price and disabled budget without inventing availability", () => {
    expect(loadOpeningModelCatalog({ ...env, PROVIDER_KEY: "" }).models[0]!.availability).toBe("missing_key");
    expect(loadOpeningModelCatalog({ ...env, OPENING_MODEL_DAILY_CAP_CENTS: "0" }).models[0]!.availability).toBe("budget_disabled");
    expect(loadOpeningModelCatalog({ ...env, OPENING_MODEL_CATALOG: JSON.stringify([{ ...entry, inputCentsPerMillion: 0 }]) }).models[0]!.availability).toBe("pricing_missing");
  });
  it("supports an explicitly empty directory and validates the default id", () => {
    expect(loadOpeningModelCatalog({ OPENING_MODEL_CATALOG: "[]" })).toMatchObject({ models: [], defaultModelId: null });
    expect(() => loadOpeningModelCatalog({ ...env, OPENING_MODEL_DEFAULT_ID: "missing" })).toThrow(/配置无效/);
  });
  it("rejects duplicate ids, unsupported endpoints and inline keys without leaking them", () => {
    for (const models of [[entry, entry], [{ ...entry, baseUrl: "http://untrusted.example" }], [{ ...entry, apiKey: "super-private" }], [{ ...entry, baseUrl: "https://secret:password@provider.example" }]]) {
      try { loadOpeningModelCatalog({ ...env, OPENING_MODEL_CATALOG: JSON.stringify(models) }); throw new Error("should reject"); }
      catch (error) { expect(String(error)).toContain("配置无效"); expect(String(error)).not.toContain("private"); expect(String(error)).not.toContain("password"); }
    }
  });
});
