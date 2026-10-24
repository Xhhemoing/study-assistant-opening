#!/usr/bin/env node
/**
 * Single typecheck orchestration entry (Windows + Linux).
 *
 * Check set is derived from configuration only, identically on every platform:
 *   - every workspace (root package.json "workspaces" globs, in glob order then name)
 *     whose package.json defines a "typecheck" script -> `tsc -p tsconfig.json --noEmit`
 *     by default; workspace "aistudy.typecheck": { projects: [...] }
 *     selects multiple projects, each checked with `tsc -p <project> --noEmit`;
 *     run with cwd = that workspace;
 *   - plus root-level projects listed in package.json "aistudy.typecheck.extraProjects"
 *     (path strings). Missing configs fail closed.
 *
 * Resource policy: the orchestrator takes the heavy-task slot ONCE (by re-executing
 * itself through scripts/run-heavy.mjs unless HERMES_HEAVY_LOCK_HELD=1) and then runs
 * tsc children directly (never through run-heavy again, so the non-reentrant lock is
 * never requested twice). Children run serially by default (--jobs 1) or with bounded
 * concurrency (--jobs N). On the first failure the remaining children are killed and
 * the original non-zero exit code is returned. SIGINT/SIGTERM/SIGHUP and --timeout-ms
 * kill every child tree before exiting (130/143/129, timeout 124).
 *
 * Usage: node scripts/typecheck.mjs [--list] [--jobs N] [--timeout-ms MS]
 *        env: TYPECHECK_JOBS, TYPECHECK_TIMEOUT_MS
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { killTree } from "./run-heavy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

function expandWorkspaceGlob(rootDir, pattern) {
  const parts = pattern.split("/");
  if (parts.length !== 2 || parts[1] !== "*") return existsSync(path.join(rootDir, pattern)) ? [pattern] : [];
  const base = path.join(rootDir, parts[0]);
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => `${parts[0]}/${name}`);
}

/** Derived check set; paths are POSIX-style relative to the repo root. */
export function deriveTypecheckSet(rootDir = root) {
  const pkg = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));
  const set = [];
  for (const pattern of pkg.workspaces ?? []) {
    for (const dir of expandWorkspaceGlob(rootDir, pattern)) {
      const manifest = path.join(rootDir, dir, "package.json");
      if (!existsSync(manifest)) continue;
      const workspace = JSON.parse(readFileSync(manifest, "utf8"));
      if (workspace.scripts?.typecheck) {
        const config = workspace.aistudy?.typecheck;
        const projects = config === undefined ? ["tsconfig.json"] : config.projects;
        if (!Array.isArray(projects) || projects.length === 0 || projects.some((project) => typeof project !== "string" || !project)) {
          throw new Error(`invalid typecheck projects in ${dir}`);
        }
        for (const project of projects) {
          if (!existsSync(path.join(rootDir, dir, project))) throw new Error(`missing typecheck project: ${dir}/${project}`);
          set.push({ name: projects.length === 1 ? dir : `${dir}/${project}`, cwd: dir, project });
        }
      }
    }
  }
  for (const project of pkg.aistudy?.typecheck?.extraProjects ?? []) {
    if (typeof project !== "string" || !project) throw new Error("invalid extra typecheck project");
    if (!existsSync(path.join(rootDir, project))) throw new Error(`missing typecheck project: ${project}`);
    set.push({ name: project, cwd: ".", project });
  }
  return set;
}

function parseArgs(argv) {
  const opts = {
    list: false,
    jobs: Number(process.env.TYPECHECK_JOBS ?? 1),
    timeoutMs: Number(process.env.TYPECHECK_TIMEOUT_MS ?? 0),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--list") opts.list = true;
    else if (arg === "--jobs") opts.jobs = Number(argv[++i]);
    else if (arg === "--timeout-ms") opts.timeoutMs = Number(argv[++i]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(opts.jobs) || opts.jobs < 1) throw new Error("--jobs must be a positive integer");
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs < 0) throw new Error("--timeout-ms must be >= 0");
  return opts;
}

export function tscArgs(task) {
  // Project mode checks versions of imported non-root sources in warm caches too.
  return ["-p", task.project, "--noEmit"];
}

function tscCommand(task) {
  // Override via TYPECHECK_TSC_CMD (JSON array) is for tests only.
  if (process.env.TYPECHECK_TSC_CMD) return [...JSON.parse(process.env.TYPECHECK_TSC_CMD), task.name];
  const tsc = createRequire(path.join(root, "package.json")).resolve("typescript/bin/tsc");
  return [process.execPath, tsc, ...tscArgs(task)];
}

export async function runTypecheck(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const tasks = deriveTypecheckSet();
  if (opts.list) {
    for (const task of tasks) console.log(`${task.cwd}\t${task.project}`);
    return 0;
  }
  const running = new Set();
  let next = 0;
  let finished = 0;
  let result = null;
  let timer = null;

  return await new Promise((resolve) => {
    const stopAll = (code, signal = "SIGTERM") => {
      if (result !== null) return;
      result = code;
      if (timer) clearTimeout(timer);
      for (const child of running) killTree(child, signal);
      if (running.size === 0) resolve(result);
    };
    for (const signal of Object.keys(SIGNAL_EXIT)) process.on(signal, () => stopAll(SIGNAL_EXIT[signal], signal));
    if (opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        console.error(`[typecheck] timeout after ${opts.timeoutMs} ms; stopping`);
        stopAll(124);
      }, opts.timeoutMs);
    }
    const launch = () => {
      while (result === null && running.size < opts.jobs && next < tasks.length) {
        const task = tasks[next++];
        const [cmd, ...args] = tscCommand(task);
        console.error(`[typecheck] ${task.name}`);
        const child = spawn(cmd, args, {
          cwd: path.join(root, task.cwd),
          stdio: "inherit",
          detached: process.platform !== "win32",
        });
        running.add(child);
        child.on("error", (error) => {
          console.error(`[typecheck] ${task.name}: failed to start: ${error.message}`);
        });
        child.on("close", (code, signal) => {
          running.delete(child);
          finished += 1;
          if (result === null && (code !== 0 || signal)) {
            console.error(`[typecheck] FAILED ${task.name} (exit ${code ?? signal})`);
            stopAll(code ?? 1);
          }
          if (result !== null) {
            if (running.size === 0) resolve(result);
            return;
          }
          if (finished === tasks.length) {
            if (timer) clearTimeout(timer);
            resolve(0);
            return;
          }
          launch();
        });
      }
    };
    if (tasks.length === 0) resolve(0);
    else launch();
  });
}

async function main() {
  const argv = process.argv.slice(2);
  if (process.env.HERMES_HEAVY_LOCK_HELD !== "1" && !argv.includes("--list")) {
    // Take the heavy-task slot once, at the outermost layer.
    const child = spawn(process.execPath, [path.join(root, "scripts/run-heavy.mjs"), process.execPath, fileURLToPath(import.meta.url), ...argv], { stdio: "inherit" });
    for (const signal of Object.keys(SIGNAL_EXIT)) process.on(signal, () => child.kill(signal));
    child.on("exit", (code, signal) => process.exit(code ?? SIGNAL_EXIT[signal] ?? 1));
    return;
  }
  process.exit(await runTypecheck(argv));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`[typecheck] ${error.message}`); process.exit(2); });
}
