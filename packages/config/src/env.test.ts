import { describe, expect, it } from "vitest";
import { loadEnv, EnvValidationError } from "./env";
import { loadOpeningTutorConfig } from "./opening-model";

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

  it("disables paid calls by default and validates a configured daily cap and prices", () => {
    expect(loadEnv(valid).openingModel.dailyCapCents).toBe(0);
    const paid = { ...valid, OPENING_MODEL_API_KEY: "test-key", OPENING_MODEL_DAILY_CAP_CENTS: "100", OPENING_MODEL_INPUT_CENTS_PER_MILLION: "10", OPENING_MODEL_OUTPUT_CENTS_PER_MILLION: "20" };
    expect(loadEnv(paid).openingModel.dailyCapCents).toBe(100);
    for (const invalid of [{ OPENING_MODEL_DAILY_CAP_CENTS: "NaN" }, { OPENING_MODEL_DAILY_CAP_CENTS: "-1" }, { OPENING_MODEL_INPUT_CENTS_PER_MILLION: "0" }, { OPENING_MODEL_OUTPUT_CENTS_PER_MILLION: "" }]) {
      expect(() => loadEnv({ ...paid, ...invalid })).toThrow();
    }
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
