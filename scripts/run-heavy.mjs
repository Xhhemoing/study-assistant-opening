#!/usr/bin/env node
// Cross-platform entry for heavy validation tasks.
// POSIX: delegate to run-heavy.sh (flock + nice/ionice/taskset) unchanged.
// Windows (or HERMES_HEAVY_LOCK_IMPL=node): take the same machine-wide slot with the
// portable directory lock in heavy-lock.mjs, then run the command.
// In both cases the wrapper forwards SIGINT/SIGTERM/SIGHUP to the whole child tree
// and releases the slot when the child exits.
import { spawn, spawnSync } from "node:child_process";
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

const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

async function run() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("usage: node scripts/run-heavy.mjs <command> [args...]");
    process.exit(64);
  }
  const useNodeLock = process.platform === "win32" || process.env.HERMES_HEAVY_LOCK_IMPL === "node";
  let release = () => {};
  const env = { ...process.env };
  if (useNodeLock && process.env.HERMES_HEAVY_LOCK_HELD !== "1") {
    try {
      release = await acquireHeavyLock({
        lockPath: defaultLockPath(),
        timeoutMs: Number(process.env.HERMES_HEAVY_LOCK_TIMEOUT ?? 120) * 1000,
      });
    } catch (error) {
      if (error.code === "ELOCKTIMEOUT") {
        console.error("Another project validation task is running; refusing to overlap.");
        process.exit(75);
      }
      throw error;
    }
    env.HERMES_HEAVY_LOCK_HELD = "1";
  }
  const detached = process.platform !== "win32";
  let child;
  if (!useNodeLock) {
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
