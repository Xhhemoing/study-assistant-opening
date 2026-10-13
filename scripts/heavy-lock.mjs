// Portable heavy-task lock (directory lock + owner pid), used where flock(1) is not
// available (Windows) or when HERMES_HEAVY_LOCK_IMPL=node. Same lock *path policy*
// as run-heavy.sh: one machine-wide slot at HERMES_HEAVY_LOCK (default
// <tmpdir>/hermes-project-heavy.lock), shared by every worktree and repo copy.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function defaultLockPath(env = process.env) {
  return env.HERMES_HEAVY_LOCK || path.join(os.tmpdir(), "hermes-project-heavy.lock");
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Acquire the slot or reject after timeoutMs (code "ELOCKTIMEOUT").
 * A lock whose owner pid is no longer alive is stale and reclaimed.
 * Returns release(); release is idempotent and only removes our own lock.
 */
export async function acquireHeavyLock({ lockPath = defaultLockPath(), timeoutMs = 120_000, pollMs = 100 } = {}) {
  const dir = `${lockPath}.d`;
  const owner = path.join(dir, "owner.json");
  const token = `${process.pid}:${Date.now()}:${Math.random()}`;
  const deadline = Date.now() + timeoutMs;
  mkdirSync(path.dirname(dir), { recursive: true });
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(owner, JSON.stringify({ pid: process.pid, host: os.hostname(), token, startedAt: new Date().toISOString() }));
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          if (JSON.parse(readFileSync(owner, "utf8")).token === token) rmSync(dir, { recursive: true, force: true });
        } catch { /* already gone */ }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let info = null;
      try { info = JSON.parse(readFileSync(owner, "utf8")); } catch { /* being written or torn */ }
      if (info && info.host === os.hostname() && !pidAlive(info.pid)) {
        rmSync(dir, { recursive: true, force: true });
        continue;
      }
      if (!info) {
        // Owner file missing/torn: treat as stale only if it stays that way.
        await sleep(pollMs * 5);
        try { info = JSON.parse(readFileSync(owner, "utf8")); } catch { rmSync(dir, { recursive: true, force: true }); continue; }
      }
      if (Date.now() >= deadline) {
        const err = new Error(`heavy-task lock held by pid ${info?.pid ?? "?"}`);
        err.code = "ELOCKTIMEOUT";
        throw err;
      }
      await sleep(pollMs);
    }
  }
}
