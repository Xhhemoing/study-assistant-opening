import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { PipelineStateError } from "./state-errors.mjs";

async function createExclusive(filePath, content) {
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    return handle;
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(filePath, { force: true }).catch(() => {});
    throw error;
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function isReclaimableOwner(owner) {
  if (
    !owner
    || !Number.isInteger(owner.pid)
    || owner.pid <= 0
    || typeof owner.createdAt !== "string"
    || !Number.isFinite(Date.parse(owner.createdAt))
    || typeof owner.token !== "string"
    || owner.token.length < 16
  ) return false;
  return !processIsAlive(owner.pid);
}

async function readLockState(filePath) {
  let info;
  try {
    info = await stat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  let owner;
  try {
    owner = JSON.parse(raw);
  } catch {
    owner = null;
  }
  return { info, owner, raw };
}

function sameLockState(left, right) {
  return Boolean(left && right)
    && left.raw === right.raw
    && left.info.mtimeMs === right.info.mtimeMs
    && left.info.size === right.info.size;
}

async function releaseOwnedFile(filePath, handle, content) {
  await handle?.close().catch(() => {});
  try {
    if ((await readFile(filePath, "utf8")) === content) await rm(filePath, { force: true });
  } catch {
    // Cleanup must not replace the operation result.
  }
}

function ownerContent() {
  return JSON.stringify({
    pid: process.pid,
    createdAt: new Date().toISOString(),
    token: randomUUID(),
  });
}

async function acquireGate(gatePath, staleAfterMs) {
  const content = ownerContent();
  try {
    return { content, handle: await createExclusive(gatePath, content) };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }

  const state = await readLockState(gatePath);
  if (!state) return undefined;
  if (Date.now() - state.info.mtimeMs <= staleAfterMs || !isReclaimableOwner(state.owner)) return null;
  const confirmed = await readLockState(gatePath);
  if (!sameLockState(state, confirmed) || !isReclaimableOwner(confirmed.owner)) return undefined;
  const quarantine = `${gatePath}.stale-${process.pid}-${randomUUID()}`;
  try {
    await rename(gatePath, quarantine);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    if (["EPERM", "EACCES"].includes(error?.code)) return null;
    throw error;
  }
  await rm(quarantine, { force: true });
  try {
    return { content, handle: await createExclusive(gatePath, content) };
  } catch (error) {
    if (error?.code === "EEXIST") return undefined;
    throw error;
  }
}

async function acquireMain(lockPath, lockContent, staleAfterMs) {
  try {
    return await createExclusive(lockPath, lockContent);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const state = await readLockState(lockPath);
  if (!state) return undefined;
  if (Date.now() - state.info.mtimeMs <= staleAfterMs || !isReclaimableOwner(state.owner)) return null;
  const confirmed = await readLockState(lockPath);
  if (!sameLockState(state, confirmed) || !isReclaimableOwner(confirmed.owner)) return null;
  const quarantine = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    await rename(lockPath, quarantine);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    if (["EPERM", "EACCES"].includes(error?.code)) return null;
    throw error;
  }
  await rm(quarantine, { force: true });
  try {
    return await createExclusive(lockPath, lockContent);
  } catch (error) {
    if (error?.code === "EEXIST") return undefined;
    throw error;
  }
}

export async function withFileLock(lockPath, fn, options = {}) {
  const staleAfterMs = options.staleAfterMs ?? 24 * 60 * 60 * 1000;
  await mkdir(path.dirname(lockPath), { recursive: true });
  const gatePath = `${lockPath}.gate`;
  const lockContent = ownerContent();
  let gate;
  let handle;
  for (let attempt = 0; attempt < 3 && !gate; attempt += 1) {
    const candidate = await acquireGate(gatePath, staleAfterMs);
    if (candidate === null) throw new PipelineStateError(`state lock is already locked: ${lockPath}`, "STATE_LOCKED");
    if (candidate) {
      gate = candidate;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!gate) throw new PipelineStateError(`state lock is already locked: ${lockPath}`, "STATE_LOCKED");
  try {
    for (let attempt = 0; attempt < 3 && !handle; attempt += 1) {
      const candidate = await acquireMain(lockPath, lockContent, staleAfterMs);
      if (candidate === null) throw new PipelineStateError(`state lock is already locked: ${lockPath}`, "STATE_LOCKED");
      if (candidate) {
        handle = candidate;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!handle) throw new PipelineStateError(`state lock is already locked: ${lockPath}`, "STATE_LOCKED");
  } finally {
    await releaseOwnedFile(gatePath, gate.handle, gate.content);
  }
  try {
    return await fn();
  } finally {
    await releaseOwnedFile(lockPath, handle, lockContent);
  }
}
