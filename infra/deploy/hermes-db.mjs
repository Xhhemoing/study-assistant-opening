#!/usr/bin/env node
// Keep production secrets in the child environment, never in argv or console output.
import { chmodSync, readFileSync, renameSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parseEnv } from "node:util";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  } else if (action === "confirmation-recovery-preflight") {
    // Run this trusted compatibility anchor, NEVER code supplied by the candidate target.
    // Fourth argument is the independently reviewed content digest, not a self-attestation.
    if (!configured.DATABASE_URL || !/^[a-f0-9]{64}$/.test(parserPython ?? "")) {
      fail("Recovery preflight requires configured DATABASE_URL and a reviewed artifact content digest.");
    }
    const anchor = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const moduleUrl = pathToFileURL(join(anchor, "packages/database/src/migrate.ts")).href;
    const code = `const { createSqlClient, preflightConfirmationRecovery } = await import(${JSON.stringify(moduleUrl)});
      const sql = createSqlClient(process.env.DATABASE_URL, { max: 1 });
      try { console.log(JSON.stringify(await preflightConfirmationRecovery(sql, {
        artifactRoot: ${JSON.stringify(resolve(target))}, expectedArtifactContentDigest: ${JSON.stringify(parserPython)}
      }))); } catch (error) {
        console.log(JSON.stringify({ eligible: false, code: /^MIGRATION_[A-Z0-9_]+$/.test(error.code ?? "")
          ? error.code : "MIGRATION_RECOVERY_INCOMPATIBLE", automaticRecovery: false }));
        process.exitCode = 1;
      } finally { await sql.end({ timeout: 5 }); }`;
    const result = spawnSync(join(anchor, "node_modules/.bin/tsx"), ["--eval", `(async () => { ${code} })()`],
      { env, cwd: anchor, stdio: ["ignore", "pipe", "pipe"] });
    if (result.error || !result.stdout?.length) fail("Compatibility anchor preflight failed; recovery is not permitted.");
    process.stdout.write(result.stdout);
    if (result.status !== 0) process.exitCode = 1;
    // Report only. No migrate, OLD_TARGET change, transition edit, pointer switch or writer resume.
  } else if (["plan", "quiescence", "migrate"].includes(action)) {
    if (!configured.DATABASE_URL) fail("A configured DATABASE_URL is required.");
    const moduleUrl = pathToFileURL(join(resolve(target), "packages/database/src/migrate.ts")).href;
    const operation = { plan: "planMigrations", quiescence: "inspectMigrationQuiescence", migrate: "applyMigrations" }[action];
    const code = `const { createMigrationSqlClient, ${operation} } = await import(${JSON.stringify(moduleUrl)});
      const sql = createMigrationSqlClient(process.env.DATABASE_URL);
      try {
        let legacy0003Attestation;
        if (${JSON.stringify(action)} === "migrate" && process.env.MIGRATION_LEGACY_0003_ATTESTATION_FILE) {
          const { readFile } = await import("node:fs/promises");
          const value = JSON.parse(await readFile(process.env.MIGRATION_LEGACY_0003_ATTESTATION_FILE, "utf8"));
          if (!value || typeof value !== "object" || !Array.isArray(value.observedMigrationIds)
            || !value.observedMigrationIds.every(id => typeof id === "string")
            || !["databaseFingerprint", "operator", "preflightSummary", "backupEvidence"].every(key => typeof value[key] === "string")) {
            throw new Error("Invalid legacy attestation file");
          }
          legacy0003Attestation = value;
        }
        console.log(JSON.stringify(await ${operation}(sql, { legacy0003Attestation })));
      }
      catch (error) {
        console.log(JSON.stringify({ outcome: "unknown-or-partial", code: /^MIGRATION_[A-Z0-9_]+$/.test(error.code ?? "") ? error.code : "MIGRATION_EXECUTION_UNCONFIRMED" }));
        process.exitCode = 1;
      } finally { await sql.end({ timeout: 5 }); }`;
    // Fixed adapter, no npx installation, PGOPTIONS fiction or retry. A failed
    // subprocess is NOT evidence that its PostgreSQL backend has stopped.
    const result = spawnSync(join(resolve(target), "node_modules/.bin/tsx"), ["--eval", `(async () => { ${code} })()`],
      { env, cwd: target, stdio: ["ignore", "pipe", "pipe"] });
    if (result.error || !result.stdout?.length) fail("Migration session outcome is unconfirmed; backend completion must be inspected.");
    process.stdout.write(result.stdout);
    if (result.status !== 0) process.exitCode = 1;
  } else if (action === "parser") {
    const cache = configured.HF_HOME || join(legacyDir, ".local/hf-home");
    env = {
      PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
      HOME: cache, TMPDIR: "/tmp", PARSER_TEMP_DIR: "/tmp/aistudy-parser-preflight",
      PARSER_PYTHON: parserPython, PARSER_CWD: join(target, "services/parser"),
      HF_HOME: cache, HF_HUB_CACHE: join(cache, "hub"), HUGGINGFACE_HUB_CACHE: join(cache, "hub"),
      TRANSFORMERS_CACHE: join(cache, "hub"), XDG_CACHE_HOME: cache, TORCH_HOME: join(cache, "torch"),
      PYTHONIOENCODING: "utf-8", PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1", HF_HUB_OFFLINE: "1",
      ...(configured.PARSER_OCR_MODEL_DIR ? { PARSER_OCR_MODEL_DIR: configured.PARSER_OCR_MODEL_DIR } : {}),
    };
    // Match provision-worker's cold-import allowance on the shared host.
    run(parserPython, ["-m", "opening_parser", "--check"], { cwd: env.PARSER_CWD, timeout: 90_000 });
  } else {
    fail("Unknown database/preflight action.");
  }
}
