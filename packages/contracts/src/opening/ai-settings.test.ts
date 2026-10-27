import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPENING_AI_SETTINGS,
  OPENING_AI_SETTINGS_DAILY_CAP_SCHEMA_MAX_CENTS,
  openingAiSettingsSchema,
  openingAiSettingsResponseSchema,
  openingAiDailyUsageSchema,
  openingDailyQuotaSchema,
  openingModelSnapshotSchema,
  modelTaskKeySchema,
} from "./ai-settings";
describe("AI routing settings boundary", () => {
  it("distinguishes measured zero daily spend from unavailable usage and rejects invalid money", () => {
    const usage = { localDate: "2026-10-26", timeZone: "Asia/Shanghai", spentCents: 0, reservedCents: 12 };
    expect(openingAiDailyUsageSchema.parse(usage)).toEqual(usage);
    for (const spentCents of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(openingAiDailyUsageSchema.safeParse({ ...usage, spentCents }).success).toBe(false);
    }
    expect(openingAiDailyUsageSchema.safeParse({ ...usage, reservedCents: -1 }).success).toBe(false);
    const response = { models: [], defaultModelId: null, dailyCapCents: 0, envCapCents: 0, personalCeilingCents: 2000, settings: DEFAULT_OPENING_AI_SETTINGS, saved: false, invalidStoredSettings: false };
    expect(openingAiSettingsResponseSchema.parse({ ...response, dailyUsage: usage }).dailyUsage).toEqual(usage);
    expect(openingAiSettingsResponseSchema.parse({ ...response, dailyUsage: null }).dailyUsage).toBeNull();
    expect(openingAiSettingsResponseSchema.parse(response)).not.toHaveProperty("dailyUsage");
    expect(openingAiSettingsSchema.safeParse({ ...DEFAULT_OPENING_AI_SETTINGS, dailyUsage: usage }).success).toBe(false);
  });
  it("accepts optional server-owned daily quota metadata without reinterpreting legacy zero or null", () => {
    const response = { models: [], defaultModelId: null, dailyCapCents: 0, envCapCents: 0, personalCeilingCents: 2000, settings: { ...DEFAULT_OPENING_AI_SETTINGS, dailyCapCents: null }, saved: false, invalidStoredSettings: false };
    expect(openingAiSettingsResponseSchema.parse(response)).not.toHaveProperty("dailyQuota");
    for (const dailyQuota of [{ mode: "limited", capCents: 0 }, { mode: "limited", capCents: 2_147_483_647 }, { mode: "unlimited" }]) {
      expect(openingDailyQuotaSchema.parse(dailyQuota)).toEqual(dailyQuota);
      expect(openingAiSettingsResponseSchema.parse({ ...response, dailyQuota })).toMatchObject({ dailyQuota, dailyCapCents: 0, settings: { dailyCapCents: null } });
      expect(openingAiSettingsSchema.safeParse({ ...DEFAULT_OPENING_AI_SETTINGS, dailyQuota }).success).toBe(false);
    }
  });
  it.each([{ mode: "unlimited", capCents: 0 }, { mode: "limited" }, { mode: "limited", capCents: -1 }, { mode: "limited", capCents: Infinity }, { mode: "limited", capCents: 1.5 }, { mode: "limited", capCents: 2_147_483_648 }, { mode: "other" }])("rejects ambiguous or unbounded finite daily quota %j", quota => {
    expect(openingDailyQuotaSchema.safeParse(quota).success).toBe(false);
  });
  it.each(["practice.grade-photo", "tutor.think_together", "group2.task-v2", `${"a".repeat(32)}.${"b".repeat(32)}`])("accepts stable task key %s in persisted routes", key => {
    expect(modelTaskKeySchema.parse(key)).toBe(key);
    const taskRoutes = { [key]: { primary: "custom-1", fallback: null } };
    expect(openingAiSettingsSchema.parse({ ...DEFAULT_OPENING_AI_SETTINGS, taskRoutes }).taskRoutes).toEqual(taskRoutes);
  });
  it.each(["", "practice", "practice..photo", "Practice.photo", "practice.Grade-photo", "-practice.photo", "practice.1photo", "practice/photo", "practice.photo key", `${"a".repeat(33)}.task`, `group.${"b".repeat(33)}`])("rejects malformed task key %s", key => {
    expect(modelTaskKeySchema.safeParse(key).success).toBe(false);
    expect(openingAiSettingsSchema.safeParse({ ...DEFAULT_OPENING_AI_SETTINGS, taskRoutes: { [key]: { primary: null, fallback: null } } }).success).toBe(false);
  });
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
