import { describe, expect, it } from "vitest";
import { DEFAULT_OPENING_AI_SETTINGS, openingAiSettingsSchema, openingModelSnapshotSchema } from "./ai-settings";
describe("AI routing settings boundary", () => {
  it("accepts explicit automatic mode routes and a manual model", () => {
    expect(openingAiSettingsSchema.parse(DEFAULT_OPENING_AI_SETTINGS).mode).toBe("automatic");
    expect(openingAiSettingsSchema.parse({ ...DEFAULT_OPENING_AI_SETTINGS, mode: "manual", manualModelId: "custom-1" }).manualModelId).toBe("custom-1");
  });
  it("normalizes only missing legacy manual ids and rejects explicit null or damaged selections", () => {
    const { manualModelId: _omitted, ...legacy } = DEFAULT_OPENING_AI_SETTINGS;
    expect(openingAiSettingsSchema.parse({ ...legacy, mode: "manual", defaultModelId: "legacy-model" })).toMatchObject({ manualModelId: "legacy-model", defaultModelId: "legacy-model" });
    expect(openingAiSettingsSchema.parse(legacy)).toMatchObject({ mode: "automatic", manualModelId: null, defaultModelId: null });
    for (const value of [
      { ...legacy, mode: "manual", defaultModelId: null },
      { ...legacy, mode: "manual", defaultModelId: "one", manualModelId: null },
      { ...legacy, mode: "manual", defaultModelId: "one", manualModelId: "../bad" },
    ]) expect(openingAiSettingsSchema.safeParse(value).success).toBe(false);
  });
  it("rejects endpoint/credential injection, unknown modes and invalid ids", () => {
    for (const patch of [{ baseUrl: "https://example.com" }, { apiKey: "private" }, { mode: "best" }, { defaultModelId: "../other" }, { routes: { listen: "one" } }]) {
      expect(openingAiSettingsSchema.safeParse({ ...DEFAULT_OPENING_AI_SETTINGS, ...patch }).success).toBe(false);
    }
  });
  it("keeps model usage snapshots bounded and secret-free", () => {
    const input = { id: "a", providerId: "p", modelName: "m", inputCentsPerMillion: 10, outputCentsPerMillion: 20 };
    expect(openingModelSnapshotSchema.parse(input)).toEqual(input);
    expect(openingModelSnapshotSchema.safeParse({ ...input, apiKey: "secret" }).success).toBe(false);
  });
});
