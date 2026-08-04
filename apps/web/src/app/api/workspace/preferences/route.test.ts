import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setAuthRuntimeForTests } from "../../../../server/runtime";
import { GET } from "./route";

const requiredEnvKeys = [
  "DATABASE_URL",
  "REDIS_URL",
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "PUBLIC_BASE_URL",
  "AUTH_SECRET",
];

const originalEnv = { ...process.env };

describe("workspace preferences route", () => {
  beforeEach(() => {
    setAuthRuntimeForTests(null);
    for (const key of requiredEnvKeys) delete process.env[key];
  });

  afterEach(() => {
    setAuthRuntimeForTests(null);
    for (const key of requiredEnvKeys) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });

  it("returns a structured service-unavailable response when runtime config is missing", async () => {
    const response = await GET(new Request("http://localhost/api/workspace/preferences"));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "CONFIGURATION",
        message: "服务暂不可用，请检查服务器配置。",
      },
    });
  });
});
