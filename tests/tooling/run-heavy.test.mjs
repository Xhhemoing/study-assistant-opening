import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { waitForFreeMemory } from "../../scripts/run-heavy.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const wrapper = path.join(root, "scripts/run-heavy.mjs");
const shellWrapper = path.join(root, "scripts/run-heavy.sh");

function lockedEnvironment(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "heavy-runner-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lockPath = path.join(dir, "busy.lock");
  mkdirSync(`${lockPath}.d`);
  writeFileSync(path.join(`${lockPath}.d`, "owner.json"), JSON.stringify({
    pid: process.pid, host: os.hostname(), token: "test-owner",
  }));
  const env = {
    ...process.env,
    HERMES_HEAVY_LOCK: lockPath,
    HERMES_HEAVY_LOCK_IMPL: "node",
    HERMES_HEAVY_LOCK_TIMEOUT: "0",
    HERMES_HEAVY_LOCK_HELD: "",
  };
  delete env.HERMES_HEAVY_ENABLED;
  return { dir, env, lockPath };
}

test("local execution keeps the occupied-host lock by default", (t) => {
  const { env } = lockedEnvironment(t);
  const result = spawnSync(process.execPath, [wrapper, process.execPath, "-e", "console.log('must-not-run')"], {
    cwd: root, env, encoding: "utf8", timeout: 5_000,
  });
  assert.equal(result.status, 75, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /refusing to overlap/);
});

test("lock holder refuses to start without memory headroom and releases the slot", (t) => {
  const { dir, env } = lockedEnvironment(t);
  const lockPath = path.join(dir, "free.lock");
  const result = spawnSync(process.execPath, [wrapper, process.execPath, "-e", "console.log('must-not-run')"], {
    cwd: root,
    env: { ...env, HERMES_HEAVY_LOCK: lockPath, HERMES_HEAVY_MIN_FREE_MB: String(Number.MAX_SAFE_INTEGER) },
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.equal(result.status, 75, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Available memory stayed below/);
  assert.equal(existsSync(`${lockPath}.d`), false);
});

test("memory admission starts once headroom returns and gives up at the deadline", async () => {
  const samples = [10, 20, 100];
  const recovered = await waitForFreeMemory({
    minFreeBytes: 100, deadline: Date.now() + 5_000, pollMs: 1, freemem: () => samples.shift(),
  });
  assert.equal(recovered, true);
  assert.equal(await waitForFreeMemory({ minFreeBytes: 100, deadline: Date.now() + 20, pollMs: 5, freemem: () => 0 }), false);
  assert.equal(await waitForFreeMemory({ minFreeBytes: 0, deadline: 0, freemem: () => 0 }), true);
});

test("CI bypass executes without acquiring the host lock and preserves argv and exit status", (t) => {
  const { env, lockPath } = lockedEnvironment(t);
  const result = spawnSync(process.execPath, [
    wrapper, process.execPath, "-e",
    "console.log(JSON.stringify({args: process.argv.slice(1), handled: process.env.HERMES_HEAVY_LOCK_HELD})); process.exit(23)",
    "argument with spaces", 'literal "quotes"',
  ], { cwd: root, env: { ...env, HERMES_HEAVY_ENABLED: "0" }, encoding: "utf8", timeout: 5_000 });
  assert.equal(result.status, 23, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { args: ["argument with spaces", 'literal "quotes"'], handled: "1" });
  assert.equal(JSON.parse(readFileSync(path.join(`${lockPath}.d`, "owner.json"))).token, "test-owner");
});

test("CI bypass lets the nested typecheck orchestrator finish without re-entering the wrapper", (t) => {
  const { dir, env } = lockedEnvironment(t);
  const result = spawnSync(process.execPath, [path.join(root, "scripts/typecheck.mjs")], {
    cwd: root,
    env: {
      ...env,
      HERMES_HEAVY_ENABLED: "0",
      TYPECHECK_TSC_CMD: JSON.stringify([process.execPath, path.join(root, "tests/fixtures/typecheck/fake-tsc.mjs")]),
      FAKE_TSC_DIR: dir,
      FAKE_TSC_MS: "0",
      FAKE_TSC_FAIL: "",
    },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /\[typecheck\] apps\/web/);
  assert.match(result.stderr, /\[typecheck\] tsconfig\.e2e\.json/);
});

test("direct shell CI bypass skips scheduling tools", { skip: process.platform === "win32" }, (t) => {
  const { dir, env } = lockedEnvironment(t);
  const commands = path.join(dir, "commands");
  mkdirSync(commands);
  for (const command of ["flock", "nice", "ionice", "taskset"]) {
    writeFileSync(path.join(commands, command), "#!/bin/sh\necho scheduling-must-not-run >&2\nexit 98\n", { mode: 0o755 });
  }
  const result = spawnSync("bash", [shellWrapper, process.execPath, "-e", "console.log('ran'); process.exit(17)"], {
    cwd: root,
    env: { ...env, HERMES_HEAVY_ENABLED: "0", PATH: `${commands}${path.delimiter}${process.env.PATH}` },
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.equal(result.status, 17, result.stderr);
  assert.equal(result.stdout.trim(), "ran");
  assert.equal(result.stderr, "");
});
