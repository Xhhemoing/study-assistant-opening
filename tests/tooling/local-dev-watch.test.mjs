import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

async function boardFixture(t) {
  const board = await mkdtemp(path.join(tmpdir(), "local-dev-watch-"));
  for (const dir of ["ready", "active", "done"]) await mkdir(path.join(board, dir));
  t.after(() => rm(board, { recursive: true, force: true }));
  return board;
}

function latch() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function deadline(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Expected watcher event did not arrive")), 5000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

test("runs on startup and coalesces real ready/done wakes behind the running invocation", async (t) => {
  const board = await boardFixture(t);
  const { startLocalWatch } = await import("../../scripts/local-dev-watch.mjs");
  const initial = latch();
  const release = latch();
  const woken = latch();
  const reports = [];
  let calls = 0;
  let running = 0;
  let peak = 0;

  const controller = await startLocalWatch({
    board,
    run: async options => {
      assert.equal(options.mode, "run");
      running += 1;
      peak = Math.max(peak, running);
      const call = ++calls;
      if (call === 1) {
        initial.resolve();
        await release.promise;
      }
      if (call === 2) woken.resolve();
      running -= 1;
      return { errors: call === 1 ? [{ code: "example_read_error" }] : [] };
    },
    onReport: report => reports.push(report),
  });

  try {
    await deadline(initial.promise);
    await Promise.all([
      writeFile(path.join(board, "ready", "a.codex.json"), "{}", "utf8"),
      writeFile(path.join(board, "ready", "b.codex.json"), "{}", "utf8"),
      writeFile(path.join(board, "done", "c.codex.json"), "{}", "utf8"),
    ]);
    assert.equal(calls, 1);
    release.resolve();
    await deadline(woken.promise);
  } finally {
    release.resolve();
    await controller.close();
  }

  assert.equal(peak, 1);
  assert.equal(reports[0].type, "run");
  assert.deepEqual(reports[0].report.errors, [{ code: "example_read_error" }]);
});

test("stops after an existing Markdown card changes and waits for the in-flight run", async (t) => {
  const board = await boardFixture(t);
  const legacy = path.join(board, "active", "original.md");
  await writeFile(legacy, "Original owner", "utf8");
  const { startLocalWatch } = await import("../../scripts/local-dev-watch.mjs");
  const initial = latch();
  const release = latch();
  const stopped = latch();
  const claimPermission = latch();
  let calls = 0;

  const controller = await startLocalWatch({
    board, legacyReconciled: true,
    run: async options => {
      assert.equal(options.legacyReconciled, true);
      calls += 1;
      initial.resolve();
      await release.promise;
      claimPermission.resolve(await options.allowNewClaims());
      return { errors: [] };
    },
    onReport: event => {
      if (event.code === "legacy_changed") stopped.resolve(event);
    },
  });
  try {
    await deadline(initial.promise);
    await writeFile(legacy, "Changed owner", "utf8");
    assert.equal((await deadline(stopped.promise)).type, "error");
    await writeFile(path.join(board, "ready", "new.codex.json"), "{}", "utf8");
    release.resolve();
    await deadline(controller.done);
    assert.equal(await deadline(claimPermission.promise), false);
    assert.equal(calls, 1);
  } finally {
    release.resolve();
    await controller.close();
  }
});

test("waits for the external board lock to disappear and ignores its own later lock events", async (t) => {
  const board = await boardFixture(t);
  const lock = path.join(board, ".codex-run.lock");
  await mkdir(lock);
  const { startLocalWatch } = await import("../../scripts/local-dev-watch.mjs");
  const reportedLock = latch();
  const completedRun = latch();
  let calls = 0;
  const controller = await startLocalWatch({
    board,
    run: async () => {
      if (++calls === 1) return { errors: [{ code: "board_locked" }] };
      await mkdir(lock);
      await rmdir(lock);
      return { errors: [] };
    },
    onReport: event => {
      if (event.report?.errors?.[0]?.code === "board_locked") reportedLock.resolve();
      if (event.report?.errors?.length === 0) completedRun.resolve();
    },
  });
  try {
    await deadline(reportedLock.promise);
    await writeFile(path.join(board, "ready", "new.codex.json"), "{}", "utf8");
    await delay(60);
    assert.equal(calls, 1);
    await rmdir(lock);
    await deadline(completedRun.promise);
    await delay(60);
    assert.equal(calls, 2);
  } finally {
    await controller.close();
  }
});

test("rechecks immediately when the lock was already removed by the time watching begins", async (t) => {
  const board = await boardFixture(t);
  const { startLocalWatch } = await import("../../scripts/local-dev-watch.mjs");
  const completedRun = latch();
  let calls = 0;
  const controller = await startLocalWatch({
    board,
    run: async () => ({ errors: ++calls === 1 ? [{ code: "board_locked" }] : [] }),
    onReport: event => {
      if (event.report?.errors?.length === 0) completedRun.resolve();
    },
  });
  try {
    await deadline(completedRun.promise);
    assert.equal(calls, 2);
  } finally {
    await controller.close();
  }
});

test("refuses a Markdown symlink without running the flow", async (t) => {
  const board = await boardFixture(t);
  const target = path.join(board, "outside-queue");
  await mkdir(target);
  await symlink(target, path.join(board, "active", "linked.md"), "junction");
  const { startLocalWatch } = await import("../../scripts/local-dev-watch.mjs");
  await assert.rejects(async () => {
    const controller = await startLocalWatch({ board, legacyReconciled: true, run: () => assert.fail("linked card was accepted") });
    await controller.close();
  }, error => error.code === "legacy_symlink");
});


test("wakes an existing ready card when an active reservation is removed", async t => {
  const board = await boardFixture(t);
  const active = path.join(board, "active", "reservation.codex.json");
  await writeFile(active, "{}", "utf8");
  await writeFile(path.join(board, "ready", "waiting.codex.json"), "{}", "utf8");
  const { startLocalWatch } = await import("../../scripts/local-dev-watch.mjs");
  const startup = latch();
  const released = latch();
  let calls = 0;
  const controller = await startLocalWatch({
    board,
    run: async () => ({ errors: [] }),
    onReport: event => {
      if (event.type !== "run") return;
      if (++calls === 1) startup.resolve();
      else released.resolve();
    },
  });
  try {
    await deadline(startup.promise);
    await rm(active);
    await deadline(released.promise);
  } finally {
    await controller.close();
  }
  assert.equal(calls, 2);
});
