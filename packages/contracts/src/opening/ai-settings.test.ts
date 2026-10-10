import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPENING_AI_SETTINGS,
  OPENING_AI_SETTINGS_DAILY_CAP_SCHEMA_MAX_CENTS,
  openingAiSettingsSchema,
  openingModelSnapshotSchema,
} from "./ai-settings";
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
  it("parses env-scale dailyCapCents and null without wiping model routes (Hermes hotfix)", () => {
    const lantId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const withLargeCap = {
      ...DEFAULT_OPENING_AI_SETTINGS,
      defaultModelId: lantId,
      routes: { listen: lantId, hint: lantId, explain: lantId, think_together: lantId },
      dailyCapCents: 1_000_000,
      budgetConfirmedAt: "2026-10-10T00:00:00.000Z",
    };
    const parsed = openingAiSettingsSchema.parse(withLargeCap);
    expect(parsed.dailyCapCents).toBe(1_000_000);
    expect(parsed.defaultModelId).toBe(lantId);
    expect(parsed.routes.explain).toBe(lantId);

    const withNull = openingAiSettingsSchema.parse({
      ...withLargeCap,
      dailyCapCents: null,
      budgetConfirmedAt: null,
    });
    expect(withNull.dailyCapCents).toBeNull();
    expect(withNull.defaultModelId).toBe(lantId);

    expect(openingAiSettingsSchema.safeParse({
      ...DEFAULT_OPENING_AI_SETTINGS,
      dailyCapCents: OPENING_AI_SETTINGS_DAILY_CAP_SCHEMA_MAX_CENTS,
    }).success).toBe(true);
    expect(openingAiSettingsSchema.safeParse({
      ...DEFAULT_OPENING_AI_SETTINGS,
      dailyCapCents: OPENING_AI_SETTINGS_DAILY_CAP_SCHEMA_MAX_CENTS + 1,
    }).success).toBe(false);
    expect(openingAiSettingsSchema.safeParse({
      ...DEFAULT_OPENING_AI_SETTINGS,
      dailyCapCents: -1,
    }).success).toBe(false);
  });
});
