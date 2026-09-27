import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const workflow = readFileSync(`${root}.github/workflows/ci.yml`, "utf8").replaceAll("\r\n", "\n");
const docs = readFileSync(`${root}docs/operations/ci.md`, "utf8").replaceAll("\r\n", "\n");

function pushBranches(yaml) {
  const block = yaml.match(/^on:\n([\s\S]*?)\n\nconcurrency:/m)?.[1] ?? "";
  const push = block.match(/push:\n([\s\S]*?)(?=\n[ ]{2}[a-z_]+:|$)/)?.[1] ?? "";
  return [...push.matchAll(/^\s+-\s+(\S+)/gm)].map((match) => match[1]);
}

test("push triggers main and the active release branch, plus manual dispatch", () => {
  const branches = pushBranches(workflow);
  assert.deepEqual(branches, ["main", "feat/opening-release"]);
  assert.match(workflow, /^[ ]{2}workflow_dispatch:/m);
  assert.match(workflow, /^[ ]{2}pull_request:/m);
});

test("quality job keeps every platform gate and the verified MinIO image", () => {
  assert.match(workflow, /jobs:\n[ ]{2}quality:/);
  assert.match(workflow, /name:\s*lint-typecheck-test-build/);
  for (const command of [
    "npm ci",
    "npm run lint",
    "npm run typecheck",
    "node scripts/validate-opening-plan.mjs",
    "node --test tests/tooling/*.test.mjs",
    "npm test -- --project unit --project contract",
    "npm run test:integration",
    "npm run test:handler",
    "npm run test:browser",
    "npm run build",
  ]) {
    assert.ok(workflow.includes(command), command);
  }
  assert.match(workflow, /image:\s*bitnamilegacy\/minio:2025\.4\.22-debian-12-r2/);
  assert.doesNotMatch(workflow, /image:\s*bitnami\/minio:/);
  assert.match(workflow, /OPENING_TEST_DB:\s*"1"/);
  assert.match(workflow, /5433:5432/);
});

test("operations doc binds release evidence to the exact SHA and says GitHub runs are not local", () => {
  assert.match(docs, /feat\/opening-release/);
  assert.match(docs, /workflow_dispatch/);
  assert.match(docs, /08-delivery\.md/);
  assert.match(docs, /Q03/);
  assert.match(docs, /exact commit SHA/);
  assert.match(docs, /bitnamilegacy\/minio:2025\.4\.22-debian-12-r2/);
  assert.match(docs, /quay\.io\/minio\/minio:RELEASE\.2025-04-22T22-12-26Z/);
  assert.match(docs, /cannot be forged locally|cannot be reproduced locally|not locally forged/i);
  assert.match(docs, /GitHub Actions `quality` job is authoritative/);
});
