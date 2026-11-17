import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { freemem } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";

const cardSuffix = ".codex.json";
const states = ["ready", "active", "done"];
const maxWriters = 5;
const mib = 1024 * 1024;
const minimumFreeMemory = 500 * mib;
const runFile = promisify(execFile);
const gitEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
for (const name of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete gitEnv[name];

async function git(cwd, ...args) {
  const { stdout } = await runFile("git", ["--no-optional-locks", ...args], {
    cwd, env: gitEnv, windowsHide: true, timeout: 30_000, maxBuffer: 16 * mib,
  });
  return stdout;
}

const key = value => value.toLowerCase().replaceAll("\\", "/");
const pathKey = value => key(path.resolve(value));
const allowedPathKey = value => key(value).replace(/\/$/, "");
const overlap = (a, b) => a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
const string = value => typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
const errorMessage = error => error instanceof Error ? error.message : String(error);
const validId = value => string(value) && /^[a-z0-9][a-z0-9._-]{0,95}$/i.test(value) && !value.endsWith(".");

const validSha = value => typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);

function safeRelative(value) {
  if (!string(value)) return false;
  return allowedPathKey(value).split("/").every(segment =>
    segment && segment !== "." && segment !== ".." && segment !== ".git"
    && ![...segment].some(char => char.charCodeAt(0) < 0x20 || '<>:"|?*'.includes(char)) && !/[. ]$/.test(segment)
    && !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/.test(segment));
}

function parseCard(source, filenameId) {
  const card = JSON.parse(source.replace(/^\uFEFF/, ""));
  if (!validId(card?.id) || key(card.id) !== key(filenameId)) throw new Error("Card id must match the filename");
  if (!string(card.goal) || !string(card.owner) || !["L", "H"].includes(card.risk)) {
    throw new Error("Card requires a goal, owner and risk L or H");
  }
  if (!string(card.worktree) || !path.isAbsolute(card.worktree)) throw new Error("Card requires an absolute worktree path");
  if (!validSha(card.base)) {
    throw new Error("Card requires a full Git baseline SHA");
  }
  if (!Array.isArray(card.parents) || !card.parents.every(parent => validId(parent) && key(parent) !== key(card.id))) {
    throw new Error("Card parents must be other card IDs");
  }
  if (!Array.isArray(card.allowedPaths) || !card.allowedPaths.length || !card.allowedPaths.every(safeRelative)) {
    throw new Error("Card allowedPaths must be safe repository-relative paths");
  }
  if (!Array.isArray(card.checks) || !card.checks.every(args =>
    Array.isArray(args) && string(args[0]) && args.every(arg => typeof arg === "string" && !arg.includes("\0")))) {
    throw new Error("Card checks must be arrays of Node arguments");
  }
  return card;
}

async function boardDirectories(board) {
  const root = await realpath(board);
  const dirs = { root };
  for (const state of states) {
    const dir = path.join(root, state);
    if (!(await lstat(dir)).isDirectory()) throw new Error("Expected a real board directory at " + dir);
    dirs[state] = dir;
  }
  return dirs;
}

async function readCards(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const legacy = new Set();
  const cards = [];
  for (const entry of entries) {
    const suffix = entry.name.toLowerCase();
    if (suffix.endsWith(".md") && (entry.isFile() || entry.isSymbolicLink())) legacy.add(key(entry.name.slice(0, -3)));
    if (!suffix.endsWith(cardSuffix)) continue;
    const id = entry.name.slice(0, -cardSuffix.length);
    const file = path.join(dir, entry.name);
    try {
      if (!entry.isFile()) throw new Error("Structured card must be a regular file");
      const source = await readFile(file, "utf8");
      const card = parseCard(source, id);
      cards.push({ id, file, source, card, paths: card.allowedPaths.map(allowedPathKey) });
    } catch (error) {
      cards.push({ id, file, invalid: error.message });
    }
  }
  return { cards: cards.sort((a, b) => a.id.localeCompare(b.id)), legacy };
}

async function gitIdentity(cwd) {
  const value = await git(cwd, "rev-parse", "--path-format=absolute", "--show-toplevel", "--absolute-git-dir",
    "--git-common-dir", "HEAD");
  const [root, gitDir, commonDir, head] = value.trimEnd().split(/\r?\n/);
  return { root: await realpath(root), gitDir: await realpath(gitDir), commonDir: await realpath(commonDir), head };
}

async function inspectWorktree(worktree, baseline, repo, registered) {
  const root = await realpath(worktree);
  if (pathKey(root) === pathKey(repo.root) || !registered.has(pathKey(root))) {
    throw new Error("Worktree must be a registered linked worktree outside the dispatch checkout");
  }
  const candidate = await gitIdentity(root);
  if (pathKey(candidate.root) !== pathKey(root) || pathKey(candidate.commonDir) !== pathKey(repo.commonDir)
      || pathKey(candidate.gitDir) === pathKey(candidate.commonDir)) {
    throw new Error("Worktree must be a linked root of the dispatch repository");
  }
  if (key(candidate.head) !== key(baseline)) throw new Error("Worktree HEAD differs from the exact card baseline");
  const dirty = await git(root, "status", "--porcelain=v1", "--untracked-files=all");
  if (dirty.length > 0) throw new Error("Worktree is dirty");
  return root;
}

async function worktreeKey(worktree) {
  try {
    return pathKey(await realpath(worktree));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return pathKey(worktree);
  }
}

async function unmetParents(card, completed, repoRoot) {
  const missing = card.parents.filter(parent => !completed.has(key(parent)));
  if (missing.length) return { reason: "parents_pending", parents: missing };

  const absent = [];
  const unverified = [];
  for (const parent of card.parents) {
    const commit = completed.get(key(parent)).result?.commit;
    if (!validSha(commit)) {
      unverified.push(parent);
      continue;
    }
    try {
      await git(repoRoot, "merge-base", "--is-ancestor", commit, card.base);
    } catch (error) {
      (error.code === 1 ? absent : unverified).push(parent);
    }
  }
  if (unverified.length) return { reason: "parent_commit_unverified", parents: unverified };
  if (absent.length) return { reason: "parents_not_in_base", parents: absent };
  return null;
}

async function planWave({ dirs, repo, parallel, availableBytes, attempted, legacyReconciled }) {
  const [ready, active, done] = await Promise.all(states.map(state => readCards(dirs[state])));
  const deferred = [];
  const selected = [];
  const legacyActive = [...active.legacy].sort();
  const errors = active.cards.filter(entry => entry.invalid).map(entry => ({
    id: entry.id, code: "invalid_active_card", message: entry.invalid,
  }));
  if (errors.length > 0) return { selected, deferred, errors, legacyActive };

  const reservations = await Promise.all(active.cards.map(async entry => ({
    ...entry, treeKey: await worktreeKey(entry.card.worktree),
  })));
  const activeIds = new Set(active.cards.map(entry => key(entry.id)));
  const completed = new Map(done.cards
    .filter(entry => entry.card?.status === "candidate_ready" && !activeIds.has(key(entry.id)))
    .map(entry => [key(entry.id), entry.card]));
  const known = new Set([...ready.legacy, ...active.legacy, ...done.legacy, ...active.cards.map(entry => key(entry.id)),
    ...done.cards.map(entry => key(entry.id))]);
  const duplicateReady = new Set(ready.cards.filter((entry, index) =>
    ready.cards.findIndex(other => key(other.id) === key(entry.id)) !== index).map(entry => key(entry.id)));
  const occupied = active.cards.filter(entry => entry.card.status !== "blocked").length;
  const capacity = Math.max(0, parallel - occupied);
  const listings = await git(repo.root, "worktree", "list", "--porcelain", "-z");
  const registered = new Set(listings.split("\0").filter(line => line.startsWith("worktree "))
    .map(line => pathKey(line.slice("worktree ".length))));

  for (const entry of ready.cards) {
    const { id, card } = entry;
    const identity = key(id);
    if (entry.invalid) {
      deferred.push({ id, reason: "invalid_card", message: entry.invalid });
      continue;
    }
    if (known.has(identity) || duplicateReady.has(identity)) {
      deferred.push({ id, reason: "existing_card" });
      continue;
    }
    if (attempted.has(identity)) {
      deferred.push({ id, reason: "attempted_in_this_run" });
      continue;
    }
    if (legacyActive.length > 0 && !legacyReconciled) {
      deferred.push({ id, reason: "legacy_active_unreconciled" });
      continue;
    }
    const parents = await unmetParents(card, completed, repo.root);
    if (parents) {
      deferred.push({ id, ...parents });
      continue;
    }
    if (availableBytes < minimumFreeMemory) {
      deferred.push({ id, reason: "low_memory" });
      continue;
    }

    try {
      const treeKey = await worktreeKey(card.worktree);
      const claims = reservations.concat(selected);
      const sameTree = claims.find(other => overlap(treeKey, other.treeKey));
      const samePaths = claims.find(other => entry.paths.some(left => other.paths.some(right => overlap(left, right))));
      if (sameTree || samePaths) {
        deferred.push({ id, reason: sameTree ? "overlapping_worktree" : "overlapping_paths",
          conflictsWith: (sameTree ?? samePaths).id });
      } else if (selected.length >= capacity) {
        deferred.push({ id, reason: "writer_limit" });
      } else {
        const worktree = await inspectWorktree(card.worktree, card.base, repo, registered);
        selected.push({ ...entry, treeKey: pathKey(worktree), worktree });
      }
    } catch (error) {
      deferred.push({ id, reason: "invalid_worktree", message: errorMessage(error) });
    }
  }
  return { selected, deferred, errors, legacyActive, registered };
}

async function requireUnused(file) {
  try {
    await lstat(file);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new Error("Card already exists at " + file);
}

async function replaceOwnedCard(file, expectedSource, contents) {
  const temporary = file + "." + randomUUID() + ".tmp";
  const updated = JSON.stringify(contents, null, 2) + "\n";
  let result = null;
  let completed = false;
  try {
    await writeFile(temporary, updated, { encoding: "utf8", flag: "wx" });
    if (await readFile(file, "utf8") === expectedSource) {
      await rename(temporary, file);
      result = updated;
    }
    completed = true;
  } finally {
    if (!completed) await unlink(temporary).catch(() => {});
  }
  await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
  return result;
}

function changedActiveCard(id, phase, workerResult) {
  return {
    id, status: "blocked", phase, message: "Active card changed after the original claim",
    ...(workerResult && { workerResult }),
  };
}

async function runEntry(entry, dirs, repo, registered, execute, allowNewClaims) {
  const filename = path.basename(entry.file);
  const activeFile = path.join(dirs.active, filename);
  const doneFile = path.join(dirs.done, filename);
  const { id, card } = entry;
  try {
    await requireUnused(activeFile);
    if (!await allowNewClaims()) return { id, status: "deferred", reason: "claims_paused" };
    await rename(entry.file, activeFile);
  } catch (error) {
    return { id, status: "blocked", phase: "claim", message: errorMessage(error) };
  }

  const claimedCard = { ...card, status: "active", claimedAt: new Date().toISOString() };
  let expectedSource = entry.source;
  let result;
  let phase = "claim";
  try {
    const worktree = await inspectWorktree(card.worktree, card.base, repo, registered);
    if (pathKey(worktree) !== entry.treeKey) throw new Error("Worktree changed after planning");
    const written = await replaceOwnedCard(activeFile, expectedSource, claimedCard);
    if (written === null) return changedActiveCard(id, phase);
    expectedSource = written;
    phase = "worker";
    const value = await execute({ ...card, worktree }, repo.root);
    if (!["candidate_ready", "blocked"].includes(value?.status)) throw new Error("Worker returned an invalid result");
    result = { ...value, id };
  } catch (error) {
    result = { id, status: "blocked", phase, message: errorMessage(error) };
  }

  try {
    if (result.status === "candidate_ready") await requireUnused(doneFile);
    const written = await replaceOwnedCard(activeFile, expectedSource, { ...claimedCard, status: result.status, result });
    if (written === null) return changedActiveCard(id, "writeback", result);
    expectedSource = written;
    if (result.status === "candidate_ready") {
      if (await readFile(activeFile, "utf8") !== expectedSource) return changedActiveCard(id, "writeback", result);
      await requireUnused(doneFile);
      await rename(activeFile, doneFile);
    }
  } catch (error) {
    result = { id, status: "blocked", phase: "writeback", message: errorMessage(error), workerStatus: result.status };
    try {
      const written = await replaceOwnedCard(activeFile, expectedSource, { ...claimedCard, status: "blocked", result });
      if (written === null) result.writebackError = "Active card changed after the original claim";
    } catch (writebackError) {
      result.writebackError = errorMessage(writebackError);
    }
  }
  return result;
}

async function defaultExecute(card, repoRoot) {
  const { runLocalCard } = await import("./local-dev-worker.mjs");
  return runLocalCard(card, repoRoot);
}

function emptyReport(mode, board, parallel) {
  return { mode, board, parallel, availableMiB: null, legacyActive: [], selected: [], deferred: [], results: [], errors: [] };
}

export async function runLocalFlow({
  mode = "run", board, repoRoot = process.cwd(), parallel = 2, legacyReconciled = false,
  execute = defaultExecute, availableMemory = freemem, allowNewClaims = () => true,
}) {
  const report = emptyReport(mode, board, parallel);
  let lock;
  try {
    if (!["plan", "run"].includes(mode) || !string(board)) throw new Error("Expected plan or run and --board <path>");
    if (!Number.isInteger(parallel) || parallel < 1 || parallel > maxWriters) {
      throw new Error("--parallel must be an integer between 1 and " + maxWriters);
    }
    const dirs = await boardDirectories(board);
    report.board = dirs.root;
    if (mode === "run") {
      const lockPath = path.join(dirs.root, ".codex-run.lock");
      try {
        await mkdir(lockPath);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        report.errors.push({ code: "board_locked", message: "Another run holds " + lockPath });
        return report;
      }
      lock = {
        dir: lockPath, ownerFile: path.join(lockPath, "owner.json"),
        source: JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + "\n",
      };
      await writeFile(lock.ownerFile, lock.source, { encoding: "utf8", flag: "wx" });
      lock.written = true;
    }

    const repo = await gitIdentity(repoRoot);
    const attempted = new Set();
    for (;;) {
      const availableBytes = availableMemory();
      report.availableMiB = Math.floor(availableBytes / mib);
      const wave = await planWave({ dirs, repo, parallel, availableBytes, attempted, legacyReconciled });
      report.legacyActive = wave.legacyActive;
      report.deferred = wave.deferred;
      report.errors.push(...wave.errors);
      const selectedIds = wave.selected.map(entry => entry.id);
      if (mode === "plan") {
        report.selected = selectedIds;
        break;
      }
      if (wave.selected.length === 0 || wave.errors.length > 0) break;
      const admittedBytes = availableMemory();
      report.availableMiB = Math.floor(admittedBytes / mib);
      if (admittedBytes < minimumFreeMemory) {
        report.deferred.push(...selectedIds.map(id => ({ id, reason: "low_memory" })));
        break;
      }
      if (!await allowNewClaims()) {
        report.deferred.push(...selectedIds.map(id => ({ id, reason: "claims_paused" })));
        break;
      }
      for (const id of selectedIds) attempted.add(key(id));
      const outcomes = await Promise.allSettled(wave.selected.map(entry =>
        runEntry(entry, dirs, repo, wave.registered, execute, allowNewClaims)));
      let paused = false;
      for (const [index, outcome] of outcomes.entries()) {
        const id = selectedIds[index];
        if (outcome.status === "fulfilled" && outcome.value.status === "deferred") {
          report.deferred.push({ id, reason: outcome.value.reason });
          paused = true;
        } else {
          report.selected.push(id);
          if (outcome.status === "fulfilled") {
            report.results.push(outcome.value);
          } else {
            report.errors.push({ id, code: "worker_lifecycle_error", message: errorMessage(outcome.reason) });
          }
        }
      }
      if (paused) break;
    }
  } catch (error) {
    report.errors.push({ code: "flow_error", message: errorMessage(error) });
  } finally {
    if (lock) {
      try {
        if (lock.written && await readFile(lock.ownerFile, "utf8") !== lock.source) {
          report.errors.push({ code: "lock_cleanup_failed", message: "Lock owner record changed" });
        } else {
          if (lock.written) await unlink(lock.ownerFile);
          await rmdir(lock.dir);
        }
      } catch (error) {
        report.errors.push({ code: "lock_cleanup_failed", message: errorMessage(error) });
      }
    }
  }
  return report;
}

async function main() {
  let report;
  try {
    const { positionals, values } = parseArgs({
      args: process.argv.slice(2), allowPositionals: true,
      options: {
        board: { type: "string" },
        parallel: { type: "string", default: "2" },
        "legacy-reconciled": { type: "boolean", default: false },
      },
    });
    if (positionals.length !== 1) throw new Error("Usage: node scripts/local-dev-flow.mjs plan|run --board <path> [--parallel <n>] [--legacy-reconciled]");
    report = await runLocalFlow({
      mode: positionals[0], board: values.board, parallel: Number(values.parallel),
      legacyReconciled: values["legacy-reconciled"],
    });
  } catch (error) {
    report = emptyReport(null, null, null);
    report.errors.push({ code: "invalid_arguments", message: errorMessage(error) });
  }
  console.log(JSON.stringify(report, null, 2));
  if (report.errors.length || report.results.some(item => item.status === "blocked")) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
