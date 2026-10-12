#!/usr/bin/env node
// Cross-platform entry for heavy validation tasks.
// POSIX: delegate to run-heavy.sh (flock + nice/ionice/taskset) unchanged.
// Windows: no bash/flock/nice; run the command directly through the npm shell.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export function windowsCommand(args) {
  // `bash -c "a && b"` chains run as one cmd.exe line, which also understands `&&`.
  if (args[0] === "bash" && args[1] === "-c" && args.length === 3) return args[2];
  return args.map((arg) => (/[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg)).join(" ");
}

function run() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("usage: node scripts/run-heavy.mjs <command> [args...]");
    process.exit(64);
  }
  const child = process.platform === "win32"
    ? spawn(windowsCommand(args), { stdio: "inherit", shell: true })
    : spawn("bash", [fileURLToPath(new URL("./run-heavy.sh", import.meta.url)), ...args], { stdio: "inherit" });
  child.on("error", (error) => {
    console.error(`[heavy-task] failed to start: ${error.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) run();
