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

function fail(message) {
  console.error(`verify:ci FAILED: ${message}`);
  process.exit(1);
}

if (!existsSync(workflowPath)) {
  fail("missing .github/workflows/ci.yml");
}

const yaml = readFileSync(workflowPath, "utf8");
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

const contract = spawnSync(
  "npm",
  ["test", "--", "tests/contract/ci-workflow.test.ts"],
  { cwd: root, stdio: "inherit", shell: process.platform === "win32" },
);
if (contract.status !== 0) {
  process.exit(contract.status ?? 1);
}

console.log("verify:ci OK — CI workflow contract satisfied.");
