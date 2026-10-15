import { DEFAULT_OPENING_AI_SETTINGS, type OpeningAiSettingsResponse } from "@aistudy/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FREE_TIER_NOTICE } from "./provider-settings-model";
import {
  applyQuickSetupPreset, beginQuickSetupSubmission, finishQuickSetupSubmission, initialQuickSetupDraft,
  initialQuickSetupSubmission, isDefiniteQuickSetupRejection, quickSetupRequestBody, validateQuickSetupDraft, type QuickSetupDraft,
} from "./quick-setup-model";
import { QuickSetupForm, QuickSetupResult } from "./quick-setup-panel";

const freeDraft: QuickSetupDraft = { ...initialQuickSetupDraft, label: "我的 Gemini", apiKey: "test-key" };
const paidDraft: QuickSetupDraft = {
  ...applyQuickSetupPreset(freeDraft, "openai_compatible"), modelName: "my-model", inputCentsPerMillion: "10.5",
  outputCentsPerMillion: "20", dailyCapCents: "200", confirmBudget: true,
};

describe("one-click model setup", () => {
  it("fills Gemini endpoint and example capabilities without inventing token prices", () => {
    expect(initialQuickSetupDraft).toMatchObject({
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", modelName: "gemini-2.5-flash",
      supportsVision: true, supportsAudio: true, billing: "free_tier", dailyRequestCap: "200",
      inputCentsPerMillion: "", outputCentsPerMillion: "", apiKey: "",
    });
    expect(validateQuickSetupDraft(freeDraft)).toBeNull();
  });
  it("requires the user to enter another compatible model and its prices", () => {
    const draft = applyQuickSetupPreset(freeDraft, "openai_compatible");
    expect(draft).toMatchObject({ baseUrl: "https://api.openai.com/v1", modelName: "", billing: "metered", inputCentsPerMillion: "", outputCentsPerMillion: "", confirmBudget: false });
    expect(validateQuickSetupDraft(draft)).toContain("模型名称");
    expect(validateQuickSetupDraft({ ...draft, modelName: "my-model" })).toContain("输入价格");
  });
  it("requires a write-only key, bounded name and a secure remote endpoint", () => {
    expect(validateQuickSetupDraft({ ...freeDraft, apiKey: " " })).toContain("API 密钥");
    expect(validateQuickSetupDraft({ ...freeDraft, apiKey: "x".repeat(4097) })).toContain("4096");
    expect(validateQuickSetupDraft({ ...freeDraft, label: "x".repeat(121) })).toContain("120");
    expect(validateQuickSetupDraft({ ...freeDraft, baseUrl: "http://remote.example/v1" })).toContain("https");
    expect(validateQuickSetupDraft({ ...freeDraft, baseUrl: "https://user:pass@example.com/v1" })).toContain("用户信息");
    expect(validateQuickSetupDraft({ ...freeDraft, baseUrl: "http://localhost:1234/v1" })).toBeNull();
  });
  it.each(["0", "100001", "2.5", "NaN", ""])("rejects the invalid free daily request cap %s", cap => {
    expect(validateQuickSetupDraft({ ...freeDraft, dailyRequestCap: cap })).toContain("每日请求上限");
  });
  it("requires positive prices and explicit confirmation of a positive integer daily amount", () => {
    expect(validateQuickSetupDraft(paidDraft)).toBeNull();
    expect(validateQuickSetupDraft({ ...paidDraft, inputCentsPerMillion: "0" })).toContain("输入价格");
    expect(validateQuickSetupDraft({ ...paidDraft, outputCentsPerMillion: "Infinity" })).toContain("输出价格");
    for (const dailyCapCents of ["", "0", "-1", "1.5", "9007199254740992"]) {
      expect(validateQuickSetupDraft({ ...paidDraft, dailyCapCents })).toContain("每日额度");
    }
    expect(validateQuickSetupDraft({ ...paidDraft, confirmBudget: false })).toContain("确认每日额度");
  });
  it("builds one request with the supplied idempotency key and free zero-cost accounting", () => {
    const body = quickSetupRequestBody({ ...freeDraft, label: " 我的 Gemini ", modelName: " gemini-2.5-flash " }, "same-client-key");
    expect(body).toEqual({
      clientKey: "same-client-key", label: "我的 Gemini", modelName: "gemini-2.5-flash",
      baseUrl: freeDraft.baseUrl, apiKey: "test-key", supportsVision: true, supportsAudio: true,
      billing: "free_tier", inputCentsPerMillion: 0, outputCentsPerMillion: 0, dailyRequestCap: 200,
      dailyCapCents: null, confirmBudget: false,
    });
    expect(quickSetupRequestBody(paidDraft, "paid-client-key")).toMatchObject({
      clientKey: "paid-client-key", inputCentsPerMillion: 10.5, outputCentsPerMillion: 20,
      dailyCapCents: 200, confirmBudget: true, dailyRequestCap: null,
    });
  });
  it("shows free data-use disclosure and makes invalid submission unavailable", () => {
    const render = (draft: QuickSetupDraft) => renderToStaticMarkup(createElement(QuickSetupForm, {
      draft, preset: "gemini_free", busy: false, onChange() {}, onPreset() {}, onSubmit() {},
    }));
    expect(render(freeDraft)).toContain(FREE_TIER_NOTICE);
    expect(render(freeDraft)).toContain('type="password"');
    expect(render({ ...freeDraft, apiKey: "" })).toMatch(/<button[^>]*disabled=""[^>]*type="submit"/);
    expect(render(freeDraft)).not.toMatch(/<button[^>]*disabled=""[^>]*type="submit"/);
    expect(render(freeDraft)).toContain("清空已有的辅导模式及用途专属路由");
  });
  it("binds an uncertain request to its original payload and client key", () => {
    const first = beginQuickSetupSubmission(initialQuickSetupSubmission, freeDraft, "original-client-key");
    const uncertain = finishQuickSetupSubmission(first, "unknown");
    expect(uncertain.uncertain).toBe(true);
    const retry = beginQuickSetupSubmission(uncertain, { ...paidDraft, label: "Changed", apiKey: "changed-key" }, "replacement-client-key");
    expect(retry.clientKey).toBe("original-client-key");
    expect(retry.payload).toEqual(quickSetupRequestBody(freeDraft, "original-client-key"));
    expect(retry.payload.modelName).toBe("gemini-2.5-flash");
    expect(retry.payload.apiKey).toBe("test-key");
  });
  it("releases rejected payloads for editing while retaining the key until success", () => {
    const first = beginQuickSetupSubmission(initialQuickSetupSubmission, freeDraft, "original-client-key");
    const rejected = finishQuickSetupSubmission(first, "rejected");
    expect(rejected).toEqual({ clientKey: "original-client-key", payload: null, uncertain: false });
    const corrected = beginQuickSetupSubmission(rejected, paidDraft, "unused-new-key");
    expect(corrected.clientKey).toBe("original-client-key");
    expect(corrected.payload.modelName).toBe("my-model");
    const successful = finishQuickSetupSubmission(corrected, "success");
    expect(successful).toEqual(initialQuickSetupSubmission);
    expect(beginQuickSetupSubmission(successful, freeDraft, "new-client-key").clientKey).toBe("new-client-key");
  });
  it("keeps potentially committed failures locked and only releases explicit route rejections", () => {
    for (const status of [400, 401, 409, 422, 429, 503]) expect(isDefiniteQuickSetupRejection(status)).toBe(true);
    for (const status of [200, 500, 502, 504]) expect(isDefiniteQuickSetupRejection(status)).toBe(false);
    const html = renderToStaticMarkup(createElement(QuickSetupForm, {
      draft: freeDraft, preset: "gemini_free", busy: false, locked: true, onChange() {}, onPreset() {}, onSubmit() {},
    }));
    expect(html).toMatch(/<fieldset[^>]*disabled=""/);
    expect(html).toContain("确认上次配置结果");
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*type="submit"/);
  });
  it("reports each task's configuration requirements without claiming connection success", () => {
    const data: OpeningAiSettingsResponse = {
      defaultModelId: "new", dailyCapCents: 0, envCapCents: 0, personalCeilingCents: 2000,
      settings: { ...DEFAULT_OPENING_AI_SETTINGS, defaultModelId: "new" }, saved: true, invalidStoredSettings: false,
      models: [{ id: "new", providerId: "custom", providerLabel: "Custom", label: "Model", modelName: "model", inputCentsPerMillion: 0, outputCentsPerMillion: 0, availability: "available", supportsAudio: false, billing: "free_tier" }],
      tasks: [{ key: "tutor.hint", label: "提示", group: "tutor", needs: [] }, { key: "media.transcribe", label: "音视频转写", group: "materials", needs: ["audio"] }],
    };
    const html = renderToStaticMarkup(createElement(QuickSetupResult, { data }));
    expect(html).toContain("提示");
    expect(html).toContain("配置可用");
    expect(html).toContain("音视频转写");
    expect(html).toContain("不支持音频输入");
    expect(html).toContain("实际连通性请在高级设置的模型列表中测试");
    expect(html).not.toContain("连接成功");
  });
});
