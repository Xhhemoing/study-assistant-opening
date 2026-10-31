/**
 * PR-H §7.3 server configuration. Server/worker only. Validates the whole
 * registry at startup (strict booleans, ranges, dependencies, no build-time
 * public switches) and resolves secret-free per-user capabilities.
 */
import { EnvValidationError, loadEnv, type AppEnv } from "./env";
import { ENV_REGISTRY, REMOVED_PUBLIC_VARS, type EnvConsumer, type EnvVarSpec } from "./registry";
import { loadWorkerEnv, type WorkerEnv } from "./worker-env";
import { computeBuildConfigDigest } from "./public/build-config.mjs";
import { CLOSED_CAPABILITIES, type OpeningCapabilities } from "./public/capabilities";
import { senseWeaveGatesSchema, SENSEWEAVE_INITIAL_GATES, type SenseWeaveGates } from "./public/senseweave";

type Source = NodeJS.ProcessEnv | Record<string, string | undefined>;
export type ServerRole = "web" | "worker";

const TRUE = new Set(["1", "true", "yes"]);
const FALSE = new Set(["0", "false", "no"]);

function present(source: Source, name: string): string | undefined {
  const raw = source[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Strict boolean: 1/0/true/false/yes/no (case-insensitive). Anything else fails. */
export function parseBooleanEnv(source: Source, name: string, fallback: boolean): boolean {
  const raw = present(source, name);
  if (raw === undefined) return fallback;
  const value = raw.toLowerCase();
  if (TRUE.has(value)) return true;
  if (FALSE.has(value)) return false;
  throw new EnvValidationError([`${name}: invalid boolean "${raw}" (use 1/0/true/false)`]);
}

function kindIssue(spec: EnvVarSpec, raw: string): string | null {
  switch (spec.kind) {
    case "bool":
      return TRUE.has(raw.toLowerCase()) || FALSE.has(raw.toLowerCase()) ? null : `${spec.name}: invalid boolean "${raw}" (use 1/0/true/false)`;
    case "int":
    case "percent": {
      if (!/^-?\d+$/.test(raw)) return `${spec.name}: must be an integer, got "${raw}"`;
      const n = Number(raw);
      if (spec.min !== undefined && n < spec.min) return `${spec.name}: must be >= ${spec.min}`;
      if (spec.max !== undefined && n > spec.max) return `${spec.name}: must be <= ${spec.max}`;
      return null;
    }
    case "url":
      try { new URL(raw); return null; } catch { return `${spec.name}: must be a valid URL`; }
    case "json":
      try { JSON.parse(raw); return null; } catch { return `${spec.name}: must be valid JSON`; }
    case "enum":
      return spec.enumValues?.includes(raw) ? null : `${spec.name}: must be one of ${spec.enumValues?.join(", ")}`;
    case "string":
      return spec.min !== undefined && raw.length < spec.min ? `${spec.name}: must be at least ${spec.min} characters` : null;
    default:
      return null;
  }
}

/** Cross-variable rules. Each entry is also a row of the "not allowed" truth table. */
export const DEPENDENCY_RULES: { id: string; message: string; violated: (s: Source) => boolean }[] = [
  {
    id: "teaching-ui-requires-api",
    message: "OPENING_TEACHING_WORKSPACE=1 (UI shown) requires OPENING_TEACHING_LOOP=1 (API enabled)",
    violated: (s) => isTrue(s, "OPENING_TEACHING_WORKSPACE") && present(s, "OPENING_TEACHING_LOOP") !== undefined && !isTrue(s, "OPENING_TEACHING_LOOP"),
  },
  {
    id: "connection-key-id-requires-key",
    message: "OPENING_CONNECTION_KEY_ID / OPENING_CONNECTION_PREVIOUS_KEYS require OPENING_CONNECTION_KEY",
    violated: (s) => (present(s, "OPENING_CONNECTION_KEY_ID") !== undefined || present(s, "OPENING_CONNECTION_PREVIOUS_KEYS") !== undefined)
      && present(s, "OPENING_CONNECTION_KEY") === undefined,
  },
  {
    id: "dingtalk-callback-all-or-none",
    message: "DingTalk callback needs all of OPENING_DINGTALK_CORP_ID, _CALLBACK_TOKEN, _ENCODING_AES_KEY, _CALLBACK_CONNECTIONS",
    violated: (s) => {
      const names = ["OPENING_DINGTALK_CORP_ID", "OPENING_DINGTALK_CALLBACK_TOKEN", "OPENING_DINGTALK_ENCODING_AES_KEY", "OPENING_DINGTALK_CALLBACK_CONNECTIONS"];
      const set = names.filter((n) => present(s, n) !== undefined).length;
      return set > 0 && set < names.length;
    },
  },
];

function isTrue(source: Source, name: string): boolean {
  const raw = present(source, name)?.toLowerCase();
  return raw !== undefined && TRUE.has(raw);
}

/** Registry-wide issues for one role. Never includes a value (secrets stay out of logs). */
export function collectEnvIssues(source: Source, role: ServerRole): string[] {
  const issues: string[] = [];
  const production = present(source, "NODE_ENV") === "production";
  for (const spec of ENV_REGISTRY) {
    if (!spec.consumers.includes(role as EnvConsumer)) continue;
    const raw = present(source, spec.name);
    if (raw === undefined) {
      if (spec.required === "always" || (spec.required === "production" && production)) {
        issues.push(`${spec.name}: missing required value`);
      }
      continue;
    }
    const issue = kindIssue(spec, raw);
    if (issue) issues.push(spec.secret ? issue.replace(/"[^"]*"/, "<redacted>") : issue);
  }
  for (const name of Object.keys(source)) {
    if (!name.startsWith("NEXT_PUBLIC_")) continue;
    const replacement = REMOVED_PUBLIC_VARS[name];
    issues.push(replacement
      ? `${name}: removed build-time twin; set the server switch ${replacement} (UI reads /api/opening/capabilities)`
      : `${name}: build-time public variables are not allowed (inlined at next build; a runtime value proves nothing about the bundle)`);
  }
  for (const rule of DEPENDENCY_RULES) if (rule.violated(source)) issues.push(`dependency: ${rule.message}`);
  return issues;
}

export type FeatureSwitches = {
  teachingLoop: { api: boolean; ui: boolean };
  chatArtifacts: boolean;
  chatProse: boolean;
  chatSenseWeave: "off" | "shadow" | "on";
  senseWeaveBetaUsers?: readonly string[];
  senseWeaveGates?: SenseWeaveGates;
  openingRelease: boolean;
  adaptivePlanning: boolean;
  systemQuery: boolean;
  studySessionV2?: boolean;
};

/** Strict, infrastructure-free switches (used per request for re-authorization). */
export function loadFeatureSwitches(source: Source = process.env): FeatureSwitches {
  const issues = DEPENDENCY_RULES.filter((rule) => rule.violated(source)).map((rule) => `dependency: ${rule.message}`);
  const read = (name: string, fallback: boolean) => {
    try { return parseBooleanEnv(source, name, fallback); } catch (error) {
      issues.push(...(error as EnvValidationError).issues);
      return fallback;
    }
  };
  const api = read("OPENING_TEACHING_LOOP", true);
  const ui = read("OPENING_TEACHING_WORKSPACE", api);
  const chatArtifacts = read("OPENING_CHAT_ARTIFACTS", false);
  const chatProse = read("OPENING_CHAT_PROSE", true);
  const senseWeaveRaw = present(source, "OPENING_CHAT_SENSEWEAVE")?.toLowerCase() ?? "shadow";
  const chatSenseWeave = senseWeaveRaw === "off" || senseWeaveRaw === "shadow" || senseWeaveRaw === "on" ? senseWeaveRaw : "off";
  if (chatSenseWeave !== senseWeaveRaw) issues.push(`OPENING_CHAT_SENSEWEAVE: must be one of off, shadow, on`);
  const betaUsersRaw = present(source, "OPENING_CHAT_SENSEWEAVE_BETA_USERS");
  const senseWeaveBetaUsers = betaUsersRaw?.split(",").map(value => value.trim()).filter(Boolean) ?? [];
  if (senseWeaveBetaUsers.length > 100 || senseWeaveBetaUsers.some(value => !/^[a-zA-Z0-9_-]{1,128}$/.test(value))) {
    issues.push("OPENING_CHAT_SENSEWEAVE_BETA_USERS: expected at most 100 explicit account IDs (no wildcard)");
  }
  let senseWeaveGates = SENSEWEAVE_INITIAL_GATES;
  const gatesRaw = present(source, "OPENING_CHAT_SENSEWEAVE_GATES");
  if (gatesRaw) {
    try { senseWeaveGates = senseWeaveGatesSchema.parse(JSON.parse(gatesRaw)); }
    catch { issues.push("OPENING_CHAT_SENSEWEAVE_GATES: invalid versioned gating table"); }
  }
  const openingRelease = read("OPENING_RELEASE", present(source, "NODE_ENV") === "production");
  const adaptivePlanning = read("OPENING_ADAPTIVE_PLANNING", false);
  const studySessionV2 = read("OPENING_STUDY_SESSION_V2", false);
  const systemQuery = read("OPENING_SYSTEM_QUERY", true);
  if (issues.length) throw new EnvValidationError(issues);
  return {
    teachingLoop: { api, ui }, chatArtifacts, chatProse, chatSenseWeave, openingRelease,
    adaptivePlanning, systemQuery, studySessionV2,
    senseWeaveBetaUsers, senseWeaveGates,
  };
}

/** Per-user, secret-free capabilities. Anonymous users get the loop closed. */
export function resolveCapabilities(switches: FeatureSwitches, userId: string | null): OpeningCapabilities {
  const api = userId !== null && switches.teachingLoop.api;
  return {
    ...CLOSED_CAPABILITIES,
    teachingLoop: { api, ui: api && switches.teachingLoop.ui },
    matrixTransformInteractive: true,
    chatArtifacts: switches.chatArtifacts,
    chatProse: switches.chatProse,
    // Fragments are rendered by LearningProse; without it there is nothing to embed into.
    chatSenseWeave: !switches.chatProse || userId === null ? "off"
      : switches.chatSenseWeave === "on" && !switches.senseWeaveBetaUsers?.includes(userId) ? "shadow"
      : switches.chatSenseWeave,
    senseWeaveGates: switches.senseWeaveGates ?? SENSEWEAVE_INITIAL_GATES,
    registrationOpen: !switches.openingRelease,
    adaptivePlanning: switches.adaptivePlanning,
    planAgent: false,
    systemQuery: userId !== null && switches.systemQuery,
    studySessionV2: api && switches.teachingLoop.ui && switches.studySessionV2 === true,
  };
}

export type ServerConfig =
  | { role: "web"; switches: FeatureSwitches; env: AppEnv; buildConfigDigest: string }
  | { role: "worker"; switches: FeatureSwitches; env: WorkerEnv; buildConfigDigest: string };

/**
 * Startup validation. Throws EnvValidationError listing every issue (names only).
 * `compiledBuildDigest` is the digest inlined at next build; it must match the
 * digest of the runtime environment, or this image was built for another config.
 */
export function loadServerConfig(
  source: Source,
  role: ServerRole,
  options: { compiledBuildDigest?: string } = {},
): ServerConfig {
  const issues = collectEnvIssues(source, role);
  const runtimeDigest = computeBuildConfigDigest(source);
  if (options.compiledBuildDigest !== undefined && options.compiledBuildDigest !== runtimeDigest) {
    issues.push(`build config digest mismatch: image built with ${options.compiledBuildDigest}, runtime ${runtimeDigest}`);
  }
  let env: AppEnv | WorkerEnv | undefined;
  try {
    env = role === "web" ? loadEnv(source as NodeJS.ProcessEnv) : loadWorkerEnv(source as NodeJS.ProcessEnv);
  } catch (error) {
    if (error instanceof EnvValidationError) issues.push(...error.issues);
    else issues.push(`env: ${(error as Error).message}`);
  }
  let switches: FeatureSwitches | undefined;
  try { switches = loadFeatureSwitches(source); } catch (error) {
    if (!(error instanceof EnvValidationError)) throw error;
    for (const issue of error.issues) if (!issues.includes(issue)) issues.push(issue);
  }
  if (issues.length || !env || !switches) throw new EnvValidationError([...new Set(issues)]);
  return role === "web"
    ? { role, switches, env: env as AppEnv, buildConfigDigest: runtimeDigest }
    : { role, switches, env: env as WorkerEnv, buildConfigDigest: runtimeDigest };
}
