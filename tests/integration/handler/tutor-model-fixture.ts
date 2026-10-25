import { afterEach, beforeEach, vi } from "vitest";

/** Exercise real model admission without requiring secrets or contacting a provider. */
export function useTutorModelFixture() {
  beforeEach(() => {
    vi.stubEnv("OPENING_MODEL_DEFAULT_ID", "handler-model");
    vi.stubEnv("OPENING_MODEL_DAILY_CAP_CENTS", "100000");
    vi.stubEnv("OPENING_HANDLER_MODEL_KEY", "handler-fixture-not-a-real-key");
    vi.stubEnv("OPENING_MODEL_CATALOG", JSON.stringify([{
      id: "handler-model", label: "Handler fixture", providerId: "handler-provider", providerLabel: "Handler fixture",
      modelName: "handler-model", apiKeyEnv: "OPENING_HANDLER_MODEL_KEY",
      baseUrl: "https://handler-model.invalid/v1",
      inputCentsPerMillion: 100, outputCentsPerMillion: 100,
    }]));
  });
  afterEach(() => vi.unstubAllEnvs());
}
