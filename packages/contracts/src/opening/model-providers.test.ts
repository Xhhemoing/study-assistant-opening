import { describe, expect, it } from "vitest";
import { isOpeningProviderBaseUrl, normalizeOpeningProviderBaseUrl, openingProviderInputSchema } from "./model-providers";

describe("provider endpoint contract", () => {
  it("normalizes equivalent URLs for credential destination comparisons", () => {
    expect(normalizeOpeningProviderBaseUrl(" HTTPS://API.EXAMPLE.COM:443/v1/ ")).toBe("https://api.example.com/v1");
    expect(openingProviderInputSchema.parse({ label: "Model", baseUrl: "https://api.example.com/v1/" }).baseUrl).toBe("https://api.example.com/v1");
  });
  it("validates local URL syntax without reading server environment policy", () => {
    expect(openingProviderInputSchema.parse({ label: "Model", baseUrl: "http://localhost:8000/v1" }).baseUrl).toBe("http://localhost:8000/v1");
    expect(isOpeningProviderBaseUrl("http://localhost:8000/v1", { allowLocal: false })).toBe(false);
    expect(isOpeningProviderBaseUrl("http://localhost:8000/v1", { allowLocal: true })).toBe(true);
  });
  it.each(["http://remote.example", "https://user:secret@provider.example", "https://provider.example/?q=x", "https://provider.example/#x"])("rejects invalid endpoint %s", value => {
    expect(isOpeningProviderBaseUrl(value)).toBe(false);
  });
});

describe("workspace media cost bound contract", () => {
  const base = { label: "Vision", modelName: "v", inputCentsPerMillion: 1, outputCentsPerMillion: 2 };
  const media = { mediaInputTokenUpperBound: 128000, mediaMaxInputBytes: 1048576, mediaInputCentsPerMillion: 3 };
  it("allows text-only models and complete media bounds; rejects partial or invalid bounds", async () => {
    const { openingProviderModelInputSchema: schema } = await import("./model-providers");
    expect(schema.safeParse(base).success).toBe(true);
    expect(schema.safeParse({ ...base, ...media }).success).toBe(true);
    expect(schema.safeParse({ ...base, mediaInputTokenUpperBound: 128000 }).success).toBe(false);
    for (const patch of [{ mediaMaxInputBytes: 104857601 }, { mediaInputTokenUpperBound: 0 },
      { mediaInputTokenUpperBound: Number.MAX_SAFE_INTEGER + 1 }, { mediaInputCentsPerMillion: Number.NaN }, { mediaInputCentsPerMillion: 0 }]) {
      expect(schema.safeParse({ ...base, ...media, ...patch }).success).toBe(false);
    }
    expect(schema.safeParse({ ...base, ...media, billing: "free_tier", dailyRequestCap: 10, mediaInputCentsPerMillion: 0 }).success).toBe(true);
  });
  it("requires an atomic three-field update and permits clearing all three", async () => {
    const { openingProviderModelUpdateSchema: schema } = await import("./model-providers");
    expect(schema.safeParse({ label: "Renamed" }).success).toBe(true);
    expect(schema.safeParse(media).success).toBe(true);
    expect(schema.safeParse({ mediaInputTokenUpperBound: null }).success).toBe(false);
    expect(schema.safeParse({ mediaInputTokenUpperBound: null, mediaMaxInputBytes: null, mediaInputCentsPerMillion: null }).success).toBe(true);
  });
  it("carries complete media bounds through one-click setup", async () => {
    const { openingModelQuickSetupInputSchema: schema } = await import("./model-providers");
    const setup = { ...base, ...media, clientKey: "media-quick-setup", baseUrl: "https://model.example/v1", apiKey: "test", dailyCapCents: 100, confirmBudget: true };
    expect(schema.parse(setup)).toMatchObject(media);
    expect(schema.safeParse({ ...setup, mediaMaxInputBytes: undefined }).success).toBe(false);
  });
});
