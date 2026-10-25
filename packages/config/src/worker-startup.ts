import { EnvValidationError } from "./env";

/** Shared by worker startup and the explicit parser warmup CLI. */
export function loadWorkerStartupConfig(source: NodeJS.ProcessEnv = process.env) {
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const raw = source[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
      throw new EnvValidationError([`${name}: must be an integer ${min}..${max}`]);
    }
    return value;
  };
  const initialMs = integer("WORKER_STARTUP_RETRY_INITIAL_MS", 5_000, 1_000, 300_000);
  const maxMs = integer("WORKER_STARTUP_RETRY_MAX_MS", 60_000, 1_000, 300_000);
  if (maxMs < initialMs) throw new EnvValidationError(["WORKER_STARTUP_RETRY_MAX_MS: must be >= WORKER_STARTUP_RETRY_INITIAL_MS"]);
  const role = source.WORKER_ROLE?.trim() || "all";
  return {
    readinessFile: source.WORKER_READINESS_FILE?.trim() || `.tmp/worker-${role}-ready.json`,
    readyTimeoutMs: integer("WORKER_READY_TIMEOUT_MS", 30_000, 1_000, 300_000),
    parserTimeoutMs: integer("PARSER_PREFLIGHT_TIMEOUT_MS", 120_000, 1_000, 600_000),
    ocrTimeoutMs: integer("PARSER_OCR_PREFLIGHT_TIMEOUT_MS", 120_000, 1_000, 600_000),
    // Keep the per-segment OCR fence below the existing 15-minute outer budget.
    ocrSegmentTimeoutSeconds: integer("PARSER_OCR_SEGMENT_TIMEOUT_SECONDS", 240, 1, 900),
    parserCacheFile: source.PARSER_PREFLIGHT_CACHE_FILE?.trim() || ".tmp/parser-preflight-success.json",
    parserCacheTtlMs: integer("PARSER_PREFLIGHT_CACHE_TTL_MS", 3_600_000, 0, 86_400_000),
    initialMs, maxMs,
  };
}
