import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const REQUIRED_ENV = [
  "DATABASE_URL",
  "REDIS_URL",
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "PUBLIC_BASE_URL",
  "PARSER_PYTHON",
  "PARSER_CWD",
  "OPENING_TEST_DATABASE_URL",
  "OPENING_TEST_DB",
];

export const CHECK_PORTS = [
  { name: "postgres-dev", port: 5432 },
  { name: "redis", port: 6379 },
  { name: "minio", port: 9000 },
  { name: "minio-console", port: 9001 },
  { name: "web", port: 3000 },
  { name: "postgres-test", port: 5434 },
];

const HEALTH_CHECKS = ["database", "redis", "storage", "workerBacklog"];
const HEALTH_STATES = new Set(["ok", "down", "unreachable"]);
const READINESS_STATES = new Set(["ok", "not-implemented", "unauthorized", "unreachable", "unrecognized"]);

function isSet(value) {
  return typeof value === "string" ? value.trim() !== "" : false;
}

export function evaluateOpeningLocalCheck({ ports, health, env, parserPythonExists, readiness }) {
  const lines = [];
  for (const item of ports) {
    lines.push(`${item.name} ${item.port} open: ${item.open === true}`);
  }
  const healthStatus = HEALTH_STATES.has(health?.status) ? health.status : "unrecognized";
  lines.push(`health status: ${healthStatus}`);
  for (const name of HEALTH_CHECKS) {
    const value = health?.checks?.[name];
    lines.push(`health ${name}: ${value === "up" || value === "down" ? value : "missing"}`);
  }
  for (const name of REQUIRED_ENV) {
    lines.push(`env ${name} set: ${isSet(env?.[name])}`);
  }
  lines.push(`parser PYTHON exists: ${parserPythonExists === true}`);
  const readinessState = READINESS_STATES.has(readiness?.state) ? readiness.state : "unrecognized";
  lines.push(`ai-readiness state: ${readinessState}`);
  const items = readinessState === "ok" && Array.isArray(readiness?.items) ? readiness.items : [];
  for (const item of items) {
    if (!item || typeof item.key !== "string" || item.key.trim() === "") continue;
    lines.push(`ai-readiness ${item.key} ok: ${item.ok === true}`);
  }
  const portsOk = ports.length > 0 && ports.every((item) => item.open === true);
  const healthOk = healthStatus === "ok" && HEALTH_CHECKS.every((name) => health?.checks?.[name] === "up");
  const envOk = REQUIRED_ENV.every((name) => isSet(env?.[name]));
  const readinessOk = readinessState === "ok" && items.length > 0 && items.every((item) => item?.ok === true);
  return {
    ok: portsOk && healthOk && envOk && parserPythonExists === true && readinessOk,
    lines,
  };
}

function probePort(port, host = "127.0.0.1", timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (open) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function readDotEnv(file) {
  const values = {};
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return values;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function mergedEnv(root) {
  const file = readDotEnv(path.join(root, ".env"));
  const merged = {};
  for (const name of REQUIRED_ENV) {
    const fromProcess = process.env[name];
    merged[name] = isSet(fromProcess) ? fromProcess : (file[name] ?? "");
  }
  return merged;
}

async function fetchJson(url) {
  const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5000) });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

function projectHealth(result) {
  if (!result || typeof result.body !== "object" || result.body === null) return { status: "unreachable" };
  const status = result.body.status === "ok" || result.body.status === "down" ? result.body.status : "unreachable";
  const checks = {};
  for (const name of HEALTH_CHECKS) {
    const value = result.body.checks?.[name];
    if (value === "up" || value === "down") checks[name] = value;
  }
  return { status, checks };
}

function projectReadiness(result) {
  if (!result) return { state: "unreachable" };
  if (result.status === 404) return { state: "not-implemented" };
  if (result.status === 401) return { state: "unauthorized" };
  if (result.status !== 200 || typeof result.body !== "object" || result.body === null) return { state: "unrecognized" };
  if (!Array.isArray(result.body.items)) return { state: "unrecognized" };
  return {
    state: "ok",
    items: result.body.items.map((item) => ({ key: item?.key, ok: item?.ok === true })),
  };
}

export async function collectOpeningLocalCheck(root = process.cwd()) {
  const env = mergedEnv(root);
  const parserSetting = env.PARSER_PYTHON.trim();
  const parserPath = parserSetting
    ? path.resolve(root, parserSetting)
    : path.join(root, ".local", "docling-venv", "Scripts", "python.exe");
  const ports = [];
  for (const item of CHECK_PORTS) {
    ports.push({ ...item, open: await probePort(item.port) });
  }
  let health = { status: "unreachable" };
  let readiness = { state: "unreachable" };
  try {
    health = projectHealth(await fetchJson("http://127.0.0.1:3000/api/opening/health"));
  } catch {
    health = { status: "unreachable" };
  }
  try {
    readiness = projectReadiness(await fetchJson("http://127.0.0.1:3000/api/opening/ai-readiness"));
  } catch {
    readiness = { state: "unreachable" };
  }
  return evaluateOpeningLocalCheck({
    ports,
    health,
    env,
    parserPythonExists: existsSync(parserPath),
    readiness,
  });
}

async function main() {
  const report = await collectOpeningLocalCheck();
  process.stdout.write(`${report.lines.join("\n")}\n`);
  process.exit(report.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
