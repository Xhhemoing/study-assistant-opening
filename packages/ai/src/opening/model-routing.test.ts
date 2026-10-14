import { describe, expect, it } from "vitest";
import { DEFAULT_OPENING_AI_SETTINGS, type OpeningModelSummary } from "@aistudy/contracts";
import { openingModelSnapshot, resolveFallbackModelForTask, resolveModelForTask, resolveOpeningModel } from "./model-routing";
const first: OpeningModelSummary = { id: "one", providerId: "a", providerLabel: "A", label: "Large Name", modelName: "model-1", availability: "available", inputCentsPerMillion: 10, outputCentsPerMillion: 20 };
const second: OpeningModelSummary = { ...first, id: "two", providerId: "b", modelName: "model-2" };
describe("explicit model routing", () => {
  it("manual selection ignores automatic mappings", () => {
    const settings = { ...DEFAULT_OPENING_AI_SETTINGS, mode: "manual" as const, manualModelId: "two", routes: { ...DEFAULT_OPENING_AI_SETTINGS.routes, explain: "one" } };
    expect(resolveOpeningModel([first, second], settings, "explain", "one")).toBe(second);
  });
  it("automatic uses explicit mode override, workspace default, then server default", () => {
    const settings = { ...DEFAULT_OPENING_AI_SETTINGS, defaultModelId: "one", routes: { ...DEFAULT_OPENING_AI_SETTINGS.routes, explain: "two" } };
    expect(resolveOpeningModel([first, second], settings, "explain", "one")).toBe(second);
    expect(resolveOpeningModel([first, second], settings, "hint", "two")).toBe(first);
    expect(resolveOpeningModel([first, second], DEFAULT_OPENING_AI_SETTINGS, "hint", "two")).toBe(second);
  });
  it("never falls back when the explicit route disappears or becomes unavailable", () => {
    const settings = { ...DEFAULT_OPENING_AI_SETTINGS, defaultModelId: "one", routes: { ...DEFAULT_OPENING_AI_SETTINGS.routes, explain: "two" } };
    expect(() => resolveOpeningModel([first], settings, "explain", "one")).toThrow(/重新选择/);
    expect(() => resolveOpeningModel([first, { ...second, availability: "missing_key" }], settings, "explain", "one")).toThrow(/不会自动切换供应商/);
    expect(() => resolveOpeningModel([first], { ...DEFAULT_OPENING_AI_SETTINGS, mode: "manual" }, "explain", "one")).toThrow();
  });
  it("does not fall back from a removed or unavailable manual lock to automatic defaults", () => {
    const settings = { ...DEFAULT_OPENING_AI_SETTINGS, mode: "manual" as const, manualModelId: "two", defaultModelId: "one" };
    expect(() => resolveOpeningModel([first], settings, "explain", "one")).toThrow(/重新选择/);
    expect(() => resolveOpeningModel([first, { ...second, availability: "missing_key" }], settings, "explain", "one")).toThrow(/不会自动切换供应商/);
  });
  it("routes tutor tasks by mode and non-tutor tasks by default, never borrowing a tutor mode route", () => {
    const settings = { ...DEFAULT_OPENING_AI_SETTINGS, defaultModelId: "one", routes: { ...DEFAULT_OPENING_AI_SETTINGS.routes, explain: "two" } };
    expect(resolveModelForTask([first, second], settings, "tutor.explain", "one")).toBe(second);
    expect(resolveModelForTask([first, second], settings, "knowledge.extract", "two")).toBe(first);
    expect(resolveModelForTask([first, second], DEFAULT_OPENING_AI_SETTINGS, "knowledge.extract", "two")).toBe(second);
    const manual = { ...settings, mode: "manual" as const, manualModelId: "two" };
    expect(resolveModelForTask([first, second], manual, "knowledge.extract", "one")).toBe(second);
    expect(() => resolveModelForTask([first, { ...second, availability: "missing_key" }], manual, "knowledge.extract", "one")).toThrow(/不会自动切换供应商/);
  });
  it("task routes override mode routes; the manual lock overrides task routes; fallbacks are explicit", () => {
    const settings = { ...DEFAULT_OPENING_AI_SETTINGS, defaultModelId: "one", routes: { ...DEFAULT_OPENING_AI_SETTINGS.routes, explain: "one" },
      taskRoutes: { "tutor.explain": { primary: "two", fallback: null }, "knowledge.extract": { primary: null, fallback: "two" } } };
    expect(resolveModelForTask([first, second], settings, "tutor.explain", "one")).toBe(second);
    expect(resolveModelForTask([first, second], settings, "knowledge.extract", "one")).toBe(first);
    expect(resolveFallbackModelForTask([first, second], settings, "knowledge.extract")).toBe(second);
    expect(resolveFallbackModelForTask([first, second], settings, "tutor.explain")).toBeNull();
    expect(resolveFallbackModelForTask([first, { ...second, availability: "missing_key" }], settings, "knowledge.extract")).toBeNull();
    expect(resolveModelForTask([first, second], { ...settings, mode: "manual" as const, manualModelId: "one" }, "tutor.explain", "two")).toBe(first);
  });
  it("snapshots only routing identity and actual configured rates", () => {
    expect(openingModelSnapshot({ ...second, apiKey: "private" } as never)).toEqual({ id: "two", providerId: "b", modelName: "model-2", inputCentsPerMillion: 10, outputCentsPerMillion: 20 });
  });
});
