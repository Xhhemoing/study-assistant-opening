#!/usr/bin/env node
/**
 * Opening test DB wrapper: validate OPENING_TEST_DATABASE_URL, then run a child
 * with DATABASE_URL set only from that validated URL (never app defaults).
 *
 * Usage: node scripts/opening-test-db.mjs -- <command> [args...]
 * Also exports default setup() for Vitest globalSetup.
 */
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const REQUIRED_DB_NAME = "aistudy_opening_test";
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

export function assertOpeningTestDatabase(url, enabled) {
  if (enabled !== "1") {
    throw new Error(
      "Refusing destructive tests: set OPENING_TEST_DB=1 for the isolated opening test database",
    );
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("OPENING_TEST_DATABASE_URL is not a valid URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("OPENING_TEST_DATABASE_URL must use the postgres scheme");
  }
  if (!LOOPBACK.has(parsed.hostname.toLowerCase())) {
    throw new Error(
      `Refusing destructive tests: database host must be loopback, got ${parsed.hostname}`,
    );
  }
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (dbName !== REQUIRED_DB_NAME) {
    throw new Error(
      `Refusing destructive tests: database name must be exactly ${REQUIRED_DB_NAME}, got ${dbName || "(empty)"}`,
    );
  }
  return parsed;
}

export default async function setup() {
  const raw = process.env.OPENING_TEST_DATABASE_URL;
  if (!raw?.trim()) {
    throw new Error(
      "OPENING_TEST_DATABASE_URL is required for handler/integration projects",
    );
  }
  const validated = assertOpeningTestDatabase(raw, process.env.OPENING_TEST_DB);
  process.env.DATABASE_URL = validated.toString();
}

function main() {
  const argv = process.argv.slice(2);
  const sep = argv.indexOf("--");
  const cmd = sep === -1 ? argv : argv.slice(sep + 1);
  if (!cmd.length) {
    console.error(
      "Usage: node scripts/opening-test-db.mjs -- <command> [args...]",
    );
    process.exit(2);
  }
  const raw = process.env.OPENING_TEST_DATABASE_URL;
  if (!raw?.trim()) {
    console.error("OPENING_TEST_DATABASE_URL is required");
    process.exit(1);
  }
  const validated = assertOpeningTestDatabase(raw, process.env.OPENING_TEST_DB);
  const env = {
    ...process.env,
    DATABASE_URL: validated.toString(),
    OPENING_TEST_DB: "1",
  };
  const result = spawnSync(cmd[0], cmd.slice(1), {
    stdio: "inherit",
    env,
    shell: process.platform === "win32",
  });
  process.exit(result.status ?? 1);
}

const isDirect =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirect) {
  main();
}
