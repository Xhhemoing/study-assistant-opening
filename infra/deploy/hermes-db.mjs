#!/usr/bin/env node
// Keep production secrets in the child environment, never in argv or console output.
import { chmodSync, readFileSync, renameSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parseEnv } from "node:util";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Bind pg_dump to DATABASE_URL; ambient libpq service/password/host settings cannot redirect it. */
export function postgresBackupEnvironment(databaseUrl, inherited) {
  let url;
  try {
    url = new URL(databaseUrl);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) throw new Error();
  } catch { throw new Error("A PostgreSQL DATABASE_URL is required in the production configuration."); }
  const parameters = {
    sslmode: "PGSSLMODE", sslrootcert: "PGSSLROOTCERT", sslcert: "PGSSLCERT", sslkey: "PGSSLKEY",
    options: "PGOPTIONS", application_name: "PGAPPNAME", connect_timeout: "PGCONNECT_TIMEOUT",
  };
  for (const key of url.searchParams.keys()) {
    if (!Object.hasOwn(parameters, key) || url.searchParams.getAll(key).length !== 1) {
      throw new Error("Unsupported or duplicate PostgreSQL URL parameter; backup target was not guessed.");
    }
  }
  const env = Object.fromEntries(Object.entries(inherited).filter(([key]) => !key.startsWith("PG")));
  Object.assign(env, {
    PGHOST: url.hostname.replace(/^\[|\]$/g, ""), PGPORT: url.port || "5432", PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGAPPNAME: "aistudy-release-backup",
  });
  for (const [parameter, name] of Object.entries(parameters)) {
    if (url.searchParams.has(parameter)) env[name] = url.searchParams.get(parameter);
  }
  return env;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [action, configFile, target, parserPython, legacyDir] = process.argv.slice(2);
  function fail(message) { console.error(message); process.exit(1); }
  let configured;
  try { configured = parseEnv(readFileSync(configFile, "utf8")); }
  catch { fail("Cannot parse the production environment file (Node.js 22+ is required)."); }
  let env = { ...process.env, ...configured };
  function run(command, args, options = {}) {
    const result = spawnSync(command, args, { env, stdio: ["ignore", "ignore", "pipe"], ...options });
    if (result.error || result.status !== 0) fail(`${command} failed; sensitive command output was withheld.`);
  }

  if (action === "backup") {
    try { env = postgresBackupEnvironment(configured.DATABASE_URL, env); }
    catch (error) { fail(error instanceof Error ? error.message : "Invalid backup configuration."); }
    const partial = `${target}.partial`;
    run("pg_dump", ["--format=custom", "--no-owner", "--file", partial]);
    chmodSync(partial, 0o600);
    run("pg_restore", ["--list", partial]);
    renameSync(partial, target);
  } else if (action === "migrate") {
    run("npx", ["tsx", "./scripts/db-migrate.ts"], { cwd: target });
  } else if (action === "parser") {
    const cache = configured.HF_HOME || join(legacyDir, ".local/hf-home");
    env = {
      PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
      HOME: cache, TMPDIR: "/tmp", PARSER_TEMP_DIR: "/tmp/aistudy-parser-preflight",
      PARSER_PYTHON: parserPython, PARSER_CWD: join(target, "services/parser"),
      HF_HOME: cache, HF_HUB_CACHE: join(cache, "hub"), HUGGINGFACE_HUB_CACHE: join(cache, "hub"),
      TRANSFORMERS_CACHE: join(cache, "hub"), XDG_CACHE_HOME: cache, TORCH_HOME: join(cache, "torch"),
      PYTHONIOENCODING: "utf-8", PYTHONNOUSERSITE: "1", HF_HUB_OFFLINE: "1",
      ...(configured.PARSER_OCR_MODEL_DIR ? { PARSER_OCR_MODEL_DIR: configured.PARSER_OCR_MODEL_DIR } : {}),
    };
    run(parserPython, ["-m", "opening_parser", "--check"], { cwd: env.PARSER_CWD, timeout: 30_000 });
  } else {
    fail("Unknown database/preflight action.");
  }
}
