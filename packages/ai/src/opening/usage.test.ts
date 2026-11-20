import { describe, expect, it } from "vitest";
import {
  actualCentsForOutput,
  estimateUsage,
  extractUsage,
  parseProviderUsage,
  reservationCentsForInput,
  usageFromOutput,
} from "./usage";

describe("provider usage", () => {
  it("marks missing usage as an estimate", () => {
    expect(extractUsage(undefined, "hello", 100)).toEqual({
      inputTokens: 100,
      outputTokens: 2,
      estimated: true,
    });
  });

  it("calculates token cost", () => {
    expect(estimateUsage({ inputTokens: 1000, outputTokens: 500, estimated: false }, {
      inputCentsPerMillion: 100,
      outputCentsPerMillion: 200,
    })).toBe(1);
  });

  it("parses cached tokens across OpenAI, DeepSeek, and Anthropic usage shapes and clamps to prompt_tokens", () => {
    expect(parseProviderUsage(undefined)).toEqual({
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
    });
    expect(parseProviderUsage({
      prompt_tokens: 1000,
      completion_tokens: 200,
      prompt_tokens_details: { cached_tokens: 800 },
    })).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      cachedInputTokens: 800,
    });
    expect(parseProviderUsage({
      prompt_tokens: 1000,
      completion_tokens: 200,
      prompt_cache_hit_tokens: 750,
    })).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      cachedInputTokens: 750,
    });
    expect(parseProviderUsage({
      prompt_tokens: 1000,
      completion_tokens: 200,
      cache_read_input_tokens: 600,
    })).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      cachedInputTokens: 600,
    });
    expect(parseProviderUsage({
      prompt_tokens: 500,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: 900 },
    })).toEqual({
      inputTokens: 500,
      outputTokens: 50,
      cachedInputTokens: 500,
    });
    expect(parseProviderUsage({
      prompt_tokens: 500,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: -1 },
    })).toBeNull();
    expect(parseProviderUsage({
      prompt_tokens: 500,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: 1.5 },
    })).toBeNull();
    expect(parseProviderUsage({
      prompt_tokens: 500,
      completion_tokens: 50,
      prompt_tokens_details: "invalid",
    })).toBeNull();
  });

  it("discounts cached input tokens when cachedInputCentsPerMillion is configured and falls back conservatively when omitted", () => {
    const output = {
      text: "ok",
      citedChunkIds: [],
      requestId: "req-1",
      candidates: [],
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 800_000,
    };

    expect(usageFromOutput(output)).toEqual({
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 800_000,
      estimated: false,
    });

    // Without cachedInputCentsPerMillion: bills all 1M input tokens at full input rate (zero under-billing).
    expect(actualCentsForOutput(output, {
      inputCentsPerMillion: 100,
      outputCentsPerMillion: 200,
    })).toBe(100);

    // With cachedInputCentsPerMillion = 10: 200k * 100 + 800k * 10 = 28 cents.
    expect(actualCentsForOutput(output, {
      inputCentsPerMillion: 100,
      outputCentsPerMillion: 200,
      cachedInputCentsPerMillion: 10,
    })).toBe(28);

    // Zero cached rate (100% cache discount) must not fall back via truthiness check.
    expect(actualCentsForOutput(output, {
      inputCentsPerMillion: 100,
      outputCentsPerMillion: 200,
      cachedInputCentsPerMillion: 0,
    })).toBe(20);
  });

  it("clamps oversized cachedInputTokens so uncached input tokens never become negative", () => {
    expect(estimateUsage({
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 2_000_000,
      estimated: false,
    }, {
      inputCentsPerMillion: 100,
      outputCentsPerMillion: 200,
      cachedInputCentsPerMillion: 10,
    })).toBe(10);
  });

  it("keeps pre-flight reservationCentsForInput conservative even when cachedInputCentsPerMillion is discounted", () => {
    const serialized = "x".repeat(100_000);
    const fullRate = reservationCentsForInput(serialized, 2000, {
      inputCentsPerMillion: 100,
      outputCentsPerMillion: 200,
    });
    const discountedRate = reservationCentsForInput(serialized, 2000, {
      inputCentsPerMillion: 100,
      outputCentsPerMillion: 200,
      cachedInputCentsPerMillion: 0,
    });
    expect(discountedRate).toBe(fullRate);
  });
});
