#!/usr/bin/env node
// Cross-platform entry for heavy validation tasks.
// POSIX: delegate to run-heavy.sh (flock + nice/ionice/taskset).
// Windows (or HERMES_HEAVY_LOCK_IMPL=node): serialize with the portable directory lock in
// heavy-lock.mjs, then run the command. That lock does not exclude flock holders, so
// callers on one POSIX host share a slot only if they all use the same implementation.
// The lock holder then waits, within the same timeout, for HERMES_HEAVY_MIN_FREE_MB
// (default 1024; 0 disables) of available memory before starting the command.
// HERMES_HEAVY_ENABLED=0 skips local host controls, for isolated CI runners.
// In both cases the wrapper forwards SIGINT/SIGTERM/SIGHUP to the whole child tree
// and releases the slot when the child exits.
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { acquireHeavyLock, defaultLockPath } from "./heavy-lock.mjs";

export function windowsCommand(args) {
  // `bash -c "a && b"` chains run as one cmd.exe line, which also understands `&&`.
  if (args[0] === "bash" && args[1] === "-c" && args.length === 3) return args[2];
  return args.map((arg) => (/[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg)).join(" ");
}

/** Kill a child and its descendants. POSIX children run in their own process group. */
export function killTree(child, signal = "SIGTERM") {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* gone */ } }
}

/**
 * Starting a heavy task on a nearly exhausted host pushes it, and every other session,
 * into the page file, so the lock holder waits for headroom before spawning.
 */
export async function waitForFreeMemory({ minFreeBytes, deadline, pollMs = 1000, freemem = os.freemem }) {
  for (let first = true; ; first = false) {
    const enough = freemem() >= minFreeBytes;
    const remaining = deadline - Date.now();
    if (enough && (first || remaining >= 0)) return true;
    if (remaining <= 0) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remaining)));
  }
}

function nonNegativeEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    console.error(`${name} must be a non-negative number, got "${raw}".`);
    process.exit(64);
  }
  return value;
}

const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

async function run() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("usage: node scripts/run-heavy.mjs <command> [args...]");
    process.exit(64);
  }
  const enabled = process.env.HERMES_HEAVY_ENABLED !== "0";
  const useNodeLock = enabled && (process.platform === "win32" || process.env.HERMES_HEAVY_LOCK_IMPL === "node");
  let release = () => {};
  const env = { ...process.env };
  // Nested orchestrators (notably typecheck.mjs) must not re-enter this wrapper
  // even when there is intentionally no lock to acquire in CI.
  if (!enabled) env.HERMES_HEAVY_LOCK_HELD = "1";
  if (useNodeLock && process.env.HERMES_HEAVY_LOCK_HELD !== "1") {
    const timeoutSeconds = nonNegativeEnv("HERMES_HEAVY_LOCK_TIMEOUT", 120);
    const minFreeMb = nonNegativeEnv("HERMES_HEAVY_MIN_FREE_MB", 1024);
    const deadline = Date.now() + timeoutSeconds * 1000;
    try {
      release = await acquireHeavyLock({ lockPath: defaultLockPath(), timeoutMs: deadline - Date.now() });
    } catch (error) {
      if (error.code === "ELOCKTIMEOUT") {
        console.error("Another project validation task is running; refusing to overlap.");
        process.exit(75);
      }
      throw error;
    }
    if (!(await waitForFreeMemory({ minFreeBytes: minFreeMb * 1024 * 1024, deadline }))) {
      console.error(`Available memory stayed below ${minFreeMb} MB; refusing to start a heavy task.`);
      release();
      process.exit(75);
    }
    env.HERMES_HEAVY_LOCK_HELD = "1";
  }
  const detached = process.platform !== "win32";
  let child;
  if (enabled && !useNodeLock) {
    child = spawn("bash", [fileURLToPath(new URL("./run-heavy.sh", import.meta.url)), ...args], { stdio: "inherit", env, detached });
  } else if (process.platform === "win32" && args[0] !== process.execPath) {
    child = spawn(windowsCommand(args), { stdio: "inherit", shell: true, env });
  } else {
    child = spawn(args[0], args.slice(1), { stdio: "inherit", env, detached });
  }
  let forwarded = null;
  for (const signal of Object.keys(SIGNAL_EXIT)) {
    process.on(signal, () => { forwarded = signal; killTree(child, signal); });
  }
  child.on("error", (error) => {
    console.error(`[heavy-task] failed to start: ${error.message}`);
    release();
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    release();
    if (forwarded) process.exit(SIGNAL_EXIT[forwarded]);
    if (signal) process.exit(SIGNAL_EXIT[signal] ?? 1);
    process.exit(code ?? 1);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run().catch((error) => { console.error(error); process.exit(1); });
}
