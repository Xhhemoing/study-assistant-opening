import { describe, expect, it } from "vitest";
import { classifyProviderFailure } from "./errors";

describe("provider failures", () => {
  it("classifies authentication and rate-limit failures", () => {
    expect(classifyProviderFailure(401)).toEqual({
      retryable: false,
      code: "PROVIDER_AUTH",
    });
    expect(classifyProviderFailure(429)).toEqual({
      retryable: true,
      code: "PROVIDER_RATE_LIMIT",
    });
  });

  it("retries server failures but not other client failures", () => {
    expect(classifyProviderFailure(500)).toEqual({
      retryable: true,
      code: "PROVIDER_UNAVAILABLE",
    });
    expect(classifyProviderFailure(400)).toEqual({
      retryable: false,
      code: "PROVIDER_REQUEST",
    });
  });
});
