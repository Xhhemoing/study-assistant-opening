import { describe, expect, it } from "vitest";
import {
  emptyModelDraft, keyStatusText, modelRequestBody, providerRequestBody, validateModelDraft, validateProviderDraft,
} from "./provider-settings-model";

const providerId = "22222222-2222-4222-8222-222222222222";

describe("provider settings presentation", () => {
  it("validates https-only base urls with loopback http allowance", () => {
    expect(validateProviderDraft({ label: "A", baseUrl: "https://api.example.com/v1", apiKey: "" })).toBeNull();
    expect(validateProviderDraft({ label: "A", baseUrl: "http://localhost:8000/v1", apiKey: "" })).toBeNull();
    expect(validateProviderDraft({ label: "A", baseUrl: "http://127.0.0.1:8000", apiKey: "" })).toBeNull();
    expect(validateProviderDraft({ label: "A", baseUrl: "http://api.example.com", apiKey: "" })).toContain("https");
    expect(validateProviderDraft({ label: "A", baseUrl: "https://u:p@example.com", apiKey: "" })).toContain("用户信息");
    expect(validateProviderDraft({ label: "A", baseUrl: "https://example.com?x=1", apiKey: "" })).toContain("查询");
    expect(validateProviderDraft({ label: "A", baseUrl: "not a url", apiKey: "" })).toContain("无效");
    expect(validateProviderDraft({ label: "", baseUrl: "https://example.com", apiKey: "" })).toContain("名称");
  });
  it("treats an empty key as leave-unchanged and validates key length only", () => {
    expect(validateProviderDraft({ label: "A", baseUrl: "https://example.com", apiKey: "" })).toBeNull();
    expect(validateProviderDraft({ label: "A", baseUrl: "https://example.com", apiKey: "x".repeat(4097) })).toContain("4096");
    expect(providerRequestBody({ label: " A ", baseUrl: " https://example.com ", apiKey: "" })).toEqual({ label: "A", baseUrl: "https://example.com" });
    expect(providerRequestBody({ label: "A", baseUrl: "https://example.com", apiKey: " k " })).toEqual({ label: "A", baseUrl: "https://example.com", apiKey: " k " });
  });
  it("asks for a destination-specific key when changing an endpoint with stored credentials", () => {
    const current = { id: providerId, label: "P", baseUrl: "https://example.com/v1", hasApiKey: true,
      apiKeyHint: "1234", apiKeyUpdatedAt: null, modelCount: 0, createdAt: "", updatedAt: "" };
    const draft = { label: "Renamed", baseUrl: "https://new.example/v1", apiKey: "" };
    expect(validateProviderDraft(draft, current)).toContain("同时填写");
    expect(validateProviderDraft({ ...draft, baseUrl: "https://EXAMPLE.COM:443/v1/" }, current)).toBeNull();
    expect(validateProviderDraft({ ...draft, apiKey: "new-key" }, current)).toBeNull();
    expect(validateProviderDraft(draft, { ...current, hasApiKey: false })).toBeNull();
  });
  it("requires positive numeric prices for models", () => {
    const base = { ...emptyModelDraft, label: "M", modelName: "m" };
    expect(validateModelDraft({ ...base, inputCentsPerMillion: "1", outputCentsPerMillion: "2" })).toBeNull();
    expect(validateModelDraft({ ...base, inputCentsPerMillion: "0", outputCentsPerMillion: "2" })).toContain("输入");
    expect(validateModelDraft({ ...base, inputCentsPerMillion: "1", outputCentsPerMillion: "-1" })).toContain("输出");
    expect(validateModelDraft({ ...base, inputCentsPerMillion: "abc", outputCentsPerMillion: "2" })).toContain("输入");
    expect(modelRequestBody({ ...base, inputCentsPerMillion: "1.5", outputCentsPerMillion: "2" })).toEqual({
      label: "M", modelName: "m", inputCentsPerMillion: 1.5, outputCentsPerMillion: 2, supportsVision: false,
      supportsAudio: false, billing: "metered", dailyRequestCap: null,
    });
  });
  it("accepts zero-priced free tier models only with a bounded daily request cap", () => {
    const draft = { ...emptyModelDraft, label: "Free", modelName: "free", billing: "free_tier" as const, inputCentsPerMillion: "0", outputCentsPerMillion: "0", dailyRequestCap: "200" };
    expect(validateModelDraft(draft)).toBeNull();
    expect(modelRequestBody(draft)).toMatchObject({ billing: "free_tier", dailyRequestCap: 200, inputCentsPerMillion: 0, outputCentsPerMillion: 0 });
    for (const dailyRequestCap of ["", "0", "100001", "1.5"]) {
      expect(validateModelDraft({ ...draft, dailyRequestCap })).not.toBeNull();
    }
    for (const dailyRequestCap of ["1", "100000"]) {
      expect(validateModelDraft({ ...draft, dailyRequestCap })).toBeNull();
    }
  });
  it("shows the masked key hint without exposing key material", () => {
    expect(keyStatusText({ id: providerId, label: "P", baseUrl: "https://x", hasApiKey: false, apiKeyHint: null, apiKeyUpdatedAt: null, modelCount: 0, createdAt: "", updatedAt: "" })).toBe("未配置密钥");
    expect(keyStatusText({ id: providerId, label: "P", baseUrl: "https://x", hasApiKey: true, apiKeyHint: "ab12", apiKeyUpdatedAt: "2026-02-03T04:05:06.000Z", modelCount: 0, createdAt: "", updatedAt: "" })).toContain("尾号 ab12");
  });
});

it("validates, serializes and clears user-supplied media upper bounds", () => {
  const base = { ...emptyModelDraft, label: "Vision", modelName: "v", inputCentsPerMillion: "1", outputCentsPerMillion: "2" };
  expect(validateModelDraft(base)).toBeNull();
  expect(validateModelDraft({ ...base, mediaInputTokenUpperBound: "128000" })).toContain("一起填写");
  const configured = { ...base, mediaInputTokenUpperBound: "128000", mediaMaxInputBytes: "1048576", mediaInputCentsPerMillion: "3" };
  expect(validateModelDraft(configured)).toBeNull();
  expect(modelRequestBody(configured)).toMatchObject({ mediaInputTokenUpperBound: 128000, mediaMaxInputBytes: 1048576, mediaInputCentsPerMillion: 3 });
  expect(validateModelDraft({ ...configured, mediaMaxInputBytes: "104857601" })).toContain("字节");
  expect(validateModelDraft({ ...configured, mediaInputTokenUpperBound: "1.5" })).toContain("正整数");
  expect(validateModelDraft({ ...configured, mediaInputCentsPerMillion: "0" })).toContain("大于 0");
  expect(modelRequestBody(base, { clearMedia: true })).toMatchObject({ mediaInputTokenUpperBound: null, mediaMaxInputBytes: null, mediaInputCentsPerMillion: null });
});
