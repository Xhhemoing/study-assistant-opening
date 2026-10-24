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
  it("defaults parser bounds and accepts explicit inclusive limits", () => {
    expect(loadWorkerEnv({})).toMatchObject({ parserPdfSegmentPages: 5, parserPdfSegmentTimeoutSeconds: 240, parserTorchThreads: 1 });
    for (const [pages, timeout, threads] of [[1, 30, 1], [100, 3600, 4]]) {
      expect(loadWorkerEnv({ PARSER_PDF_SEGMENT_PAGES: String(pages), PARSER_PDF_SEGMENT_TIMEOUT_SECONDS: String(timeout), PARSER_TORCH_THREADS: String(threads) }))
        .toMatchObject({ parserPdfSegmentPages: pages, parserPdfSegmentTimeoutSeconds: timeout, parserTorchThreads: threads });
    }
  });

  it("strictly rejects malformed and out-of-range parser settings", () => {
    for (const [key, low, high] of [["PARSER_PDF_SEGMENT_PAGES", "0", "101"], ["PARSER_PDF_SEGMENT_TIMEOUT_SECONDS", "29", "3601"], ["PARSER_TORCH_THREADS", "0", "5"]]) {
      for (const value of [low, high, "", "1.5", "NaN", "Infinity", "1e2", "2junk"]) {
        expect(() => loadWorkerEnv({ [key!]: value })).toThrow(key);
      }
    }
  });
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

  it("accepts trimmed roles and rejects accidental role typos in production", () => {
    expect(loadWorkerEnv({ ...configured, NODE_ENV: "production", WORKER_ROLE: " learning " }).workerRole).toBe("learning");
    expect(loadWorkerEnv({ WORKER_ROLE: " " }).workerRole).toBe("all");
    expect(() => loadWorkerEnv({ ...configured, NODE_ENV: "production", WORKER_ROLE: "parse" })).toThrow(/WORKER_ROLE/);
  });
});
