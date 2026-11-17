import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runLocalCard } from "../../scripts/local-dev-worker.mjs";

async function fixture(t) {
  const worktree = await mkdtemp(path.join(os.tmpdir(), "aistudy-local-worker-"));
  t.after(() => rm(worktree, { force: true, recursive: true }));
  const git = (...args) => execFileSync("git", args, { cwd: worktree, encoding: "utf8" }).trim();
  git("init");
  git("config", "user.name", "AIstudy test");
  git("config", "user.email", "aistudy-test@example.invalid");
  await writeFile(path.join(worktree, "owned.md"), "original\n", "utf8");
  await writeFile(path.join(worktree, "other.md"), "other\n", "utf8");
  git("add", "owned.md", "other.md");
  git("commit", "-m", "test fixture");
  return {
    id: "worker-fixture",
    goal: "Cover the local handoff",
    owner: "codex",
    risk: "L",
    worktree,
    base: git("rev-parse", "HEAD"),
    parents: [],
    allowedPaths: ["owned.md"],
    checks: [["--test", "fixture.test.mjs"]],
  };
}

test("hands an actual checked diff to a distinct read-only review session", async t => {
  const card = await fixture(t);
  const calls = [];
  const result = await runLocalCard(card, card.worktree, {
    async agent({ readOnly }) {
      calls.push(readOnly ? "review" : "write");
      if (readOnly) {
        assert.equal(await readFile(path.join(card.worktree, "owned.md"), "utf8"), "updated\n");
        return { exitCode: 0, threadId: "review", text: '{"verdict":"approved","summary":"Checked the actual diff."}' };
      }
      await writeFile(path.join(card.worktree, "owned.md"), "updated\n", "utf8");
      return { exitCode: 0, threadId: "writer", text: "Changed owned.md." };
    },
    async check(args) {
      calls.push("check");
      assert.deepEqual(args, card.checks[0]);
      return { exitCode: 0 };
    },
  });
  assert.deepEqual(calls, ["write", "check", "review"]);
  assert.equal(result.status, "candidate_ready");
  assert.deepEqual(result.changedFiles, ["owned.md"]);
  assert.equal(result.worker.threadId, "writer");
  assert.equal(result.review.threadId, "review");
});

test("holds out-of-scope writes without discarding them or running checks", async t => {
  const card = await fixture(t);
  const result = await runLocalCard(card, card.worktree, {
    async agent() {
      await writeFile(path.join(card.worktree, "other.md"), "worker mistake\n", "utf8");
      return { exitCode: 0, threadId: "writer", text: "Changed a file." };
    },
    async check() {
      assert.fail("Out-of-scope change must not reach checks.");
    },
  });
  assert.equal(result.status, "blocked");
  assert.match(result.error, /other\.md/);
  assert.equal(await readFile(path.join(card.worktree, "other.md"), "utf8"), "worker mistake\n");
});

test("does not treat a check that mutates the candidate as verification", async t => {
  const card = await fixture(t);
  const result = await runLocalCard(card, card.worktree, {
    async agent({ readOnly }) {
      assert.equal(readOnly, false);
      await writeFile(path.join(card.worktree, "owned.md"), "first candidate\n", "utf8");
      return { exitCode: 0, threadId: "writer", text: "Changed owned.md." };
    },
    async check() {
      await writeFile(path.join(card.worktree, "owned.md"), "different candidate\n", "utf8");
      return { exitCode: 0 };
    },
  });
  assert.equal(result.status, "blocked");
  assert.match(result.error, /changed during checks/);
});

test("keeps a real writer change when the independent review requests changes", async t => {
  const card = await fixture(t);
  const result = await runLocalCard(card, card.worktree, {
    async agent({ readOnly }) {
      if (readOnly) return { exitCode: 0, threadId: "review", text: '{"verdict":"changes_requested","summary":"Missing a failure assertion."}' };
      await writeFile(path.join(card.worktree, "owned.md"), "candidate\n", "utf8");
      return { exitCode: 0, threadId: "writer", text: "Changed owned.md." };
    },
    async check() {
      return { exitCode: 0 };
    },
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.review.verdict, "changes_requested");
  assert.equal(await readFile(path.join(card.worktree, "owned.md"), "utf8"), "candidate\n");
});


test("uses the card's Windows directory separator for an allowed child file", async t => {
  const card = await fixture(t);
  card.allowedPaths = ["nested\\"];
  const result = await runLocalCard(card, card.worktree, {
    async agent({ readOnly }) {
      if (readOnly) return { exitCode: 0, threadId: "review", text: '{"verdict":"approved","summary":"Scoped child file."}' };
      const directory = path.join(card.worktree, "nested");
      await mkdir(directory);
      await writeFile(path.join(directory, "child.md"), "candidate\n", "utf8");
      return { exitCode: 0, threadId: "writer", text: "Added a child file." };
    },
    async check() {
      return { exitCode: 0 };
    },
  });
  assert.equal(result.status, "candidate_ready");
  assert.deepEqual(result.changedFiles, ["nested/child.md"]);
});

test("does not accept a writer-created ignored file", async t => {
  const card = await fixture(t);
  const git = (...args) => execFileSync("git", args, { cwd: card.worktree, encoding: "utf8" }).trim();
  await writeFile(path.join(card.worktree, ".gitignore"), "local-fixture.tmp\n", "utf8");
  git("add", ".gitignore");
  git("commit", "-m", "test ignored fixture");
  card.base = git("rev-parse", "HEAD");
  const result = await runLocalCard(card, card.worktree, {
    async agent() {
      await writeFile(path.join(card.worktree, "owned.md"), "candidate\n", "utf8");
      await writeFile(path.join(card.worktree, "local-fixture.tmp"), "unexpected\n", "utf8");
      return { exitCode: 0, threadId: "writer", text: "Changed owned.md." };
    },
    async check() {
      assert.fail("The candidate should have been rejected before checks.");
    },
  });
  assert.equal(result.status, "blocked");
  assert.match(result.error, /ignored paths/);
});
