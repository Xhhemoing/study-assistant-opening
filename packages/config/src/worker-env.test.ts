import { describe, expect, it } from "vitest";
import { EnvValidationError } from "./env";
import { loadWorkerEnv } from "./worker-env";

const configured = {
  DATABASE_URL: "postgres://worker:secret@db.internal:5432/aistudy",
  REDIS_URL: "redis://cache.internal:6379",
  S3_ENDPOINT: "https://s3.example.com",
  S3_REGION: "ap-east-1",
  S3_BUCKET: "study",
  S3_ACCESS_KEY_ID: "worker-key",
  S3_SECRET_ACCESS_KEY: "worker-secret",
} as NodeJS.ProcessEnv;

describe("loadWorkerEnv", () => {
  it("keeps local defaults outside production", () => {
    const env = loadWorkerEnv({ NODE_ENV: "development" });
    expect(env.databaseUrl).toBe("postgres://postgres@127.0.0.1:5432/aistudy");
    expect(env.redisUrl).toBe("redis://127.0.0.1:6379");
    expect(env.s3).toMatchObject({ endpoint: "http://127.0.0.1:9000", accessKeyId: "minioadmin", forcePathStyle: true });
    expect(env.parserTempDir).toBe(".tmp/opening-parser");
  });

  it("uses explicit values and parses path-style and parser temp dir", () => {
    const env = loadWorkerEnv({ ...configured, NODE_ENV: "production", S3_FORCE_PATH_STYLE: "false", PARSER_TEMP_DIR: "/var/tmp/parser" });
    expect(env.nodeEnv).toBe("production");
    expect(env.databaseUrl).toBe(configured.DATABASE_URL);
    expect(env.s3).toEqual({
      endpoint: "https://s3.example.com", region: "ap-east-1", bucket: "study",
      accessKeyId: "worker-key", secretAccessKey: "worker-secret", forcePathStyle: false,
    });
    expect(env.parserTempDir).toBe("/var/tmp/parser");
  });

  it("fails closed in production and names every missing variable", () => {
    let caught: unknown;
    try {
      loadWorkerEnv({ NODE_ENV: "production", DATABASE_URL: configured.DATABASE_URL, S3_SECRET_ACCESS_KEY: "   " });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EnvValidationError);
    const issues = (caught as EnvValidationError).issues.join("\n");
    for (const key of ["REDIS_URL", "S3_ENDPOINT", "S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]) {
      expect(issues).toContain(`${key} is required in production`);
    }
    expect(issues).not.toContain("DATABASE_URL");
  });

  it("rejects an invalid endpoint or path-style flag", () => {
    expect(() => loadWorkerEnv({ ...configured, NODE_ENV: "production", S3_ENDPOINT: "not a url" })).toThrow(/S3_ENDPOINT must be a valid URL/);
    expect(() => loadWorkerEnv({ ...configured, S3_FORCE_PATH_STYLE: "yes" })).toThrow(/S3_FORCE_PATH_STYLE/);
  });
});
