import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export function assertOpeningE2eDatabase(raw, enabled) {
  if (enabled !== "1") throw new Error("Opening E2E requires OPENING_E2E=1");
  const url = new URL(raw);
  if (!["postgres:", "postgresql:"].includes(url.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.port !== "15432" || url.pathname !== "/aistudy_opening_e2e" || url.search || url.hash) {
    throw new Error("Opening E2E requires the dedicated loopback:15432/aistudy_opening_e2e database without overrides");
  }
  return url;
}
export function buildOpeningE2eEnvironment(inherited = process.env) {
  const database = "postgres://opening:opening-local-test@127.0.0.1:15432/aistudy_opening_e2e";
  return {
    ...inherited,
    OPENING_E2E: "1", OPENING_RELEASE: "1", NODE_ENV: "production",
    DATABASE_URL: database, E2E_DATABASE_URL: database,
    REDIS_URL: "redis://127.0.0.1:16379/0",
    S3_ENDPOINT: "http://127.0.0.1:19000", S3_REGION: "us-east-1", S3_BUCKET: "opening-e2e",
    S3_ACCESS_KEY_ID: "opening-e2e", S3_SECRET_ACCESS_KEY: "opening-e2e-local-secret",
    S3_FORCE_PATH_STYLE: "true", PUBLIC_BASE_URL: "http://127.0.0.1:3100",
    AUTH_SECRET: "opening-e2e-auth-secret-at-least-32-characters", AUTH_COOKIE_NAME: "aistudy_session",
    SESSION_COOKIE_SECURE: "false", SESSION_TTL_SECONDS: "3600",
    OPENING_MODEL_BASE_URL: "http://127.0.0.1:18081/v1",
    OPENING_MODEL_API_KEY: "opening-e2e-fixture-key", OPENING_MODEL_NAME: "opening-e2e-fixture",
    OPENING_MODEL_DAILY_CAP_CENTS: "10000", OPENING_MODEL_INPUT_CENTS_PER_MILLION: "1",
    OPENING_MODEL_OUTPUT_CENTS_PER_MILLION: "1", OPENING_TUTOR_RESERVED_CENTS: "100",
    OPENING_TUTOR_MAX_OUTPUT_TOKENS: "256", OPENING_TUTOR_MAX_CONTEXT_CHARS: "12000", FEISHU_REMINDER_CREDENTIAL: "",
    PARSER_PYTHON: path.join(projectRoot, ".local/docling-venv/Scripts/python.exe"),
    PARSER_CWD: path.join(projectRoot, "services/parser"),
    PARSER_TEMP_DIR: path.join(projectRoot, ".local/opening-e2e/parser-temp"),
    HF_HOME: path.join(projectRoot, ".local/hf-home"), HF_HUB_OFFLINE: "1",
    NEXT_TELEMETRY_DISABLED: "1",
  };
}
