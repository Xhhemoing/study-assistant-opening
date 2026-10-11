import { describe, expect, it } from "vitest";
import { DEFAULT_OPENING_AI_SETTINGS, openingAiSettingsSchema, openingAiSettingsResponseSchema, openingModelSnapshotSchema } from "./ai-settings";
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
  it("treats missing workspace budget fields as unset (legacy JSON)", () => {
    const { dailyCapCents: _c, budgetConfirmedAt: _b, ...legacy } = DEFAULT_OPENING_AI_SETTINGS;
    const parsed = openingAiSettingsSchema.parse(legacy);
    expect(parsed.dailyCapCents).toBeNull();
    expect(parsed.budgetConfirmedAt).toBeNull();
  });
  it("accepts workspace dailyCapCents and budgetConfirmedAt", () => {
    expect(openingAiSettingsSchema.parse({
      ...DEFAULT_OPENING_AI_SETTINGS,
      dailyCapCents: 1500,
      budgetConfirmedAt: "2026-10-11T12:00:00.000Z",
    })).toMatchObject({ dailyCapCents: 1500, budgetConfirmedAt: "2026-10-11T12:00:00.000Z" });
  });
  it("response schema requires effective cap fields without secrets", () => {
    const body = {
      models: [],
      defaultModelId: null,
      dailyCapCents: 0,
      envDailyCapCents: 0,
      workspaceDailyCapCents: null,
      budgetConfirmedAt: null,
      effectiveCapSource: "disabled",
      settings: DEFAULT_OPENING_AI_SETTINGS,
      saved: false,
      invalidStoredSettings: false,
    };
    expect(openingAiSettingsResponseSchema.parse(body).effectiveCapSource).toBe("disabled");
    expect(openingAiSettingsResponseSchema.safeParse({
      ...body,
      models: [{
        id: "a", providerId: "p", providerLabel: "P", label: "L", modelName: "m",
        availability: "available", inputCentsPerMillion: 1, outputCentsPerMillion: 2, apiKey: "secret",
      }],
    }).success).toBe(false);
  });
});
