import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../scripts/local-dev-flow.mjs", import.meta.url));
const memory = () => 1024 * 1024 * 1024;

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
}

async function fixture(t, names) {
  const root = await mkdtemp(path.join(tmpdir(), "local-dev-flow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  const board = path.join(root, "board");
  await mkdir(repo);
  await Promise.all(["ready", "active", "done"].map(status => mkdir(path.join(board, status), { recursive: true })));
  git(repo, "init", "--quiet");
  git(repo, "-c", "user.name=Dev Flow Fixture", "-c", "user.email=fixture@example.invalid",
    "commit", "--quiet", "--allow-empty", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");
  const trees = {};
  for (const name of names) {
    trees[name] = path.join(root, "tree-" + name);
    git(repo, "worktree", "add", "--quiet", "--detach", trees[name], base);
  }

  function card(id, fields = {}) {
    return {
      id, goal: "Isolated test for " + id, owner: "original-owner", risk: "H",
      worktree: trees[id], base, parents: [], allowedPaths: ["src/" + id + ".js"],
      checks: [["--test", "src/" + id + ".test.js"]], ...fields,
    };
  }

  async function put(id, fields, state = "ready") {
    await writeFile(path.join(board, state, id + ".codex.json"), JSON.stringify(card(id, fields)), "utf8");
  }

  async function get(id, state) {
    return JSON.parse(await readFile(path.join(board, state, id + ".codex.json"), "utf8"));
  }

  async function flow(options = {}) {
    const { runLocalFlow } = await import("../../scripts/local-dev-flow.mjs");
    return runLocalFlow({ board, repoRoot: repo, availableMemory: memory, ...options });
  }

  return { root, board, repo, trees, base, put, get, flow };
}

test("plan respects Windows path boundaries and leaves legacy Markdown untouched", async (t) => {
  const f = await fixture(t, ["a", "b", "c"]);
  await f.put("a", { allowedPaths: ["Src\\UI/"] });
  await f.put("b", { allowedPaths: ["src/ui/panel.js"] });
  await f.put("c", { allowedPaths: ["src/ui-next/panel.js"] });
  const legacy = path.join(f.board, "ready", "existing-task.md");
  await writeFile(legacy, "Existing manual card", "utf8");
  const plan = await f.flow({ mode: "plan", execute: () => assert.fail("plan must not execute a card") });
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.selected, ["a", "c"]);
  assert.ok(plan.deferred.some(entry => entry.id === "b" && entry.reason === "overlapping_paths"));
  assert.deepEqual(await readdir(path.join(f.board, "active")), []);
  assert.equal(await readFile(legacy, "utf8"), "Existing manual card");
});

test("runs independent cards in parallel, then unlocks only a successful parent's children", async (t) => {
  const f = await fixture(t, ["a", "b", "c", "d"]);
  await f.put("a");
  await f.put("b");
  await f.put("c", { parents: ["a"] });
  await f.put("d", { parents: ["b"] });
  const running = new Set();
  let releaseFirstWave;
  const firstWave = new Promise(resolve => { releaseFirstWave = resolve; });
  const starts = [];
  const result = await f.flow({
    execute: async card => {
      starts.push(card.id);
      assert.equal((await f.get(card.id, "active")).owner, "original-owner");
      if (["a", "b"].includes(card.id)) {
        running.add(card.id);
        if (running.size === 2) releaseFirstWave();
        await firstWave;
      }
      if (card.id === "b") throw new Error("targeted check failed");
      if (card.id === "c") assert.equal((await f.get("a", "done")).status, "candidate_ready");
      return { status: "candidate_ready", evidence: card.id, commit: f.base };
    },
  });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(starts.slice(0, 2).sort(), ["a", "b"]);
  assert.equal(starts[2], "c");
  assert.ok(result.deferred.some(entry => entry.id === "d" && entry.reason === "parents_pending"));
  const blocked = await f.get("b", "active");
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.owner, "original-owner");
  assert.match(blocked.result.message, /targeted check failed/);
  assert.equal((await f.get("c", "done")).result.evidence, "c");
  const next = await f.flow({ execute: () => assert.fail("blocked cards must never be reclaimed") });
  assert.deepEqual(next.selected, []);
});

test("atomic board lock rejects a second dispatcher while the original run is in flight", async (t) => {
  const f = await fixture(t, ["a"]);
  await f.put("a");
  let entered;
  let release;
  const started = new Promise(resolve => { entered = resolve; });
  const finish = new Promise(resolve => { release = resolve; });
  const first = f.flow({ execute: async () => {
    entered();
    await finish;
    return { status: "candidate_ready" };
  } });
  await started;
  try {
    const lockPath = path.join(f.board, ".codex-run.lock", "owner.json");
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    assert.equal(lock.pid, process.pid);
    assert.ok(Number.isFinite(Date.parse(lock.startedAt)));
    const second = await f.flow({ execute: () => assert.fail("second dispatcher acquired board") });
    assert.ok(second.errors.some(error => error.code === "board_locked"));
    assert.deepEqual(second.selected, []);
  } finally {
    release();
  }
  assert.deepEqual((await first).errors, []);
});

test("blocked active cards reserve their worktree and paths without consuming a writer slot", async (t) => {
  const f = await fixture(t, ["a", "b", "c", "d"]);
  await f.put("a", { allowedPaths: ["src/shared"], status: "blocked" }, "active");
  await f.put("b", { allowedPaths: ["SRC/shared/dependency.js"] });
  await f.put("c", { worktree: f.trees.a });
  await f.put("d");
  const result = await f.flow({ mode: "plan", parallel: 1 });
  assert.deepEqual(result.selected, ["d"]);
  assert.ok(result.deferred.some(entry => entry.id === "b" && entry.reason === "overlapping_paths"));
  assert.ok(result.deferred.some(entry => entry.id === "c" && entry.reason === "overlapping_worktree"));
});

test("plan refuses dirty trees, unlinked roots, wrong baselines and escaping path declarations", async (t) => {
  const f = await fixture(t, ["a", "b", "c", "d", "e"]);
  await writeFile(path.join(f.trees.a, "dirty.txt"), "preexisting user change", "utf8");
  await f.put("a");
  await f.put("b", { worktree: f.repo });
  await f.put("c", { base: "a".repeat(40) });
  await f.put("d", { allowedPaths: ["src/../outside.js"] });
  await f.put("e");
  const plan = await f.flow({ mode: "plan" });
  assert.deepEqual(plan.selected, ["e"]);
  assert.match(plan.deferred.find(entry => entry.id === "a").message, /dirty/i);
  assert.match(plan.deferred.find(entry => entry.id === "b").message, /linked|dispatch/i);
  assert.match(plan.deferred.find(entry => entry.id === "c").message, /baseline|head/i);
  assert.match(plan.deferred.find(entry => entry.id === "d").message, /allowedPaths/i);
});

test("memory below 500 MiB prevents new claims", async (t) => {
  const f = await fixture(t, ["a"]);
  await f.put("a");
  const result = await f.flow({ availableMemory: () => 499 * 1024 * 1024, execute: () => assert.fail("memory admission bypass") });
  assert.deepEqual(result.selected, []);
  assert.ok(result.deferred.some(entry => entry.id === "a" && entry.reason === "low_memory"));
  assert.deepEqual(await readdir(path.join(f.board, "active")), []);
});

test("CLI rejects parallel values above five with a structured error", () => {
  const result = spawnSync(process.execPath, [script, "plan", "--board", ".", "--parallel", "6"], {
    encoding: "utf8", windowsHide: true,
  });
  assert.equal(result.status, 1);
  assert.ok(result.stdout, "CLI errors are machine-readable JSON");
  assert.match(JSON.parse(result.stdout).errors[0].message, /1.*5/);
});

test("rechecks available memory after Git inspection and before claiming", async (t) => {
  const f = await fixture(t, ["a"]);
  await f.put("a");
  let samples = 0;
  const result = await f.flow({
    availableMemory: () => samples++ === 0 ? memory() : 499 * 1024 * 1024,
    execute: () => assert.fail("card started with insufficient memory"),
  });
  assert.deepEqual(result.selected, []);
  assert.ok(result.deferred.some(entry => entry.id === "a" && entry.reason === "low_memory"));
  assert.deepEqual(await readdir(path.join(f.board, "active")), []);
});

test("only releases a child whose exact baseline contains its completed parent's commit", async (t) => {
  const f = await fixture(t, ["a", "b", "c"]);
  git(f.trees.a, "-c", "user.name=Dev Flow Fixture", "-c", "user.email=fixture@example.invalid",
    "commit", "--quiet", "--allow-empty", "-m", "parent candidate");
  const commit = git(f.trees.a, "rev-parse", "HEAD");
  git(f.trees.c, "checkout", "--quiet", "--detach", commit);
  await f.put("a", { status: "candidate_ready", result: { commit } }, "done");
  await f.put("b", { parents: ["a"] });
  await f.put("c", { parents: ["a"], base: commit });
  const result = await f.flow({ mode: "plan" });
  assert.deepEqual(result.selected, ["c"]);
  assert.ok(result.deferred.some(entry => entry.id === "b" && entry.reason === "parents_not_in_base"));
});

test("requires explicit reconciliation when legacy active writers are present", async (t) => {
  const f = await fixture(t, ["a"]);
  await f.put("a");
  const legacy = path.join(f.board, "active", "legacy.md");
  await writeFile(legacy, "Current owner still unverified", "utf8");
  const result = await f.flow({ execute: () => assert.fail("legacy active ownership bypassed") });
  assert.deepEqual(result.selected, []);
  assert.deepEqual(result.legacyActive, ["legacy"]);
  assert.ok(result.deferred.some(entry => entry.id === "a" && entry.reason === "legacy_active_unreconciled"));
  const plan = await f.flow({ mode: "plan", legacyReconciled: true });
  assert.deepEqual(plan.selected, ["a"]);
  assert.equal(await readFile(legacy, "utf8"), "Current owner still unverified");
});

test("rechecks the worktree immediately before starting a claimed worker", async (t) => {
  const f = await fixture(t, ["a"]);
  await f.put("a");
  let samples = 0;
  const result = await f.flow({
    availableMemory: () => {
      if (++samples === 2) writeFileSync(path.join(f.trees.a, "late.txt"), "someone else's work", "utf8");
      return memory();
    },
    execute: () => assert.fail("worker started on a changed worktree"),
  });
  assert.equal(result.results[0].phase, "claim");
  assert.match(result.results[0].message, /dirty/i);
  assert.equal((await f.get("a", "active")).status, "blocked");
  assert.equal(await readFile(path.join(f.trees.a, "late.txt"), "utf8"), "someone else's work");
});

test("leaves the current active card untouched when its owner changes during execution", async (t) => {
  const f = await fixture(t, ["a"]);
  await f.put("a");
  let external;
  const result = await f.flow({
    execute: async () => {
      external = { ...(await f.get("a", "active")), owner: "different-owner", notes: "external edit" };
      await writeFile(path.join(f.board, "active", "a.codex.json"), JSON.stringify(external), "utf8");
      return { status: "candidate_ready", commit: f.base };
    },
  });
  assert.equal(result.results[0].status, "blocked");
  assert.equal(result.results[0].phase, "writeback");
  assert.deepEqual(await f.get("a", "active"), external);
  assert.deepEqual(await readdir(path.join(f.board, "done")), []);
});

test("a structured card cannot take the identity of an existing ready Markdown card", async (t) => {
  const f = await fixture(t, ["a"]);
  await f.put("a");
  const legacy = path.join(f.board, "ready", "A.md");
  await writeFile(legacy, "Keep the existing ready owner", "utf8");
  const plan = await f.flow({ mode: "plan" });
  assert.deepEqual(plan.selected, []);
  assert.ok(plan.deferred.some(entry => entry.id === "a" && entry.reason === "existing_card"));
  assert.equal(await readFile(legacy, "utf8"), "Keep the existing ready owner");
});

test("stops before the next wave when approval for new claims is withdrawn", async (t) => {
  const f = await fixture(t, ["a", "b"]);
  await f.put("a");
  await f.put("b", { parents: ["a"] });
  let approved = true;
  const result = await f.flow({
    allowNewClaims: () => approved,
    execute: async card => {
      assert.equal(card.id, "a");
      approved = false;
      return { status: "candidate_ready", commit: f.base };
    },
  });
  assert.deepEqual(result.selected, ["a"]);
  assert.deepEqual(result.results.map(item => item.status), ["candidate_ready"]);
  assert.ok(result.deferred.some(entry => entry.id === "b" && entry.reason === "claims_paused"));
  assert.equal((await f.get("b", "ready")).owner, "original-owner");
});

test("rechecks claim permission immediately before moving a planned card", async (t) => {
  const f = await fixture(t, ["a"]);
  await f.put("a");
  let calls = 0;
  const result = await f.flow({
    allowNewClaims: () => ++calls === 1,
    execute: () => assert.fail("worker started after permission was withdrawn"),
  });
  assert.deepEqual(result.selected, []);
  assert.ok(result.deferred.some(entry => entry.id === "a" && entry.reason === "claims_paused"));
  assert.equal((await f.get("a", "ready")).owner, "original-owner");
  assert.deepEqual(await readdir(path.join(f.board, "active")), []);
});
