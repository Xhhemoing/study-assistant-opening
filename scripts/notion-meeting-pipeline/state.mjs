import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { withFileLock } from "./state-lock.mjs";
import { PipelineStateError } from "./state-errors.mjs";

const MANIFEST_VERSION = 1;
const STAGES = ["created", "source_ready", "prepared", "uploaded", "queued", "verified", "failed"];
const manifestWriteTails = new Map();

function assertString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new PipelineStateError(`${name} is required`, "STATE_INVALID");
  }
}

function validateManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PipelineStateError("manifest must be an object");
  }
  if (value.version !== MANIFEST_VERSION) {
    throw new PipelineStateError(`unsupported manifest version: ${String(value.version)}`);
  }
  assertString(value.jobKey, "manifest.jobKey");
  assertString(value.stage, "manifest.stage");
  if (!STAGES.includes(value.stage)) {
    throw new PipelineStateError(`unsupported manifest stage: ${value.stage}`);
  }
  assertString(value.createdAt, "manifest.createdAt");
  assertString(value.updatedAt, "manifest.updatedAt");
  if (value.pageUrl !== undefined) assertString(value.pageUrl, "manifest.pageUrl");
  if (value.blockId !== undefined) assertString(value.blockId, "manifest.blockId");
  if (!value.notion || typeof value.notion !== "object" || Array.isArray(value.notion)) {
    throw new PipelineStateError("manifest.notion is required", "STATE_INVALID");
  }
  return value;
}

export function createManifest({ jobKey, pageUrl, blockId, expectedDurationSeconds = null } = {}) {
  assertString(jobKey, "jobKey");
  const now = new Date().toISOString();
  return {
    version: MANIFEST_VERSION,
    jobKey,
    stage: "created",
    createdAt: now,
    updatedAt: now,
    pageUrl,
    blockId,
    expectedDurationSeconds,
    source: null,
    prepared: null,
    notion: {
      uploadStartedAt: null,
      uploadCompletedAt: null,
      taskId: null,
      taskState: null,
      lastObservedState: null,
    },
    verification: null,
    error: null,
  };
}

export async function loadManifest(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PipelineStateError("manifest JSON is invalid", "STATE_CORRUPT");
  }
  return validateManifest(parsed);
}

async function withLocalManifestWriteLock(filePath, operation) {
  const previous = manifestWriteTails.get(filePath) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  manifestWriteTails.set(filePath, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (manifestWriteTails.get(filePath) === current) manifestWriteTails.delete(filePath);
  }
}

export async function saveManifestAtomic(filePath, manifest) {
  return withLocalManifestWriteLock(filePath, async () => {
    const valid = validateManifest({ ...manifest, updatedAt: new Date().toISOString() });
    const directory = path.dirname(filePath);
    await mkdir(directory, { recursive: true });
    const temporary = `${filePath}.${process.pid}.${Date.now()}-${randomUUID()}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify(valid, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    try {
      await rename(temporary, filePath);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    return valid;
  });
}

export function stageAtLeast(manifest, stage) {
  const current = STAGES.indexOf(manifest?.stage);
  const target = STAGES.indexOf(stage);
  if (current < 0 || target < 0 || manifest?.stage === "failed") return manifest?.stage === stage;
  return current >= target;
}

export { MANIFEST_VERSION, PipelineStateError, STAGES, withFileLock };
