import { describe, expect, it } from "vitest";
import {
  keyStatusText, modelRequestBody, providerRequestBody, validateModelDraft, validateProviderDraft,
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
  it("requires positive numeric prices for models", () => {
    const base = { label: "M", modelName: "m", supportsVision: false };
    expect(validateModelDraft({ ...base, inputCentsPerMillion: "1", outputCentsPerMillion: "2" })).toBeNull();
    expect(validateModelDraft({ ...base, inputCentsPerMillion: "0", outputCentsPerMillion: "2" })).toContain("输入");
    expect(validateModelDraft({ ...base, inputCentsPerMillion: "1", outputCentsPerMillion: "-1" })).toContain("输出");
    expect(validateModelDraft({ ...base, inputCentsPerMillion: "abc", outputCentsPerMillion: "2" })).toContain("输入");
    expect(modelRequestBody({ ...base, inputCentsPerMillion: "1.5", outputCentsPerMillion: "2" })).toEqual({
      label: "M", modelName: "m", inputCentsPerMillion: 1.5, outputCentsPerMillion: 2, supportsVision: false,
    });
  });
  it("shows the masked key hint without exposing key material", () => {
    expect(keyStatusText({ id: providerId, label: "P", baseUrl: "https://x", hasApiKey: false, apiKeyHint: null, apiKeyUpdatedAt: null, modelCount: 0, createdAt: "", updatedAt: "" })).toBe("未配置密钥");
    expect(keyStatusText({ id: providerId, label: "P", baseUrl: "https://x", hasApiKey: true, apiKeyHint: "ab12", apiKeyUpdatedAt: "2026-02-03T04:05:06.000Z", modelCount: 0, createdAt: "", updatedAt: "" })).toContain("尾号 ab12");
  });
});
