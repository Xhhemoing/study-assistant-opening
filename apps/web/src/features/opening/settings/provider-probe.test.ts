import { type OpeningProviderConfigResponse } from "@aistudy/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProviderSettingsForm } from "./provider-settings-panel";

const data: OpeningProviderConfigResponse = {
  providers: [{ id: "f5c2c67e-5e30-4e0b-9972-a24a7de4b822", label: "My provider", baseUrl: "https://example.com/v1", hasApiKey: true, apiKeyHint: null, apiKeyUpdatedAt: null, modelCount: 1, createdAt: "", updatedAt: "" }],
  models: [{ id: "model-a", providerId: "f5c2c67e-5e30-4e0b-9972-a24a7de4b822", label: "Model A", modelName: "model-a", inputCentsPerMillion: 0, outputCentsPerMillion: 0, supportsVision: true, supportsAudio: true, billing: "free_tier", dailyRequestCap: 200, createdAt: "", updatedAt: "" }],
};
const handlers = { onCreateProvider() {}, onUpdateProvider() {}, onDeleteProvider() {}, onCreateModel() {}, onUpdateModel() {}, onDeleteModel() {}, onProbeModel() {} };

describe("model connection probe controls", () => {
  it("offers an explicitly triggered test and discloses accounting and no automatic retry", () => {
    const html = renderToStaticMarkup(createElement(ProviderSettingsForm, { ...handlers, data, busy: false }));
    expect(html).toContain('aria-label="测试 Model A 的连通性"');
    expect(html).toContain("连通性测试");
    expect(html).toContain("计入模型的费用或免费请求上限");
    expect(html).toContain("不会自动重发");
  });
  it("shows progress while disabling another test and preserves the per-model outcome", () => {
    const html = renderToStaticMarkup(createElement(ProviderSettingsForm, {
      ...handlers, data, busy: true, probingId: "model-a", probeResults: { "model-a": { ok: false, message: "本次请求失败（每日请求上限已用完）。" } },
    }));
    expect(html).toContain("正在测试…");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="测试 Model A 的连通性"/);
    expect(html).toContain("本次请求失败（每日请求上限已用完）。");
    expect(html).toContain('role="status"');
  });
});
