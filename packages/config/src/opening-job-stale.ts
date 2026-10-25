import { EnvValidationError } from "./env";

export type OpeningJobStaleConfig = {
  /** A queued/generating lesson whose compile job is this old (or gone) is marked failed. */
  teachingGenerateStaleMs: number;
  /** A tutor job queued (never claimed) or running without heartbeat this long is ended. */
  tutorJobStaleMs: number;
};

const MIN_MS = 60_000;
const MAX_MS = 86_400_000;

function readMs(source: NodeJS.ProcessEnv, name: string, fallback: number, issues: string[]): number {
  const raw = source[name]?.trim();
  if (!raw) return fallback;
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(value) || value < MIN_MS || value > MAX_MS) {
    issues.push(`${name}: expected integer milliseconds ${MIN_MS}–${MAX_MS}`);
    return fallback;
  }
  return value;
}

/** Stale-job reconciliation thresholds shared by web (read-time) and worker (sweep). */
export function loadOpeningJobStaleConfig(source: NodeJS.ProcessEnv = process.env): OpeningJobStaleConfig {
  const issues: string[] = [];
  const config = {
    teachingGenerateStaleMs: readMs(source, "OPENING_TEACHING_GENERATE_STALE_MS", 900_000, issues),
    tutorJobStaleMs: readMs(source, "OPENING_TUTOR_JOB_STALE_MS", 600_000, issues),
  };
  if (issues.length) throw new EnvValidationError(issues);
  return config;
}
