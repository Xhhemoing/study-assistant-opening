import { describe, expect, it } from "vitest";
import { loadEnv, EnvValidationError } from "./env";

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
  } as NodeJS.ProcessEnv;

  it("parses required platform environment variables", () => {
    const env = loadEnv(valid);
    expect(env.databaseUrl).toBe(valid.DATABASE_URL);
    expect(env.redisUrl).toBe(valid.REDIS_URL);
    expect(env.s3.endpoint).toBe(valid.S3_ENDPOINT);
    expect(env.s3.bucket).toBe(valid.S3_BUCKET);
    expect(env.publicBaseUrl).toBe(valid.PUBLIC_BASE_URL);
    expect(env.nodeEnv).toBe("test");
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
