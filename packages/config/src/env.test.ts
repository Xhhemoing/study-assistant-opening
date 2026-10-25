import { describe, expect, it } from "vitest";
import { loadEnv, loadOpeningUploadQuota, loadOpeningAutoGradeDailyCap, EnvValidationError } from "./env";
import { loadOpeningTutorConfig } from "./opening-model";
import { loadFeatureSwitches, resolveCapabilities } from "./server-config";
import { loadOpeningEmbeddingConfig } from "./opening-embedding";
import { loadWorkerEnv } from "./worker-env";
import { loadWorkerStartupConfig } from "./worker-startup";

it("defaults auto grading to 50 and rejects malformed or out-of-range caps", () => {
  expect(loadOpeningAutoGradeDailyCap({})).toBe(50);
  expect(loadOpeningAutoGradeDailyCap({ OPENING_AUTO_GRADE_DAILY_CAP: "0" })).toBe(0);
  expect(loadOpeningAutoGradeDailyCap({ OPENING_AUTO_GRADE_DAILY_CAP: "10000" })).toBe(10000);
  for (const value of ["", "-1", "1.5", "50oops", "10001", "Infinity"]) {
    expect(() => loadOpeningAutoGradeDailyCap({ OPENING_AUTO_GRADE_DAILY_CAP: value })).toThrow(EnvValidationError);
  }
});

it("strictly validates startup budgets, cache TTL, and bounded backoff", () => {
  expect(loadWorkerStartupConfig({}).parserTimeoutMs).toBe(120000);
  expect(loadWorkerStartupConfig({}).ocrTimeoutMs).toBe(120000);
  expect(loadWorkerStartupConfig({ PARSER_OCR_PREFLIGHT_TIMEOUT_MS: "240000" }).ocrTimeoutMs).toBe(240000);
  expect(loadWorkerStartupConfig({ PARSER_OCR_SEGMENT_TIMEOUT_SECONDS: "900" }).ocrSegmentTimeoutSeconds).toBe(900);
  for (const value of ["0", "-1", "1.5", "10tail", "901"]) {
    expect(() => loadWorkerStartupConfig({ PARSER_OCR_SEGMENT_TIMEOUT_SECONDS: value })).toThrow(EnvValidationError);
  }
  for (const value of ["0", "-1", "1.5", "10tail", "600001"]) {
    expect(() => loadWorkerEnv({ PARSER_OCR_PREFLIGHT_TIMEOUT_MS: value })).toThrow(EnvValidationError);
  }
  expect(loadWorkerStartupConfig({ WORKER_ROLE: "parser" }).readinessFile).toBe(".tmp/worker-parser-ready.json");
  expect(loadWorkerStartupConfig({ PARSER_PREFLIGHT_CACHE_TTL_MS: "0" }).parserCacheTtlMs).toBe(0);
  for (const name of ["WORKER_READY_TIMEOUT_MS", "PARSER_PREFLIGHT_TIMEOUT_MS", "PARSER_PREFLIGHT_CACHE_TTL_MS", "WORKER_STARTUP_RETRY_INITIAL_MS", "WORKER_STARTUP_RETRY_MAX_MS"]) {
    for (const value of ["-1", "1.5", "10tail", "Infinity", "9007199254740992"]) {
      expect(() => loadWorkerEnv({ [name]: value })).toThrow(EnvValidationError);
    }
  }
  expect(() => loadWorkerStartupConfig({ WORKER_STARTUP_RETRY_INITIAL_MS: "6000", WORKER_STARTUP_RETRY_MAX_MS: "5000" })).toThrow(/must be >=/);
});

it("defaults worker consumers to all and validates explicit isolation roles", () => {
  expect(loadWorkerEnv({}).workerRole).toBe("all");
  for (const role of ["all", "learning", "parser"] as const) {
    expect(loadWorkerEnv({ WORKER_ROLE: role }).workerRole).toBe(role);
  }
  expect(() => loadWorkerEnv({ WORKER_ROLE: "unknown" })).toThrow(/WORKER_ROLE/);
});

it("enables owned system queries by default while respecting explicit off and authentication", () => {
  expect(loadFeatureSwitches({}).systemQuery).toBe(true);
  for (const adaptive of ["0", "1"]) {
    expect(loadFeatureSwitches({ OPENING_ADAPTIVE_PLANNING: adaptive }).systemQuery).toBe(true);
    expect(loadFeatureSwitches({ OPENING_SYSTEM_QUERY: "1", OPENING_ADAPTIVE_PLANNING: adaptive }).systemQuery).toBe(true);
    const disabled = loadFeatureSwitches({ OPENING_SYSTEM_QUERY: "0", OPENING_ADAPTIVE_PLANNING: adaptive });
    expect(disabled.systemQuery).toBe(false);
    expect(resolveCapabilities(disabled, "owner").systemQuery).toBe(false);
  }
  expect(resolveCapabilities(loadFeatureSwitches({}), "owner").systemQuery).toBe(true);
  expect(resolveCapabilities(loadFeatureSwitches({}), null).systemQuery).toBe(false);
  expect(() => loadFeatureSwitches({ OPENING_SYSTEM_QUERY: "perhaps" })).toThrow(EnvValidationError);
});

describe("loadEnv", () => {
  const valid = {
      NODE_ENV: "test",
      DATABASE_URL: "postgres://aistudy:aistudy@127.0.0.1:5432/aistudy_spike",
      REDIS_URL: "redis://127.0.0.1:6379",
      S3_ENDPOINT: "http://127.0.0.1:9000",
      S3_REGION: "us-east-1",
      S3_BUCKET: "aistudy",
      S3_ACCESS_KEY_ID: "minioadmin",
      S3_SECRET_ACCESS_KEY: "minioadmin",
      PUBLIC_BASE_URL: "http://localhost:3000",
      AUTH_SECRET: "test-auth-secret-at-least-32-characters-long",
    } as NodeJS.ProcessEnv;

  it("parses required platform environment variables", () => {
    const env = loadEnv(valid);
    expect(env.databaseUrl).toBe(valid.DATABASE_URL);
    expect(env.redisUrl).toBe(valid.REDIS_URL);
    expect(env.s3.endpoint).toBe(valid.S3_ENDPOINT);
    expect(env.s3.bucket).toBe(valid.S3_BUCKET);
    expect(env.publicBaseUrl).toBe(valid.PUBLIC_BASE_URL);
    expect(env.nodeEnv).toBe("test");
    expect(env.authSecret).toBe(valid.AUTH_SECRET);
    expect(env.sessionTtlSeconds).toBe(604800);
    expect(env.sessionCookieSecure).toBe(false);
  });

  it("uses secure session cookies by default in production and accepts an explicit override", () => {
    expect(loadEnv({ ...valid, NODE_ENV: "production" }).sessionCookieSecure).toBe(true);
    expect(
      loadEnv({ ...valid, NODE_ENV: "production", SESSION_COOKIE_SECURE: "false" })
        .sessionCookieSecure,
    ).toBe(false);
  });

  it("trusts no client IP header by default and validates an explicit header name", () => {
    expect(loadEnv(valid).authTrustedIpHeader).toBeUndefined();
    expect(loadEnv({ ...valid, AUTH_TRUSTED_IP_HEADER: " X-Real-IP " }).authTrustedIpHeader).toBe("X-Real-IP");
    for (const header of ["x-real-ip, forwarded", "x-real-ip\r\ninjected: yes"]) {
      expect(() => loadEnv({ ...valid, AUTH_TRUSTED_IP_HEADER: header })).toThrow(EnvValidationError);
    }
  });

  it("defaults and validates workspace upload reservation limits", () => {
    expect(loadOpeningUploadQuota({})).toEqual({ maxBytes: 2 * 1024 ** 3, maxObjects: 200 });
    expect(loadOpeningUploadQuota({ OPENING_UPLOAD_MAX_WORKSPACE_BYTES: "1024", OPENING_UPLOAD_MAX_WORKSPACE_OBJECTS: "2" }))
      .toEqual({ maxBytes: 1024, maxObjects: 2 });
    for (const name of ["OPENING_UPLOAD_MAX_WORKSPACE_BYTES", "OPENING_UPLOAD_MAX_WORKSPACE_OBJECTS"]) {
      for (const value of ["0", "-1", "1.5", "10tail", "Infinity", "9007199254740992"]) {
        expect(() => loadOpeningUploadQuota({ [name]: value })).toThrow(EnvValidationError);
        expect(() => loadEnv({ ...valid, [name]: value })).toThrow(EnvValidationError);
      }
    }
  });

  it("disables paid calls by default and validates a configured daily cap and prices", () => {
    expect(loadEnv(valid).openingModel.dailyCapCents).toBe(0);
    const paid = { ...valid, OPENING_MODEL_API_KEY: "test-key", OPENING_MODEL_DAILY_CAP_CENTS: "100", OPENING_MODEL_INPUT_CENTS_PER_MILLION: "10", OPENING_MODEL_OUTPUT_CENTS_PER_MILLION: "20" };
    expect(loadEnv(paid).openingModel.dailyCapCents).toBe(100);
    for (const invalid of [{ OPENING_MODEL_DAILY_CAP_CENTS: "NaN" }, { OPENING_MODEL_DAILY_CAP_CENTS: "-1" }, { OPENING_MODEL_INPUT_CENTS_PER_MILLION: "0" }, { OPENING_MODEL_OUTPUT_CENTS_PER_MILLION: "" }]) {
      expect(() => loadEnv({ ...paid, ...invalid })).toThrow();
    }
  });

  it("loads a complete directory while ignoring unused legacy endpoint and prices", () => {
    const model = { id: "new", label: "New", providerId: "p", providerLabel: "P", modelName: "new-model", baseUrl: "https://provider.example/v1", apiKeyEnv: "NEW_KEY", inputCentsPerMillion: 10, outputCentsPerMillion: 20 };
    const source = { ...valid, OPENING_MODEL_CATALOG: JSON.stringify([model]), NEW_KEY: "new-key", OPENING_MODEL_API_KEY: "old-key", OPENING_MODEL_BASE_URL: "obsolete-endpoint", OPENING_MODEL_DAILY_CAP_CENTS: "100", OPENING_MODEL_INPUT_CENTS_PER_MILLION: "0", OPENING_MODEL_OUTPUT_CENTS_PER_MILLION: "0" };
    expect(loadEnv(source).openingModel).toMatchObject({ name: "new-model", apiKey: "new-key", inputCentsPerMillion: 10, dailyCapCents: 100 });
    expect(() => loadEnv({ ...source, OPENING_MODEL_CATALOG: "" })).toThrow();
  });
  it("rejects missing AUTH_SECRET", () => {
    const { AUTH_SECRET: _omit, ...rest } = valid;
    expect(() => loadEnv(rest)).toThrow(EnvValidationError);
    expect(() => loadEnv(rest)).toThrow(/AUTH_SECRET/);
  });

  it("rejects missing DATABASE_URL", () => {
    const { DATABASE_URL: _omit, ...rest } = valid;
    expect(() => loadEnv(rest)).toThrow(EnvValidationError);
    expect(() => loadEnv(rest)).toThrow(/DATABASE_URL/);
  });

  it("rejects invalid PUBLIC_BASE_URL", () => {
    expect(() =>
      loadEnv({ ...valid, PUBLIC_BASE_URL: "not-a-url" }),
    ).toThrow(/PUBLIC_BASE_URL/);
  });

  it("does not include raw secret fields on the public summary", () => {
    const env = loadEnv(valid);
    const summary = JSON.stringify(env.toPublicSummary());
    expect(summary).not.toContain("minioadmin");
    expect(summary).not.toContain(valid.DATABASE_URL);
    expect(JSON.parse(summary)).toMatchObject({
      nodeEnv: "test",
      publicBaseUrl: "http://localhost:3000",
      databaseConfigured: true,
      redisConfigured: true,
      storageConfigured: true,
    });
  });
});

describe("loadOpeningTutorConfig", () => {
  it("defaults finite positive OPENING_TUTOR_* knobs", () => {
    expect(loadOpeningTutorConfig({})).toEqual({
      maxContextCharacters: 12_000,
      reservedCents: 100,
      maxOutputTokens: 2_048,
    });
  });

  it("rejects non-finite, non-positive, and non-integer OPENING_TUTOR_* values", () => {
    for (const invalid of [
      { OPENING_TUTOR_MAX_CONTEXT_CHARS: "NaN" },
      { OPENING_TUTOR_MAX_CONTEXT_CHARS: "Infinity" },
      { OPENING_TUTOR_MAX_CONTEXT_CHARS: "0" },
      { OPENING_TUTOR_MAX_CONTEXT_CHARS: "-1" },
      { OPENING_TUTOR_MAX_CONTEXT_CHARS: "12.5" },
      { OPENING_TUTOR_RESERVED_CENTS: "" },
      { OPENING_TUTOR_RESERVED_CENTS: "0" },
      { OPENING_TUTOR_MAX_OUTPUT_TOKENS: "-2" },
      { OPENING_TUTOR_MAX_OUTPUT_TOKENS: "abc" },
    ]) {
      expect(() => loadOpeningTutorConfig(invalid)).toThrow();
    }
  });

  it("parses explicit positive integer OPENING_TUTOR_* values", () => {
    expect(
      loadOpeningTutorConfig({
        OPENING_TUTOR_MAX_CONTEXT_CHARS: "8000",
        OPENING_TUTOR_RESERVED_CENTS: "50",
        OPENING_TUTOR_MAX_OUTPUT_TOKENS: "1024",
      }),
    ).toEqual({
      maxContextCharacters: 8000,
      reservedCents: 50,
      maxOutputTokens: 1024,
    });
  });
});

describe("optional opening model catalog environment", () => {
  it("keeps the catalog server-only and accepts an explicit model directory", async () => {
    const { loadOpeningModelCatalog } = await import("./opening-model-catalog");
    expect(loadOpeningModelCatalog({ OPENING_MODEL_CATALOG: "[]" }).models).toEqual([]);
    expect(() => loadOpeningModelCatalog({ OPENING_MODEL_CATALOG: "invalid-private-config" })).toThrow(/服务器模型目录配置无效/);
  });
});

describe("optional semantic retrieval configuration", () => {
  const config = { baseUrl: "https://model.example/v1/", modelName: "embedding", apiKeyEnv: "TEST_MODEL_KEY",
    dimensions: 1536, inputCentsPerMillion: 2 };
  const load = (overrides: Record<string, unknown> = {}) => loadOpeningEmbeddingConfig({
    OPENING_EMBEDDING_CONFIG: JSON.stringify({ ...config, ...overrides }), TEST_MODEL_KEY: "secret-value",
  });
  it("keeps retrieval optional and separates the non-secret model identity from credentials", () => {
    expect(loadOpeningEmbeddingConfig({})).toBeNull();
    expect(load()).toMatchObject({ baseUrl: "https://model.example/v1", apiKey: "secret-value", requestDimensions: true });
    expect(load()!.modelKey).toBe(JSON.stringify(["https://model.example/v1", "embedding", 1536]));
    expect(load({ dimensions: 768 })!.modelKey).not.toBe(load()!.modelKey);
    expect(loadOpeningEmbeddingConfig({ OPENING_EMBEDDING_CONFIG: JSON.stringify(config) })!.apiKey).toBe("");
  });
  it("rejects malformed, credential-bearing and unpriced settings without revealing raw input", () => {
    for (const invalid of [{ dimensions: 0 }, { dimensions: 4097 }, { inputCentsPerMillion: 0 },
      { baseUrl: "https://secret-value@model.example" }, { baseUrl: "http://model.example" },
      { apiKey: "secret-value" }, { billing: "free_tier", inputCentsPerMillion: 0 }]) {
      expect(() => load(invalid)).toThrow(/资料检索模型配置无效/);
      try { load(invalid); } catch (error) { expect(String(error)).not.toContain("secret-value"); }
    }
    expect(load({ billing: "free_tier", inputCentsPerMillion: 0, dailyRequestCap: 10, requestDimensions: false }))
      .toMatchObject({ billing: "free_tier", dailyRequestCap: 10, requestDimensions: false });
  });
});
