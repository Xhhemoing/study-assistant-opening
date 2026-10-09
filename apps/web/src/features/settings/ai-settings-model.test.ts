import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_OPENING_AI_SETTINGS, openingAiSettingsSchema, type OpeningAiSettingsResponse } from "@aistudy/contracts";
import { effectiveModelRoutes, hasRemovedActiveModel, modelOptions, switchRoutingMode } from "./ai-settings-model";
import { AiSettingsForm } from "./ai-settings-panel";
const data: OpeningAiSettingsResponse = {
  defaultModelId: "a", dailyCapCents: 200, envCapCents: 200, personalCeilingCents: 2000, settings: DEFAULT_OPENING_AI_SETTINGS, saved: false, invalidStoredSettings: false,
  models: [{ id: "a", providerId: "one", providerLabel: "One", label: "Model A", modelName: "a", inputCentsPerMillion: 10, outputCentsPerMillion: 20, availability: "available" },
    { id: "b", providerId: "two", providerLabel: "Two", label: "Model B", modelName: "b", inputCentsPerMillion: 30, outputCentsPerMillion: 40, availability: "missing_key" }],
};
describe("AI settings presentation", () => {
  it("preserves mode mappings through a temporary manual lock and ignores inactive removed routes", () => {
    const automatic = { ...DEFAULT_OPENING_AI_SETTINGS, defaultModelId: "a", routes: { ...DEFAULT_OPENING_AI_SETTINGS.routes, explain: "b", hint: "removed" } };
    const manual = switchRoutingMode(automatic, "manual", "a");
    expect(manual.routes).toEqual(automatic.routes);
    expect(hasRemovedActiveModel(data, manual)).toBe(false);
    expect(effectiveModelRoutes(data, manual).every(route => route.id === "a" && route.problem === null)).toBe(true);
    const resumed = switchRoutingMode(manual, "automatic", "a");
    expect(resumed.defaultModelId).toBe(automatic.defaultModelId);
    expect(resumed.routes).toEqual(automatic.routes);
    expect(hasRemovedActiveModel(data, resumed)).toBe(true);
  });
  it("keeps automatic server-following null through manual save and reload", () => {
    const manual = switchRoutingMode(DEFAULT_OPENING_AI_SETTINGS, "manual", "a");
    expect(manual).toMatchObject({ manualModelId: "a", defaultModelId: null });
    const reloaded = openingAiSettingsSchema.parse(JSON.parse(JSON.stringify(manual)));
    const resumed = switchRoutingMode(reloaded, "automatic", "b");
    expect(resumed.defaultModelId).toBeNull();
    expect(resumed.manualModelId).toBe("a");
    expect(effectiveModelRoutes({ ...data, defaultModelId: "b" }, resumed).every(route => route.id === "b")).toBe(true);
  });

  it("retains explicit automatic default and all four mappings when changing a manual lock", () => {
    const automatic = { ...DEFAULT_OPENING_AI_SETTINGS, defaultModelId: "a", routes: { listen: "a", hint: "b", explain: "b", think_together: "a" } };
    const manual = { ...switchRoutingMode(automatic, "manual", "b"), manualModelId: "b" };
    const reloaded = openingAiSettingsSchema.parse(JSON.parse(JSON.stringify(manual)));
    const resumed = switchRoutingMode(reloaded, "automatic", "b");
    expect(resumed.defaultModelId).toBe("a");
    expect(resumed.routes).toEqual(automatic.routes);
    expect(switchRoutingMode(resumed, "manual", "a").manualModelId).toBe("b");
  });
  it("supplier filtering retains the current selection without replacing it", () => {
    expect(modelOptions(data.models, "one", "b").map(model => model.id)).toEqual(["a", "b"]);
    expect(modelOptions(data.models, "one", null).map(model => model.id)).toEqual(["a"]);
  });
  it("shows exact effective mode rules and unavailable models", () => {
    const routes = effectiveModelRoutes(data, { ...DEFAULT_OPENING_AI_SETTINGS, routes: { ...DEFAULT_OPENING_AI_SETTINGS.routes, explain: "b", hint: "removed" } });
    expect(routes.find(route => route.mode === "explain")?.problem).toBe("缺少服务器密钥");
    expect(routes.find(route => route.mode === "hint")?.problem).toContain("移除");
    expect(routes.find(route => route.mode === "listen")?.id).toBe("a");
  });
  it("renders accessible mode controls, explicit costs and recovery", () => {
    const html = renderToStaticMarkup(createElement(AiSettingsForm, { data, draft: data.settings, busy: false, onChange() {}, onSave() {}, onReset() {} }));
    expect(html).toContain('name="ai-routing-mode"');
    expect(html).toContain("不会自动重试或改用其他供应商");
    expect(html).toContain("不自动换汇");
    expect(html).toContain("保存模型设置");
  });
  it("allows reset and disables save for a removed model", () => {
    const draft = { ...DEFAULT_OPENING_AI_SETTINGS, mode: "manual" as const, manualModelId: "removed" };
    const html = renderToStaticMarkup(createElement(AiSettingsForm, { data: { ...data, saved: true, settings: draft }, draft, busy: false, onChange() {}, onSave() {}, onReset() {} }));
    expect(html).toContain("已移除的模型");
    expect(html).toContain("在上方重新选择手动模型" );
    expect(html).not.toContain("请在自动规则中重新选择" );
    expect(html).toMatch(/disabled=""[^>]*>.*?保存模型设置/s);
    expect(html).toContain("恢复服务器默认设置");
  });
});
