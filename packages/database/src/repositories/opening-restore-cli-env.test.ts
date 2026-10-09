import { describe, expect, it } from "vitest";
import { resolveOpeningRestoreCliLiveDeps } from "./opening-restore-cli-env";

const completeS3 = {
  S3_ENDPOINT: "http://127.0.0.1:9000",
  S3_REGION: "us-east-1",
  S3_BUCKET: "aistudy",
  S3_ACCESS_KEY_ID: "minioadmin",
  S3_SECRET_ACCESS_KEY: "minioadmin",
} as const;

describe("resolveOpeningRestoreCliLiveDeps", () => {
  it("prefers OPENING_RESTORE_DATABASE_URL over OPENING_TEST_DATABASE_URL and DATABASE_URL", () => {
    const result = resolveOpeningRestoreCliLiveDeps({
      ...completeS3,
      OPENING_RESTORE_DATABASE_URL: "postgres://restore/local",
      OPENING_TEST_DATABASE_URL: "postgres://test/local",
      DATABASE_URL: "postgres://app/local",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.databaseUrl).toBe("postgres://restore/local");
    expect(result.databaseUrlSource).toBe("OPENING_RESTORE_DATABASE_URL");
  });

  it("prefers OPENING_TEST_DATABASE_URL over DATABASE_URL", () => {
    const result = resolveOpeningRestoreCliLiveDeps({
      ...completeS3,
      OPENING_TEST_DATABASE_URL: "postgres://test/local",
      DATABASE_URL: "postgres://app/local",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.databaseUrl).toBe("postgres://test/local");
    expect(result.databaseUrlSource).toBe("OPENING_TEST_DATABASE_URL");
  });

  it("falls back to DATABASE_URL when restore/test URLs absent", () => {
    const result = resolveOpeningRestoreCliLiveDeps({
      ...completeS3,
      DATABASE_URL: "postgres://app/local",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.databaseUrl).toBe("postgres://app/local");
    expect(result.databaseUrlSource).toBe("DATABASE_URL");
  });

  it("builds OpeningS3Config from S3_* with forcePathStyle default true", () => {
    const result = resolveOpeningRestoreCliLiveDeps({
      ...completeS3,
      DATABASE_URL: "postgres://app/local",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.s3).toEqual({
      endpoint: "http://127.0.0.1:9000",
      region: "us-east-1",
      bucket: "aistudy",
      accessKeyId: "minioadmin",
      secretAccessKey: "minioadmin",
      forcePathStyle: true,
    });
  });

  it("lets OPENING_S3_* override S3_* and honors forcePathStyle=false", () => {
    const result = resolveOpeningRestoreCliLiveDeps({
      ...completeS3,
      DATABASE_URL: "postgres://app/local",
      OPENING_S3_ENDPOINT: "http://127.0.0.1:19000",
      OPENING_S3_BUCKET: "opening-only",
      OPENING_S3_FORCE_PATH_STYLE: "false",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.s3.endpoint).toBe("http://127.0.0.1:19000");
    expect(result.s3.bucket).toBe("opening-only");
    expect(result.s3.region).toBe("us-east-1");
    expect(result.s3.forcePathStyle).toBe(false);
  });

  it("fail-closed when no database URL keys are set (lists preference chain)", () => {
    const result = resolveOpeningRestoreCliLiveDeps({ ...completeS3 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("LIVE_DEPS_MISSING");
    expect(result.missingKeys).toContain(
      "OPENING_RESTORE_DATABASE_URL|OPENING_TEST_DATABASE_URL|DATABASE_URL",
    );
    expect(result.missingKeys.join(" ")).not.toMatch(/minioadmin|postgres:\/\//);
  });

  it("fail-closed listing each missing S3 key when incomplete", () => {
    const result = resolveOpeningRestoreCliLiveDeps({
      DATABASE_URL: "postgres://app/local",
      S3_ENDPOINT: "http://127.0.0.1:9000",
      // region/bucket/keys absent
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("LIVE_DEPS_MISSING");
    expect(result.missingKeys).toEqual(
      expect.arrayContaining([
        "S3_REGION",
        "S3_BUCKET",
        "S3_ACCESS_KEY_ID",
        "S3_SECRET_ACCESS_KEY",
      ]),
    );
    expect(result.missingKeys).not.toContain("S3_ENDPOINT");
  });

  it("treats blank-only values as missing", () => {
    const result = resolveOpeningRestoreCliLiveDeps({
      DATABASE_URL: "   ",
      S3_ENDPOINT: "http://127.0.0.1:9000",
      S3_REGION: "us-east-1",
      S3_BUCKET: "aistudy",
      S3_ACCESS_KEY_ID: "",
      S3_SECRET_ACCESS_KEY: "minioadmin",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missingKeys).toEqual(
      expect.arrayContaining([
        "OPENING_RESTORE_DATABASE_URL|OPENING_TEST_DATABASE_URL|DATABASE_URL",
        "S3_ACCESS_KEY_ID",
      ]),
    );
  });
});
