import type { Sql } from "postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertProviderEndpointAllowed } from "./provider-endpoint-policy";
import { createProviderConfigService } from "./provider-config-service";
import { quickSetupModel } from "./quick-setup-service";

afterEach(() => vi.unstubAllEnvs());
const scope = { workspaceId: "11111111-1111-4111-8111-111111111111", ownerUserId: "22222222-2222-4222-8222-222222222222" };

describe("server provider endpoint policy", () => {
  it("has one policy for local development and never allows it in production", () => {
    vi.stubEnv("NODE_ENV", "development"); vi.stubEnv("OPENING_PROVIDER_ALLOW_LOCAL", "0");
    expect(() => assertProviderEndpointAllowed("http://localhost:8000/v1")).toThrow(expect.objectContaining({ status: 422 }));
    vi.stubEnv("OPENING_PROVIDER_ALLOW_LOCAL", "true");
    expect(() => assertProviderEndpointAllowed("http://localhost:8000/v1")).not.toThrow();
    vi.stubEnv("NODE_ENV", "production");
    for (const url of ["http://localhost:8000/v1", "https://localhost", "https://10.1.1.1", "https://[::ffff:127.0.0.1]"]) {
      expect(() => assertProviderEndpointAllowed(url)).toThrow(expect.objectContaining({ status: 422 }));
    }
    expect(() => assertProviderEndpointAllowed("https://api.example.com/v1")).not.toThrow();
  });

  it("rejects provider create, update and quick setup before database writes", async () => {
    vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("OPENING_PROVIDER_ALLOW_LOCAL", "1");
    const sql = vi.fn() as unknown as Sql;
    sql.begin = vi.fn();
    const service = createProviderConfigService(sql);
    await expect(service.createProvider(scope, { label: "Local", baseUrl: "http://localhost:8000/v1", apiKey: "key" }))
      .rejects.toMatchObject({ status: 422, code: "VALIDATION" });
    await expect(service.updateProvider(scope, scope.workspaceId, { baseUrl: "https://169.254.169.254" }))
      .rejects.toMatchObject({ status: 422, code: "VALIDATION" });
    await expect(quickSetupModel(sql, scope, {
      clientKey: "local-test-key", label: "Local", baseUrl: "http://localhost:8000/v1", apiKey: "key", modelName: "model",
      inputCentsPerMillion: 1, outputCentsPerMillion: 1, dailyCapCents: 100, confirmBudget: true,
    })).rejects.toMatchObject({ status: 422, code: "VALIDATION" });
    expect(sql).not.toHaveBeenCalled(); expect(sql.begin).not.toHaveBeenCalled();
  });
});
