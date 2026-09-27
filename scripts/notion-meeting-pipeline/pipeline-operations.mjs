import { existsSync } from "node:fs";
import {
  loadManifest,
  saveManifestAtomic,
  withFileLock,
} from "./state.mjs";
import { uploadMeetingAudio, verifyNativeTranscript } from "./notion-ui.mjs";
import { ensureTarget, resolveManifestPath } from "./cli-options.mjs";
import { loadOrCreate, prepare } from "./pipeline-preparation.mjs";
import { assertVerifiedTranscriptArtifact, inspectPrepared } from "./pipeline-validation.mjs";
import { dryRun } from "./pipeline-dry-run.mjs";

async function withProfileLock(args, operation) {
  return withFileLock(`${args.profilePath}.pipeline.lock`, operation);
}

export async function upload(args, manifest, manifestPath) {
  ensureTarget(args);
  if (manifest.stage === "verified") {
    await assertVerifiedTranscriptArtifact(manifest);
    return manifest;
  }
  if (!manifest.prepared?.path || !existsSync(manifest.prepared.path)) {
    throw new Error("prepared audio is missing; run prepare first");
  }
  const checked = await inspectPrepared(
    manifest.prepared.path,
    manifest.source?.durationSeconds ?? args.expectedDurationSeconds,
    args,
    manifest.prepared,
  );
  manifest.prepared.bytes = checked.digest.bytes;
  manifest.prepared.sha256 = checked.digest.sha256;
  manifest.prepared.durationSeconds = checked.metadata.durationSeconds;
  if (args.dryRun) return manifest;

  await withProfileLock(args, () => uploadMeetingAudio({
    pageUrl: args.pageUrl,
    blockId: args.blockId,
    audioPath: manifest.prepared.path,
    manifest,
    browserOptions: {
      profilePath: args.profilePath,
      executablePath: args.chromePath,
      taskTimeoutMs: args.taskTimeoutMs,
      pollMs: args.pollMs,
    },
    waitForCompletion: !args.noWait,
    allowNonDisposable: args.allowNonDisposable,
    allowRealTarget: args.allowRealTarget,
    retryFailed: args.retryFailed,
    onProgress: async (nextManifest) => { await saveManifestAtomic(manifestPath, nextManifest); },
  }));
  manifest.error = null;
  await saveManifestAtomic(manifestPath, manifest);
  return manifest;
}

export async function verify(args, manifest, manifestPath) {
  ensureTarget(args);
  if (manifest.stage === "verified") {
    await assertVerifiedTranscriptArtifact(manifest);
    return manifest;
  }
  if (args.dryRun) return manifest;
  if (!manifest.notion?.taskId) throw new Error("verification requires a persisted upload task");
  if (["failure", "failed"].includes(String(manifest.notion.taskState ?? "").toLowerCase())) {
    throw new Error("verification cannot continue after a failed upload task");
  }

  await withProfileLock(args, () => verifyNativeTranscript({
    pageUrl: args.pageUrl,
    blockId: args.blockId,
    sourceDurationSeconds: manifest.source?.durationSeconds ?? args.expectedDurationSeconds,
    manifest,
    artifactPath: args.transcriptPath,
    browserOptions: {
      profilePath: args.profilePath,
      executablePath: args.chromePath,
      verifyTimeoutMs: args.taskTimeoutMs,
      pollMs: args.pollMs,
    },
    allowNonDisposable: args.allowNonDisposable,
    allowRealTarget: args.allowRealTarget,
  }));
  manifest.error = null;
  await saveManifestAtomic(manifestPath, manifest);
  return manifest;
}

export async function prepareAndRun(args, manifest, manifestPath) {
  await prepare(args, manifest, manifestPath);
  await upload(args, manifest, manifestPath);
  if (!args.noWait) await verify(args, manifest, manifestPath);
  return manifest;
}

export {
  dryRun,
  ensureTarget,
  loadManifest,
  loadOrCreate,
  prepare,
  resolveManifestPath,
};
