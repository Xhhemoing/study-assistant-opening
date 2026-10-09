import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { evaluateOpeningLocalCheck, REQUIRED_ENV } from "./opening-local-check.mjs";

const SECRET = "super-secret-token-value";

function readyEnv() {
  return Object.fromEntries(REQUIRED_ENV.map((name) => [name, name === "DATABASE_URL" ? `postgres://user:${SECRET}@127.0.0.1:5432/aistudy` : "present"]));
}

function readyInput(overrides = {}) {
  return {
    ports: [
      { name: "postgres-dev", port: 5432, open: true },
      { name: "redis", port: 6379, open: true },
      { name: "minio", port: 9000, open: true },
      { name: "minio-console", port: 9001, open: true },
      { name: "web", port: 3000, open: true },
      { name: "postgres-test", port: 5434, open: true },
    ],
    health: { status: "ok", checks: { database: "up", redis: "up", storage: "up", workerBacklog: "up" } },
    env: readyEnv(),
    parserPythonExists: true,
    readiness: { state: "ok", items: [{ key: "budget", ok: true, detail: SECRET }] },
    ...overrides,
  };
}

test("reports each port, health check, env flag, parser path, and readiness item", () => {
  const report = evaluateOpeningLocalCheck(readyInput());
  assert.equal(report.ok, true);
  for (const line of [
    "postgres-dev 5432 open: true",
    "redis 6379 open: true",
    "minio 9000 open: true",
    "minio-console 9001 open: true",
    "web 3000 open: true",
    "postgres-test 5434 open: true",
    "health status: ok",
    "health database: up",
    "health redis: up",
    "health storage: up",
    "health workerBacklog: up",
    "env DATABASE_URL set: true",
    "env OPENING_TEST_DB set: true",
    "parser PYTHON exists: true",
    "ai-readiness state: ok",
    "ai-readiness budget ok: true",
  ]) {
    assert.ok(report.lines.includes(line), line);
  }
});

test("names closed ports, down health, missing env, a missing parser, and a missing readiness route", () => {
  const env = readyEnv();
  env.REDIS_URL = "";
  delete env.PARSER_CWD;
  const report = evaluateOpeningLocalCheck(readyInput({
    ports: readyInput().ports.map((item) => item.name === "web" ? { ...item, open: false } : item),
    health: { status: "down", checks: { database: "up", redis: "down", storage: "up", workerBacklog: "down" } },
    env,
    parserPythonExists: false,
    readiness: { state: "not-implemented" },
  }));
  assert.equal(report.ok, false);
  for (const line of [
    "web 3000 open: false",
    "health status: down",
    "health redis: down",
    "health workerBacklog: down",
    "env REDIS_URL set: false",
    "env PARSER_CWD set: false",
    "parser PYTHON exists: false",
    "ai-readiness state: not-implemented",
  ]) {
    assert.ok(report.lines.includes(line), line);
  }
});

test("never prints environment values or readiness details", () => {
  const report = evaluateOpeningLocalCheck(readyInput({
    health: { status: "unreachable" },
    readiness: { state: "unauthorized" },
  }));
  const text = report.lines.join("\n");
  assert.equal(text.includes(SECRET), false);
  assert.equal(text.includes("postgres://"), false);
  assert.equal(report.lines.includes("health status: unreachable"), true);
  assert.equal(report.lines.includes("ai-readiness state: unauthorized"), true);
  const source = readFileSync(new URL("./opening-local-check.mjs", import.meta.url), "utf8");
  assert.equal(source.includes(SECRET), false);
});
