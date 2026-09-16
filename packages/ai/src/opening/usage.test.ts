import { describe, expect, it } from "vitest";
import { estimateUsage, extractUsage } from "./usage";

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
});
