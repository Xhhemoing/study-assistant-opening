import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
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
    "node --test tests/tooling/*.test.mjs scripts/opening-local-check.test.mjs",
    "npm test -- --project unit --project contract --project notion-pipeline",
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

test("static-unit installs the shared parser venv before real PDF renderer units", () => {
  const block = workflow.match(/^[ ]{2}static-unit:\n[\s\S]*?(?=^[ ]{2}[a-z][\w-]*:|$(?![\s\S]))/m)?.[0];
  assert.ok(block, "static-unit job must exist");
  assert.match(block, /^[ ]{4}env: \*quality-env$/m);
  const requiredSteps = [
    "      - *setup-parser-python",
    "      - *cache-parser-venv",
    "      - *install-parser",
    "        run: npm test -- --project unit --project contract --project notion-pipeline",
  ];
  let previous = -1;
  for (const step of requiredSteps) {
    const index = block.indexOf(step);
    assert.ok(index > previous, `static-unit must run ${step.trim()} in order`);
    previous = index;
  }
  assert.doesNotMatch(block, /\*(?:cache-parser-models|prepare-parser-models)/);

  const parser = workflow.match(/^[ ]{2}integration-parser:\n[\s\S]*?(?=^[ ]{2}[a-z][\w-]*:|$(?![\s\S]))/m)?.[0];
  assert.ok(parser, "integration-parser job must exist");
  assert.match(parser, /^[ ]{4}env: &quality-env$/m);
  for (const variable of ["PARSER_PYTHON", "PARSER_CWD", "HF_HOME", "HF_HUB_OFFLINE"]) {
    assert.match(parser, new RegExp(`^      ${variable}:`, "m"));
  }
  previous = -1;
  for (const step of [
    "      - &setup-parser-python",
    "      - &cache-parser-venv",
    "      - &install-parser",
    '          "$PARSER_PYTHON" -m pytest services/parser/tests -q',
    "        run: npm run test:integration",
  ]) {
    const index = parser.indexOf(step);
    assert.ok(index > previous, `integration-parser must run ${step.trim()} in order`);
    previous = index;
  }
});

test("technology spikes run once in the handler/browser job after Chromium installation", () => {
  const browser = workflow.match(/^[ ]{2}handler-browser-spikes:\n[\s\S]*?(?=^[ ]{2}[a-z][\w-]*:|$(?![\s\S]))/m)?.[0];
  const staticUnit = workflow.match(/^[ ]{2}static-unit:\n[\s\S]*?(?=^[ ]{2}[a-z][\w-]*:|$(?![\s\S]))/m)?.[0];
  assert.ok(browser, "handler-browser-spikes job must exist");
  assert.ok(staticUnit, "static-unit job must exist");
  const spike = "run: npm test -- --project '@aistudy/spike-*'";
  assert.equal(workflow.split(spike).length - 1, 1, "spikes must execute exactly once");
  assert.ok(!staticUnit.includes(spike), "static-unit must not run browser-dependent spikes");
  const installIndex = browser.indexOf("run: npx playwright install chromium --with-deps");
  const spikeIndex = browser.indexOf(spike);
  const handlerIndex = browser.indexOf("run: npm run test:handler");
  const browserIndex = browser.indexOf("run: npm run test:browser");
  assert.ok(installIndex >= 0 && installIndex < spikeIndex && spikeIndex < handlerIndex && handlerIndex < browserIndex,
    "handler-browser-spikes must install Chromium, then run spikes, then handler and browser tests");
});

test("parser is installed and seeded before integration runs with explicit Linux paths", () => {
  assert.match(workflow, /uses: actions\/setup-python@v5[\s\S]*?python-version: "3\.13"/);
  assert.match(workflow, /PARSER_PYTHON:.*\.local\/docling-venv\/bin\/python/);
  assert.match(workflow, /PARSER_CWD:.*services\/parser/);
  assert.match(workflow, /HF_HOME:.*\.local\/hf-home/);
  assert.match(workflow, /HF_HUB_OFFLINE: "1"/);
  const install = workflow.indexOf("services/parser/requirements-lock.txt");
  const seed = workflow.indexOf("opening_parser.prepare_models");
  const check = workflow.indexOf("opening_parser --check");
  const parserTests = workflow.indexOf("-m pytest services/parser/tests");
  const integration = workflow.indexOf("npm run test:integration");
  assert.ok(install > 0 && install < seed && seed < check && check < parserTests && parserTests < integration);
});

// Job ids: any GitHub-valid id (letter or "_" first), optionally quoted. The jobs
// section ends at the next top-level key, so later top-level keys are not jobs.
const JOB_KEY = String.raw`^[ ]{2}["']?([A-Za-z_][\w-]*)["']?:[ \t]*(?:#.*)?\n`;
function jobBlocks(yaml) {
  const start = yaml.search(/^jobs:[ \t]*(?:#.*)?\n/m);
  if (start < 0) return [];
  const rest = yaml.slice(start).replace(/^jobs:[^\n]*\n/, "");
  const end = rest.search(/^[^\s#][^\n]*:/m);
  const body = end < 0 ? rest : rest.slice(0, end);
  // Fail closed: a job-level line the parser cannot read as a job key (an anchored
  // `lint: &x`, a flow `lint: {...}`, a stray shallow line) would otherwise be folded
  // into the previous job and escape every per-job check. Block scalar content is
  // always indented deeper than its key, so it never sits at indent 1-3.
  const jobKeyLine = new RegExp(JOB_KEY);
  for (const line of body.split("\n")) {
    // Whitespace-only lines (spaces then a tab) are blank in YAML, not job keys.
    if (/^[ ]{1,3}[^\s#]/.test(line)) {
      assert.match(`${line}\n`, jobKeyLine, `jobs section line is not a plain job key: ${line.trim()}`);
    }
  }
  return [...body.matchAll(new RegExp(`${JOB_KEY}([\\s\\S]*?)(?=${JOB_KEY}|(?![\\s\\S]))`, "gm"))]
    .map((match) => ({ name: match[1], block: match[2] }));
}

test("every job in every workflow pins a runner image that the pinned Playwright supports", () => {
  const dir = `${root}.github/workflows/`;
  const files = readdirSync(dir).filter((name) => /\.ya?ml$/.test(name));
  assert.ok(files.includes("ci.yml"));
  for (const file of files) {
    const yaml = readFileSync(`${dir}${file}`, "utf8").replaceAll("\r\n", "\n");
    const jobs = jobBlocks(yaml);
    assert.ok(jobs.length > 0, `${file} defines jobs`);
    for (const { name, block } of jobs) {
      if (/^[ ]{4}uses:/m.test(block)) continue; // reusable workflow call: the callee pins its own runner
      const runner = block.match(/^[ ]{4}runs-on:[ \t]*["']?([^"'\s#]+)["']?/m)?.[1];
      assert.equal(runner, "ubuntu-24.04", `${file} job ${name} must pin runs-on: ubuntu-24.04`);
    }
  }
  assert.ok(jobBlocks(workflow).length >= 9);
  assert.match(docs, /ubuntu-24\.04/);
  assert.match(docs, /transaction_timeout/);
  // The parser venv key has no image component, so unpinning must also re-key it.
  assert.match(docs, /ImageOS/);
  assert.match(docs, /ImageVersion/);
  assert.match(docs, /parser-venv-v2/);
});

test("quality gate requires both split jobs and handler-browser-spikes shares the test env", () => {
  const jobs = Object.fromEntries(jobBlocks(workflow).map(({ name, block }) => [name, block]));
  const needs = jobs.quality.match(/^[ ]{4}needs:\s*\[([^\]]*)\]/m)?.[1].split(",").map((name) => name.trim());
  const gate = jobs.quality.match(/checks\.py gate ([^\n]+)/)?.[1].trim().split(/\s+/);
  for (const name of ["integration-parser", "handler-browser-spikes", "static-unit", "build"]) {
    assert.ok(jobs[name], `${name} job exists`);
    assert.ok(needs?.includes(name), `quality needs ${name}`);
    assert.ok(gate?.includes(name), `quality gate requires ${name}`);
  }
  assert.deepEqual([...gate].sort(), needs.filter((name) => !["changes", "docs"].includes(name)).sort(),
    "every worker the quality job waits for is also required to succeed");
  assert.match(jobs["handler-browser-spikes"], /^[ ]{4}env: \*quality-env$/m);
  assert.match(jobs["integration-parser"], /^[ ]{4}env: &quality-env$/m);
  const dir = `${root}.github/workflows/`;
  for (const file of readdirSync(dir).filter((name) => /\.ya?ml$/.test(name))) {
    assert.doesNotMatch(readFileSync(`${dir}${file}`, "utf8"), /^\s+cache:\s*["']?pip/m,
      `${file}: the parser venv cache is the only Python dependency cache`);
  }
});

test("every gate job runs even when a worker fails and requires exactly the workers it waits for", () => {
  const jobs = Object.fromEntries(jobBlocks(workflow).map(({ name, block }) => [name, block]));
  const gates = Object.entries(jobs).filter(([, block]) => /checks\.py gate /.test(block));
  assert.deepEqual(gates.map(([name]) => name).sort(), ["quality", "worker-gate"]);
  for (const [name, block] of gates) {
    // Without always(), a failed worker skips the gate, and a skipped required check can pass.
    assert.match(block, /^[ ]{4}if:\s*\$\{\{\s*always\(\)\s*\}\}\s*$/m, `${name} must run with if: always()`);
    const needs = block.match(/^[ ]{4}needs:\s*\[([^\]]*)\]/m)?.[1].split(",").map((item) => item.trim());
    const gate = block.match(/checks\.py gate ([^\n]+)/)?.[1].trim().split(/\s+/);
    assert.ok(needs?.includes("changes") && needs.includes("docs"), `${name} waits for classification and docs`);
    assert.deepEqual([...gate].sort(), needs.filter((item) => !["changes", "docs"].includes(item)).sort(), `${name} gate covers its workers`);
    for (const worker of gate) assert.ok(jobs[worker], `${name} gate names an existing job ${worker}`);
  }
});

test("every docs_only=false worker is required by exactly one gate job", () => {
  const jobs = jobBlocks(workflow);
  // Workers are defined by exclusion, not by matching their `if:` text, so a job whose
  // condition is spelled differently (or missing) cannot silently escape every gate.
  const gateJobs = jobs.filter(({ block }) => /checks\.py gate /.test(block));
  const nonWorkers = new Set(["changes", "docs", ...gateJobs.map(({ name }) => name)]);
  const workers = jobs.filter(({ name }) => !nonWorkers.has(name));
  assert.ok(workers.length >= 5, "worker detection found the code-change jobs");
  for (const { name, block } of workers) {
    // One canonical spelling keeps the docs-only skip auditable; change it here and in ci.yml together.
    assert.match(block, /^[ ]{4}if:[ \t]*needs\.changes\.outputs\.docs_only == 'false'[ \t]*$/m, `worker ${name} must use if: needs.changes.outputs.docs_only == 'false'`);
  }
  const gated = gateJobs
    .flatMap(({ block }) => block.match(/checks\.py gate ([^\n]+)/)[1].trim().split(/\s+/));
  for (const { name: worker } of workers) {
    const count = gated.filter((name) => name === worker).length;
    // An ungated worker can fail without blocking merge; a twice-gated one has ambiguous ownership.
    assert.equal(count, 1, `worker ${worker} must appear in exactly one gate, found ${count}`);
  }
  assert.deepEqual([...gated].sort(), workers.map(({ name }) => name).sort(), "gates name only docs_only=false workers");
});
