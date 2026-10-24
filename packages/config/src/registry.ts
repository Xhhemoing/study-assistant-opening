/**
 * PR-H §7.3: the single controlled definition of every environment variable.
 * `.env.example` and `infra/docker/opening.env.example` are generated from this
 * list (scripts/env-examples.ts --write / --check). Server-only: never import
 * from client code. Examples are placeholders only; never put a real value here.
 */

export type EnvConsumer = "web" | "worker" | "compose" | "scripts" | "tests";
export type EnvKind = "string" | "url" | "bool" | "int" | "percent" | "json" | "csv" | "enum";

export type TemplateLine = {
  /** Value written to the template. */
  value: string;
  /** Written as `# NAME=value` (documented, not set). */
  commented?: boolean;
};

export type EnvVarSpec = {
  name: string;
  group: EnvGroupId;
  doc: string;
  consumers: EnvConsumer[];
  kind: EnvKind;
  /** Secrets never reach a client bundle or a capabilities response. */
  secret: boolean;
  /** `production`: startup fails when unset and NODE_ENV=production. */
  required?: "always" | "production";
  min?: number;
  max?: number;
  enumValues?: readonly string[];
  /** Root `.env.example` (development). Omitted: not listed there. */
  dev?: TemplateLine;
  /** `infra/docker/opening.env.example` (compose/production). Omitted: not listed. */
  docker?: TemplateLine;
};

export type EnvGroupId =
  | "runtime" | "compose" | "database" | "redis" | "storage" | "auth" | "release" | "model"
  | "tutor" | "parser" | "connections" | "teaching" | "e2e";

export const ENV_GROUPS: { id: EnvGroupId; title: string }[] = [
  { id: "runtime", title: "Runtime" },
  { id: "compose", title: "Compose infrastructure (docker template only; compose fails closed if unset)" },
  { id: "database", title: "PostgreSQL" },
  { id: "redis", title: "Redis / BullMQ" },
  { id: "storage", title: "S3-compatible object storage" },
  { id: "auth", title: "Auth / sessions" },
  { id: "release", title: "Opening release mode (server switch; the UI reads /api/opening/capabilities)" },
  { id: "model", title: "Opening model (paid calls stay off until a positive daily cap and prices are set)" },
  { id: "tutor", title: "Opening tutor runtime (worker)" },
  { id: "parser", title: "Parser worker" },
  { id: "connections", title: "Connections (credential vault, IMAP, DingTalk, Feishu)" },
  { id: "teaching", title: "AI teaching loop: server switches only (API enabled / UI shown / rollout). No NEXT_PUBLIC_* twins." },
  { id: "e2e", title: "Tests / E2E" },
];

const both: EnvConsumer[] = ["web", "worker"];
const embeddingExample: TemplateLine = { value: JSON.stringify({ baseUrl: "https://your-provider.example/v1",
  modelName: "your-embedding-model", apiKeyEnv: "PRIMARY_MODEL_API_KEY", dimensions: 1536,
  inputCentsPerMillion: 2, requestDimensions: true }), commented: true };
const modelCatalogExample: TemplateLine = {
  value: JSON.stringify([{ id: "fast", label: "日常模型", providerId: "primary", providerLabel: "主供应商", modelName: "your-model-name",
    baseUrl: "https://your-provider.example/v1", apiKeyEnv: "PRIMARY_MODEL_API_KEY", inputCentsPerMillion: 10, outputCentsPerMillion: 20,
    supportsVision: false, supportsAudio: false, billing: "metered", dailyRequestCap: null }]),
  commented: true,
};

export const ENV_REGISTRY: readonly EnvVarSpec[] = [
  { name: "OPENING_AUTO_GRADE_DAILY_CAP", group: "model", doc: "Save-time auto-grading tasks per workspace local day; default 50, 0 disables automatic grading. Manual grading is never blocked by this cap.", consumers: ["web"], kind: "int", min: 0, max: 10000, secret: false, dev: { value: "50" }, docker: { value: "50" } },
  { name: "NODE_ENV", group: "runtime", doc: "development | test | production.", consumers: [...both, "compose"], kind: "enum", enumValues: ["development", "test", "production"], secret: false, dev: { value: "development" }, docker: { value: "production" } },
  { name: "WORKER_ROLE", group: "runtime", doc: "Worker consumers: all (default), learning (no document/media parsing), or parser (document/media parsing only). all/parser require parser startup checks.", consumers: ["worker"], kind: "enum", enumValues: ["all", "learning", "parser"], secret: false, dev: { value: "all" }, docker: { value: "all" } },
  ...([
    ["WORKER_READINESS_FILE", ".tmp/worker-all-ready.json", "Readiness receipt path; default .tmp/worker-<role>-ready.json. Use distinct paths for multiple roles."],
    ["PARSER_PREFLIGHT_CACHE_FILE", ".tmp/parser-preflight-success.json", "Successful parser check cache; local writable path, not a readiness receipt."],
  ] as const).map(([name, value, doc]): EnvVarSpec => ({ name, group: "runtime", doc, consumers: ["worker"], kind: "string", secret: false, dev: { value, commented: true }, docker: { value, commented: true } })),
  ...[
    ["WORKER_READY_TIMEOUT_MS", 30000, 1000, 300000],
    ["PARSER_PREFLIGHT_TIMEOUT_MS", 120000, 1000, 600000],
    ["PARSER_OCR_PREFLIGHT_TIMEOUT_MS", 120000, 1000, 600000],
    ["PARSER_PREFLIGHT_CACHE_TTL_MS", 3600000, 0, 86400000],
    ["WORKER_STARTUP_RETRY_INITIAL_MS", 5000, 1000, 300000],
    ["WORKER_STARTUP_RETRY_MAX_MS", 60000, 1000, 300000],
  ].map(([name, value, min, max]): EnvVarSpec => ({ name: String(name), group: "runtime", doc: `${name}: milliseconds; default ${value}. Cache TTL 0 disables reuse; retry max must be >= initial.`, consumers: ["worker"], kind: "int", min: Number(min), max: Number(max), secret: false, dev: { value: String(value), commented: true }, docker: { value: String(value), commented: true } })),
  { name: "PUBLIC_BASE_URL", group: "runtime", doc: "Public web origin; cookie-auth Origin checks use it.", consumers: ["web"], kind: "url", secret: false, required: "always", dev: { value: "http://localhost:3000" }, docker: { value: "https://REPLACE_ME.example" } },

  { name: "OPENING_POSTGRES_USER", group: "compose", doc: "Compose Postgres user.", consumers: ["compose"], kind: "string", secret: false, docker: { value: "REPLACE_ME_pg_user" } },
  { name: "OPENING_POSTGRES_PASSWORD", group: "compose", doc: "Compose Postgres password.", consumers: ["compose"], kind: "string", secret: true, docker: { value: "REPLACE_ME_pg_password_long_random" } },
  { name: "OPENING_POSTGRES_DB", group: "compose", doc: "Compose Postgres database.", consumers: ["compose"], kind: "string", secret: false, docker: { value: "aistudy_opening" } },
  { name: "OPENING_POSTGRES_PORT", group: "compose", doc: "Loopback host port for Postgres.", consumers: ["compose"], kind: "int", min: 1, max: 65535, secret: false, docker: { value: "5432" } },
  { name: "OPENING_REDIS_PASSWORD", group: "compose", doc: "Compose Redis password.", consumers: ["compose"], kind: "string", secret: true, docker: { value: "REPLACE_ME_redis_password_long_random" } },
  { name: "OPENING_REDIS_PORT", group: "compose", doc: "Loopback host port for Redis.", consumers: ["compose"], kind: "int", min: 1, max: 65535, secret: false, docker: { value: "6379" } },
  { name: "OPENING_S3_ACCESS_KEY_ID", group: "compose", doc: "MinIO root user.", consumers: ["compose"], kind: "string", secret: true, docker: { value: "REPLACE_ME_s3_access_key" } },
  { name: "OPENING_S3_SECRET_ACCESS_KEY", group: "compose", doc: "MinIO root password.", consumers: ["compose"], kind: "string", secret: true, docker: { value: "REPLACE_ME_s3_secret_key_long_random" } },
  { name: "OPENING_S3_BUCKET", group: "compose", doc: "Bucket created by compose.", consumers: ["compose"], kind: "string", secret: false, docker: { value: "aistudy-opening" } },
  { name: "OPENING_S3_PORT", group: "compose", doc: "Loopback host port for MinIO.", consumers: ["compose"], kind: "int", min: 1, max: 65535, secret: false, docker: { value: "9000" } },
  { name: "OPENING_S3_CONSOLE_PORT", group: "compose", doc: "Loopback host port for the MinIO console.", consumers: ["compose"], kind: "int", min: 1, max: 65535, secret: false, docker: { value: "9001" } },
  { name: "OPENING_WEB_PORT", group: "compose", doc: "Loopback host port for web.", consumers: ["compose"], kind: "int", min: 1, max: 65535, secret: false, docker: { value: "3000" } },
  { name: "OPENING_ENV_FILE", group: "compose", doc: "Optional env_file override (default ./opening.env next to compose).", consumers: ["compose"], kind: "string", secret: false, docker: { value: "./opening.env", commented: true } },

  { name: "DATABASE_URL", group: "database", doc: "Application database.", consumers: [...both, "scripts"], kind: "string", secret: true, required: "always", dev: { value: "postgres://aistudy:aistudy@127.0.0.1:5432/aistudy" }, docker: { value: "postgres://REPLACE_ME_pg_user:REPLACE_ME_pg_password_long_random@postgres:5432/aistudy_opening" } },
  { name: "REDIS_URL", group: "redis", doc: "Queue connection.", consumers: both, kind: "string", secret: true, required: "always", dev: { value: "redis://127.0.0.1:6379" }, docker: { value: "redis://:REPLACE_ME_redis_password_long_random@redis:6379" } },

  { name: "S3_ENDPOINT", group: "storage", doc: "S3 endpoint (MinIO by default).", consumers: both, kind: "url", secret: false, required: "production", dev: { value: "http://127.0.0.1:9000" }, docker: { value: "http://minio:9000" } },
  { name: "S3_REGION", group: "storage", doc: "Region.", consumers: both, kind: "string", secret: false, required: "production", dev: { value: "us-east-1" }, docker: { value: "us-east-1" } },
  { name: "S3_BUCKET", group: "storage", doc: "Bucket.", consumers: both, kind: "string", secret: false, required: "production", dev: { value: "aistudy" }, docker: { value: "aistudy-opening" } },
  { name: "S3_ACCESS_KEY_ID", group: "storage", doc: "Access key id.", consumers: both, kind: "string", secret: true, required: "production", dev: { value: "minioadmin" }, docker: { value: "REPLACE_ME_s3_access_key" } },
  { name: "S3_SECRET_ACCESS_KEY", group: "storage", doc: "Secret access key.", consumers: both, kind: "string", secret: true, required: "production", dev: { value: "minioadmin" }, docker: { value: "REPLACE_ME_s3_secret_key_long_random" } },
  { name: "S3_FORCE_PATH_STYLE", group: "storage", doc: "Path-style addressing (true for MinIO).", consumers: both, kind: "bool", secret: false, dev: { value: "true" }, docker: { value: "true" } },
  { name: "OPENING_S3_FORCE_PATH_STYLE", group: "storage", doc: "Restore CLI alias of S3_FORCE_PATH_STYLE; takes precedence when set, so leave unset unless overriding.", consumers: ["scripts"], kind: "bool", secret: false },
  { name: "OPENING_UPLOAD_MAX_WORKSPACE_BYTES", group: "storage", doc: "Original-upload byte quota per workspace, including pending reservations and retained versions. Default 2 GiB; deletion releases space after cleanup.", consumers: both, kind: "int", min: 1, max: Number.MAX_SAFE_INTEGER, secret: false, dev: { value: "2147483648" }, docker: { value: "2147483648" } },
  { name: "OPENING_UPLOAD_MAX_WORKSPACE_OBJECTS", group: "storage", doc: "Original-upload object quota per workspace, including pending reservations and retained versions. Default 200.", consumers: both, kind: "int", min: 1, max: Number.MAX_SAFE_INTEGER, secret: false, dev: { value: "200" }, docker: { value: "200" } },

  { name: "AUTH_SECRET", group: "auth", doc: "Session JWT secret, at least 32 characters.", consumers: ["web"], kind: "string", min: 32, secret: true, required: "always", dev: { value: "dev-only-change-me-to-a-long-random-secret" }, docker: { value: "REPLACE_ME_auth_secret_long_random" } },
  { name: "SESSION_COOKIE_SECURE", group: "auth", doc: "false only for plain-HTTP loopback/CI E2E. Production must use true.", consumers: ["web"], kind: "bool", secret: false, dev: { value: "false" }, docker: { value: "true" } },
  { name: "SESSION_TTL_SECONDS", group: "auth", doc: "Session lifetime, integer >= 60.", consumers: ["web"], kind: "int", min: 60, secret: false, dev: { value: "604800" }, docker: { value: "604800" } },
  { name: "AUTH_COOKIE_NAME", group: "auth", doc: "Session cookie name.", consumers: ["web"], kind: "string", secret: false, dev: { value: "aistudy_session" }, docker: { value: "aistudy_session" } },
  { name: "AUTH_TRUSTED_IP_HEADER", group: "auth", doc: "Optional single-IP header for auth rate limits. Set only when a trusted reverse proxy overwrites this header and direct access to the app is blocked. Empty trusts no forwarding headers; account + global limits remain enabled.", consumers: ["web"], kind: "string", secret: false, dev: { value: "", commented: true }, docker: { value: "", commented: true } },

  { name: "OPENING_RELEASE", group: "release", doc: "1 closes self-registration (server-enforced in /api/auth/register) and redirects legacy /learn, /explore, /preview. Defaults to 1 in production; set 0 explicitly to allow public registration.", consumers: ["web"], kind: "bool", secret: false, dev: { value: "0", commented: true }, docker: { value: "1" } },

  { name: "OPENING_MODEL_BASE_URL", group: "model", doc: "OpenAI-compatible base URL.", consumers: both, kind: "url", secret: false, dev: { value: "https://api.openai.com/v1" }, docker: { value: "https://api.openai.com/v1" } },
  { name: "OPENING_PROVIDER_ALLOW_LOCAL", group: "model", doc: "Allow loopback OpenAI-compatible endpoints only outside production. Private networks remain blocked; production ignores this development override.", consumers: both, kind: "bool", secret: false, dev: { value: "0" }, docker: { value: "0" } },
  { name: "OPENING_MODEL_API_KEY", group: "model", doc: "Model API key (secret store only). Key + positive cap requires positive prices.", consumers: both, kind: "string", secret: true, dev: { value: "" }, docker: { value: "" } },
  { name: "OPENING_MODEL_NAME", group: "model", doc: "Model name.", consumers: both, kind: "string", secret: false, dev: { value: "gpt-4o-mini" }, docker: { value: "gpt-4o-mini" } },
  { name: "OPENING_MODEL_DAILY_CAP_CENTS", group: "model", doc: "Daily paid cap in provider billing cents (workspace planning timezone). 0 disables paid calls; configured free_tier models use their request cap.", consumers: both, kind: "int", min: 0, secret: false, dev: { value: "0" }, docker: { value: "0" } },
  { name: "OPENING_MODEL_INPUT_CENTS_PER_MILLION", group: "model", doc: "Input price per million tokens.", consumers: both, kind: "string", secret: false, dev: { value: "0" }, docker: { value: "0" } },
  { name: "OPENING_MODEL_OUTPUT_CENTS_PER_MILLION", group: "model", doc: "Output price per million tokens.", consumers: both, kind: "string", secret: false, dev: { value: "0" }, docker: { value: "0" } },
  { name: "OPENING_MODEL_CATALOG", group: "model", doc: "Optional JSON catalog (max 32). apiKeyEnv names a SERVER secret; never inline a key. supportsAudio defaults false; billing=metered requires positive prices, billing=free_tier allows zero prices and requires dailyRequestCap=1..100000. See docs/operations/opening-model-routing.md.", consumers: both, kind: "json", secret: false, dev: modelCatalogExample, docker: modelCatalogExample },
  { name: "OPENING_MODEL_DEFAULT_ID", group: "model", doc: "Catalog default model id.", consumers: both, kind: "string", secret: false, dev: { value: "fast", commented: true }, docker: { value: "fast", commented: true } },
  { name: "OPENING_EMBEDDING_CONFIG", group: "model", doc: "Optional server JSON for semantic retrieval: HTTPS baseUrl, modelName, apiKeyEnv, dimensions (1..4096), inputCentsPerMillion. Set requestDimensions=false for providers that do not accept that parameter. A free_tier requires zero price and dailyRequestCap. Missing configuration/key keeps lexical retrieval. Index and query use the same model identity.", consumers: both, kind: "json", secret: false, dev: embeddingExample, docker: embeddingExample },
  { name: "PRIMARY_MODEL_API_KEY", group: "model", doc: "Example catalog apiKeyEnv target (secret store only).", consumers: both, kind: "string", secret: true, dev: { value: "", commented: true }, docker: { value: "", commented: true } },
  { name: "LANT_API_KEY", group: "model", doc: "Example catalog apiKeyEnv target for a Lant provider (secret store only).", consumers: both, kind: "string", secret: true, dev: { value: "", commented: true } },

  { name: "OPENING_TUTOR_MAX_CONTEXT_CHARS", group: "tutor", doc: "Finite positive integer.", consumers: ["worker"], kind: "int", min: 1, max: 100000, secret: false, dev: { value: "12000" }, docker: { value: "12000" } },
  { name: "OPENING_TUTOR_RESERVED_CENTS", group: "tutor", doc: "Finite positive integer.", consumers: ["worker"], kind: "int", min: 1, secret: false, dev: { value: "100" }, docker: { value: "100" } },
  { name: "OPENING_TUTOR_MAX_OUTPUT_TOKENS", group: "tutor", doc: "Finite positive integer.", consumers: ["worker"], kind: "int", min: 1, max: 100000, secret: false, dev: { value: "2048" }, docker: { value: "2048" } },

  { name: "PARSER_PYTHON", group: "parser", doc: "Absolute parser venv python. Empty selects the repo-relative dev venv; CI/production must set it (see services/parser/README.md).", consumers: ["worker"], kind: "string", secret: false, dev: { value: "" }, docker: { value: "/opt/parser-venv/bin/python", commented: true } },
  { name: "PARSER_CWD", group: "parser", doc: "Absolute parser working directory (same rule as PARSER_PYTHON).", consumers: ["worker"], kind: "string", secret: false, dev: { value: "" }, docker: { value: "/opt/parser", commented: true } },
  { name: "PARSER_TEMP_DIR", group: "parser", doc: "Parser scratch directory (default .tmp/opening-parser).", consumers: ["worker"], kind: "string", secret: false, dev: { value: ".tmp/opening-parser", commented: true }, docker: { value: ".tmp/opening-parser", commented: true } },
  { name: "HF_HOME", group: "parser", doc: "Optional absolute model cache; default <repository>/.local/hf-home.", consumers: ["worker"], kind: "string", secret: false, dev: { value: "/srv/aistudy/hf-home", commented: true } },
  { name: "HF_HUB_OFFLINE", group: "parser", doc: "Document conversion enforces offline mode after setup.", consumers: ["worker"], kind: "bool", secret: false, dev: { value: "1" }, docker: { value: "1" } },
  { name: "PARSER_OCR_MODEL_DIR", group: "parser", doc: "OCR readiness requires this directory.", consumers: both, kind: "string", secret: false, dev: { value: "", commented: true }, docker: { value: "", commented: true } },
  { name: "OPENING_WHISPER_MODEL_SIZE", group: "parser", doc: "Whisper model size.", consumers: ["worker"], kind: "string", secret: false, dev: { value: "base", commented: true }, docker: { value: "base", commented: true } },
  { name: "OPENING_WHISPER_MODEL_PATH", group: "parser", doc: "Optional local Whisper model path.", consumers: ["worker"], kind: "string", secret: false, dev: { value: "", commented: true }, docker: { value: "", commented: true } },

  { name: "OPENING_CONNECTION_KEY", group: "connections", doc: "Base64 of exactly 32 random bytes; encrypts connection credentials and workspace model keys. Secret store only.", consumers: both, kind: "string", secret: true, dev: { value: "", commented: true }, docker: { value: "", commented: true } },
  { name: "OPENING_CONNECTION_KEY_ID", group: "connections", doc: "Key id for OPENING_CONNECTION_KEY (requires it).", consumers: both, kind: "string", secret: false, dev: { value: "primary", commented: true }, docker: { value: "primary", commented: true } },
  { name: "OPENING_CONNECTION_PREVIOUS_KEYS", group: "connections", doc: "JSON object of base64 keys kept during rotation (requires OPENING_CONNECTION_KEY).", consumers: both, kind: "json", secret: true, dev: { value: "{}", commented: true }, docker: { value: "{}", commented: true } },
  { name: "OPENING_IMAP_ALLOWED_HOSTS", group: "connections", doc: "Comma-separated administrator-approved IMAP hostnames.", consumers: both, kind: "csv", secret: false, dev: { value: "", commented: true }, docker: { value: "", commented: true } },
  { name: "OPENING_DINGTALK_ALLOWED_DOWNLOAD_HOSTS", group: "connections", doc: "Comma-separated DingTalk attachment download hosts. Unset denies every attachment.", consumers: ["web"], kind: "csv", secret: false, dev: { value: "", commented: true }, docker: { value: "", commented: true } },
  { name: "OPENING_DINGTALK_CORP_ID", group: "connections", doc: "DingTalk callback corp id (callback route needs all four DINGTALK_* callback values).", consumers: ["web"], kind: "string", secret: false, dev: { value: "", commented: true }, docker: { value: "", commented: true } },
  { name: "OPENING_DINGTALK_CALLBACK_TOKEN", group: "connections", doc: "DingTalk callback signing token. Secret store only.", consumers: ["web"], kind: "string", secret: true, dev: { value: "", commented: true }, docker: { value: "", commented: true } },
  { name: "OPENING_DINGTALK_ENCODING_AES_KEY", group: "connections", doc: "DingTalk callback AES key. Secret store only.", consumers: ["web"], kind: "string", secret: true, dev: { value: "", commented: true }, docker: { value: "", commented: true } },
  { name: "OPENING_DINGTALK_CALLBACK_CONNECTIONS", group: "connections", doc: "JSON map of callback connections.", consumers: ["web"], kind: "json", secret: false, dev: { value: "{}", commented: true }, docker: { value: "{}", commented: true } },
  { name: "FEISHU_REMINDER_CREDENTIAL", group: "connections", doc: "Feishu reminder adapter credential. Secret store only.", consumers: ["worker"], kind: "string", secret: true, dev: { value: "", commented: true }, docker: { value: "", commented: true } },

  { name: "OPENING_TEACHING_LOOP", group: "teaching", doc: "API enabled (default 1): teaching-loop routes (commands/checkpoint/resume) answer only when 1; checked on every request.", consumers: ["web"], kind: "bool", secret: false, dev: { value: "1", commented: true }, docker: { value: "1", commented: true } },
  { name: "OPENING_TEACHING_WORKSPACE", group: "teaching", doc: "UI shown (defaults to API switch): teaching workspace/loop UI. Requires OPENING_TEACHING_LOOP=1.", consumers: ["web"], kind: "bool", secret: false, dev: { value: "1", commented: true }, docker: { value: "1", commented: true } },
  { name: "OPENING_TEACHING_LOOP_ROLLOUT_PERCENT", group: "teaching", doc: "Gradual rollout 0-100 by stable user bucket (default 100). Requires OPENING_TEACHING_LOOP=1 when set.", consumers: ["web"], kind: "percent", min: 0, max: 100, secret: false, dev: { value: "100", commented: true }, docker: { value: "100", commented: true } },
  { name: "OPENING_TEACHING_COMPILER_ENABLED", group: "teaching", doc: "Worker: real teaching compiler (default 1); explicit 0 stops generation without publishing empty content.", consumers: ["worker"], kind: "bool", secret: false, dev: { value: "1", commented: true }, docker: { value: "1", commented: true } },
  { name: "OPENING_TEACHING_VALIDATION_ENABLED", group: "teaching", doc: "Worker: post-publish validation (default 0).", consumers: ["worker"], kind: "bool", secret: false, dev: { value: "0", commented: true }, docker: { value: "0", commented: true } },
  { name: "OPENING_ANSWER_STYLE", group: "teaching", doc: "Worker: append Markdown writing rules to tutor answers; 0 restores the previous prompt (default 1).", consumers: ["worker"], kind: "bool", secret: false, dev: { value: "1", commented: true }, docker: { value: "1", commented: true } },
  { name: "TEACHING_COMPILER_ENABLED", group: "teaching", doc: "Deprecated alias of OPENING_TEACHING_COMPILER_ENABLED (still read; validated).", consumers: ["worker"], kind: "bool", secret: false },
  { name: "TEACHING_VALIDATION_ENABLED", group: "teaching", doc: "Deprecated alias of OPENING_TEACHING_VALIDATION_ENABLED (still read; validated).", consumers: ["worker"], kind: "bool", secret: false },
  { name: "OPENING_MATRIX_TRANSFORM_INTERACTIVE", group: "teaching", doc: "UI-only: matrix transform interactivity (default 1). Delivered via capabilities.", consumers: ["web"], kind: "bool", secret: false, dev: { value: "1", commented: true }, docker: { value: "1", commented: true } },
  { name: "OPENING_CHAT_ARTIFACTS", group: "teaching", doc: "UI-only: jingwei 图解 under chat answers that already state a flow or numeric table (default 0). Delivered via capabilities.", consumers: ["web"], kind: "bool", secret: false, dev: { value: "0", commented: true }, docker: { value: "0", commented: true } },
  { name: "OPENING_CHAT_PROSE", group: "teaching", doc: "UI-only: render chat answers as Markdown with math; 0 falls back to plain text (default 1). Delivered via capabilities.", consumers: ["web"], kind: "bool", secret: false, dev: { value: "1", commented: true }, docker: { value: "1", commented: true } },
  { name: "OPENING_CHAT_SENSEWEAVE", group: "teaching", doc: "UI-only: SenseWeave fragments (diagrams, charts, timelines) inside chat answers. off | shadow (default: decide and count, UI unchanged) | on. Requires OPENING_CHAT_PROSE. Delivered via capabilities.", consumers: ["web"], kind: "enum", enumValues: ["off", "shadow", "on"], secret: false, dev: { value: "shadow", commented: true }, docker: { value: "shadow", commented: true } },
  { name: "OPENING_ADAPTIVE_PLANNING", group: "teaching", doc: "Daily drafts from learning signals, autonomy modes (manual/copilot/coach) and suggested tasks (default 0 = rules-only drafts). Delivered via capabilities; plan routes re-check.", consumers: ["web"], kind: "bool", secret: false, dev: { value: "0", commented: true }, docker: { value: "0", commented: true } },
  { name: "OPENING_PLAN_AGENT", group: "teaching", doc: "Model-assisted re-planning; only effective with OPENING_ADAPTIVE_PLANNING=1 (default 0).", consumers: ["web", "worker"], kind: "bool", secret: false, dev: { value: "0", commented: true }, docker: { value: "0", commented: true } },
  { name: "OPENING_SYSTEM_QUERY", group: "tutor", doc: "Owned read-only system queries in saved/ephemeral chat. Uses bounded native tools when a model is available, with deterministic fallback. Independent of adaptive planning; default 1. Explicit 0 disables both automatic and explicit queries.", consumers: ["web", "worker"], kind: "bool", secret: false, dev: { value: "1", commented: true }, docker: { value: "1", commented: true } },

  { name: "E2E_DATABASE_URL", group: "e2e", doc: "Browser E2E resets only this isolated database; its name must end in _e2e.", consumers: ["tests"], kind: "string", secret: true, dev: { value: "postgres://aistudy:aistudy@127.0.0.1:5433/aistudy_e2e" } },
  { name: "OPENING_TEST_DB", group: "e2e", doc: "1 enables the integration DB guard.", consumers: ["tests"], kind: "bool", secret: false },
  { name: "OPENING_TEST_DATABASE_URL", group: "e2e", doc: "Loopback aistudy_opening_test only.", consumers: ["tests"], kind: "string", secret: true },
  { name: "OPENING_E2E", group: "e2e", doc: "Build switch for the E2E dist dir (next.config).", consumers: ["tests"], kind: "bool", secret: false },
  { name: "AISTUDY_WEB_PREVIEW", group: "e2e", doc: "Build switch for local preview dist dir (next.config).", consumers: ["scripts"], kind: "bool", secret: false },
  { name: "MIGRATION_LEGACY_0003_ATTESTATION_FILE", group: "e2e", doc: "db:migrate legacy 0003 attestation file.", consumers: ["scripts"], kind: "string", secret: false },
  { name: "OPENING_OWNER_EMAIL", group: "e2e", doc: "Owner bootstrap script.", consumers: ["scripts"], kind: "string", secret: false },
  { name: "OPENING_OWNER_DISPLAY_NAME", group: "e2e", doc: "Owner bootstrap script.", consumers: ["scripts"], kind: "string", secret: false },
  { name: "FFMPEG_PATH", group: "e2e", doc: "Optional ffmpeg path for scripts.", consumers: ["scripts"], kind: "string", secret: false },
  { name: "FFPROBE_PATH", group: "e2e", doc: "Optional ffprobe path for scripts.", consumers: ["scripts"], kind: "string", secret: false },
  { name: "OPENING_BACKUP_STAGING", group: "e2e", doc: "Staging directory for opening-backup publish (or --staging).", consumers: ["scripts"], kind: "string", secret: false },
  { name: "OPENING_BACKUP_DRAFT", group: "e2e", doc: "Path to staged backup.json draft (or --draft).", consumers: ["scripts"], kind: "string", secret: false },
  { name: "OPENING_BACKUP_OUT", group: "e2e", doc: "Output path for .opening archive (or --out).", consumers: ["scripts"], kind: "string", secret: false },
  { name: "OPENING_BACKUP_ENCRYPT_OUT", group: "e2e", doc: "Optional encrypted archive output path (or --encrypt-out).", consumers: ["scripts"], kind: "string", secret: false },
  { name: "OPENING_BACKUP_PASSPHRASE", group: "e2e", doc: "Encrypt passphrase for opening-backup (required with encrypt-out; never argv).", consumers: ["scripts"], kind: "string", secret: true },
  { name: "OPENING_BACKUP_ARCHIVE_PATH", group: "e2e", doc: "Local archive path for readiness backupFreshness probe.", consumers: ["scripts"], kind: "string", secret: false, dev: { value: "", commented: true }, docker: { value: "", commented: true } },
  { name: "OPENING_BACKUP_MAX_AGE_HOURS", group: "e2e", doc: "Max age hours for backup freshness (default 24).", consumers: ["scripts"], kind: "int", min: 1, secret: false, dev: { value: "24", commented: true }, docker: { value: "24", commented: true } },
];

/** Removed build-time twins: a value here at runtime cannot reach the shipped bundle. */
export const REMOVED_PUBLIC_VARS: Record<string, string> = {
  NEXT_PUBLIC_OPENING_TEACHING_LOOP: "OPENING_TEACHING_LOOP",
  NEXT_PUBLIC_OPENING_TEACHING_WORKSPACE: "OPENING_TEACHING_WORKSPACE",
  NEXT_PUBLIC_OPENING_MATRIX_TRANSFORM_INTERACTIVE: "OPENING_MATRIX_TRANSFORM_INTERACTIVE",
  NEXT_PUBLIC_OPENING_CHAT_ARTIFACTS: "OPENING_CHAT_ARTIFACTS",
};

export function envSpec(name: string): EnvVarSpec | undefined {
  return ENV_REGISTRY.find((spec) => spec.name === name);
}

export const SECRET_ENV_NAMES: readonly string[] = ENV_REGISTRY.filter((s) => s.secret).map((s) => s.name);
