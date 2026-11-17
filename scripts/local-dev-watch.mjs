import { watch } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { runLocalFlow } from "./local-dev-flow.mjs";

const states = ["ready", "active", "done"];
const lockName = ".codex-run.lock";
const markdown = /\.md$/i;
const card = /\.codex\.json$/i;
const message = error => error instanceof Error ? error.message : String(error);

async function legacySnapshot(dirs) {
  const files = [];
  for (const dir of dirs) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!markdown.test(entry.name)) continue;
      const file = path.join(dir, entry.name);
      try {
        const info = await lstat(file);
        if (info.isSymbolicLink()) {
          throw Object.assign(new Error("Markdown card is a link. Reconcile the original board before restarting: " + entry.name),
            { code: "legacy_symlink" });
        }
        if (info.isFile()) files.push([file, await readFile(file, "base64")]);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  return JSON.stringify(files.sort(([a], [b]) => a.localeCompare(b)));
}

export async function startLocalWatch({
  board, repoRoot = process.cwd(), parallel = 2, legacyReconciled = false,
  run = runLocalFlow, onReport = () => {},
}) {
  if (typeof board !== "string" || !board.trim()) throw new Error("--board <path> is required");
  if (!Number.isInteger(parallel) || parallel < 1 || parallel > 5) throw new Error("--parallel must be between 1 and 5");
  const root = await realpath(board);
  const dirs = states.map(state => path.join(root, state));
  for (const dir of dirs) {
    if (!(await lstat(dir)).isDirectory()) throw new Error("Expected a real board directory at " + dir);
  }
  const initialLegacy = await legacySnapshot(dirs);
  const watchers = [];
  let lockWatcher;
  let closed = false;
  let running = false;
  let pending = false;
  let finish;
  const done = new Promise(resolve => { finish = resolve; });

  function close(event) {
    if (!closed) {
      closed = true;
      for (const watcher of watchers) watcher.close();
      lockWatcher?.close();
      lockWatcher = undefined;
      if (!running) finish();
      if (event) onReport(event);
    }
    return done;
  }

  function failWatch(error) {
    const code = error?.code === "legacy_symlink" ? error.code : "watch_failed";
    close({ type: "error", code, message: message(error) });
  }

  async function checkLegacy() {
    if (closed) return false;
    try {
      if (await legacySnapshot(dirs) === initialLegacy) return !closed;
      close({ type: "error", code: "legacy_changed", message: "Markdown cards changed. Reconcile the original board before restarting." });
    } catch (error) {
      failWatch(error);
    }
    return false;
  }

  async function resumeWhenUnlocked(observer) {
    try {
      await lstat(path.join(root, lockName));
    } catch (error) {
      if (closed || lockWatcher !== observer) return;
      if (error.code !== "ENOENT") {
        failWatch(error);
        return;
      }
      observer.close();
      lockWatcher = undefined;
      wake();
    }
  }

  function waitForUnlock() {
    if (closed || lockWatcher) return;
    try {
      const observer = watch(root, (_event, filename) => {
        if (filename == null || filename.toLowerCase() === lockName) void resumeWhenUnlocked(observer);
      });
      lockWatcher = observer;
      observer.on("error", failWatch);
      void resumeWhenUnlocked(observer);
    } catch (error) {
      failWatch(error);
    }
  }

  async function wakeIfReservationReleased(dir, filename) {
    try {
      await lstat(path.join(dir, filename));
    } catch (error) {
      if (error.code === "ENOENT") wake();
      else failWatch(error);
    }
  }

  async function drain() {
    try {
      while (pending && !closed && !lockWatcher) {
        pending = false;
        if (!await checkLegacy() || closed) break;
        try {
          const report = await run({
            mode: "run", board: root, repoRoot, parallel, legacyReconciled, allowNewClaims: checkLegacy,
          });
          if (report.errors?.some(error => error.code === "board_locked")) waitForUnlock();
          onReport({ type: "run", report });
        } catch (error) {
          onReport({ type: "error", code: "run_failed", message: message(error) });
        }
      }
    } finally {
      running = false;
      if (closed) finish();
    }
  }

  function wake() {
    if (closed) return;
    pending = true;
    if (!running && !lockWatcher) {
      running = true;
      void drain();
    }
  }

  try {
    for (const [index, dir] of dirs.entries()) {
      const watcher = watch(dir, (event, filename) => {
        if (closed) return;
        if (filename == null || markdown.test(filename)) void checkLegacy();
        if (filename == null || (states[index] !== "active" && card.test(filename))) wake();
        if (states[index] === "active" && event === "rename" && filename != null && card.test(filename)) {
          void wakeIfReservationReleased(dir, filename);
        }
      });
      watchers.push(watcher);
      watcher.on("error", error => {
        failWatch(error);
      });
    }
  } catch (error) {
    close();
    throw error;
  }

  wake();
  return { close, done };
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      board: { type: "string" },
      parallel: { type: "string", default: "2" },
      "legacy-reconciled": { type: "boolean", default: false },
    },
  });
  const controller = await startLocalWatch({
    board: values.board, parallel: Number(values.parallel), legacyReconciled: values["legacy-reconciled"],
    onReport: event => {
      console.log(JSON.stringify(event));
      if (event.type === "error" || event.report?.errors?.length
          || event.report?.results?.some(result => result.status === "blocked")) process.exitCode = 1;
    },
  });
  const stop = () => { void controller.close(); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    await controller.done;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    await main();
  } catch (error) {
    const code = error?.code === "legacy_symlink" ? error.code : "watch_start_failed";
    console.log(JSON.stringify({ type: "error", code, message: message(error) }));
    process.exitCode = 1;
  }
}
