#!/usr/bin/env node
/**
 * Local CI contract verification (no GitHub Actions runner required).
 * Asserts workflow structure, then runs the same quality gates where possible.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = path.join(root, ".github/workflows/ci.yml");
const runHeavyPath = path.join(root, "scripts/run-heavy.mjs");

function fail(message) {
  console.error(`verify:ci FAILED: ${message}`);
  process.exit(1);
}

if (!existsSync(workflowPath)) {
  fail("missing .github/workflows/ci.yml");
}
if (!existsSync(runHeavyPath)) {
  fail("missing scripts/run-heavy.mjs");
}

const yaml = readFileSync(workflowPath, "utf8");
const runner = spawnSync(process.execPath, ["--test", path.join(root, "tests/tooling/run-heavy.test.mjs")], {
  cwd: root,
  stdio: "inherit",
});
if (runner.status !== 0) fail("heavy-task runner behavior checks failed");
const required = [
  "npm ci",
  "npm run lint",
  "npm run typecheck",
  "npm test",
  "npm run test:integration",
  "npm run test:handler",
  "npm run test:browser",
  "npm run build",
  "postgres:",
  "postgres-e2e:",
  "redis:",
];

for (const item of required) {
  if (!yaml.includes(item) && !new RegExp(item, "i").test(yaml)) {
    fail(`workflow missing required fragment: ${item}`);
  }
}

if (!/minio/i.test(yaml)) {
  fail("workflow missing minio service");
}

// Plan §7.4 server data-access boundary (Client Component graph must not
// reach DB drivers / server-only adapters, directly or transitively).
const boundary = spawnSync(process.execPath, [path.join(root, "scripts/check-server-boundary.mjs")], {
  cwd: root,
  stdio: "inherit",
});
if (boundary.status !== 0) {
  fail("server data-access boundary violated (scripts/check-server-boundary.mjs)");
}

const contractCommand = process.platform === "win32"
  ? {
      command: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", "npm test -- tests/contract/ci-workflow.test.ts"],
    }
  : {
      command: "npm",
      args: ["test", "--", "tests/contract/ci-workflow.test.ts"],
    };
const contract = spawnSync(contractCommand.command, contractCommand.args, {
  cwd: root,
  stdio: "inherit",
});
if (contract.status !== 0) {
  process.exit(contract.status ?? 1);
}

console.log("verify:ci OK — CI workflow contract satisfied.");
