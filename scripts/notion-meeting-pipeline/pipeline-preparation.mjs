import { existsSync } from "node:fs";
import {
  DEFAULT_FRONTEND_UPLOAD_LIMIT_BYTES,
  canonicalPageUrl,
} from "./policy.mjs";
import {
  createManifest,
  loadManifest,
  saveManifestAtomic,
  stageAtLeast,
} from "./state.mjs";
import { convertToMeetingAudio, downloadResumable } from "./media.mjs";
import { resolveManifestPath } from "./cli-options.mjs";
import {
  assertManifestIdentity,
  inspectPrepared,
  inspectSource,
  resolveSourcePath,
} from "./pipeline-validation.mjs";

export async function loadOrCreate(args) {
  const manifestPath = resolveManifestPath(args);
  const existing = await loadManifest(manifestPath);
  if (existing) {
    assertManifestIdentity(existing, args);
    return { manifest: existing, manifestPath };
  }
  const manifest = createManifest({
    jobKey: args.jobKey,
    pageUrl: canonicalPageUrl(args.pageUrl),
    blockId: args.blockId,
    expectedDurationSeconds: args.expectedDurationSeconds,
  });
  await saveManifestAtomic(manifestPath, manifest);
  return { manifest, manifestPath };
}

export async function prepare(args, manifest, manifestPath) {
  if (stageAtLeast(manifest, "prepared") && manifest.prepared?.path && existsSync(manifest.prepared.path)) {
    const checked = await inspectPrepared(
      manifest.prepared.path,
      manifest.source?.durationSeconds ?? args.expectedDurationSeconds,
      args,
      manifest.prepared,
    );
    manifest.prepared.bytes = checked.digest.bytes;
    manifest.prepared.sha256 = checked.digest.sha256;
    manifest.prepared.durationSeconds = checked.metadata.durationSeconds;
    manifest.error = null;
    await saveManifestAtomic(manifestPath, manifest);
    return manifest;
  }

  const sourcePath = resolveSourcePath(args, manifest);
  if (args.sourceUrl && !existsSync(sourcePath)) {
    await downloadResumable(args.sourceUrl, sourcePath, {
      expectedBytes: args.sourceBytes ?? undefined,
      expectedSha256: args.sourceSha256,
    });
  }
  const source = await inspectSource(sourcePath, args, manifest);
  manifest.source = {
    path: source.path,
    bytes: source.digest.bytes,
    sha256: source.digest.sha256,
    durationSeconds: source.metadata.durationSeconds,
    inspectedAt: new Date().toISOString(),
  };
  manifest.stage = "source_ready";
  manifest.error = null;
  await saveManifestAtomic(manifestPath, manifest);

  if (!existsSync(args.preparedPath)) {
    const prepared = await convertToMeetingAudio(source.path, args.preparedPath, {
      ffmpegPath: args.ffmpegPath,
      ffprobePath: args.ffprobePath,
      sourceDurationSeconds: source.metadata.durationSeconds,
      maxBytes: DEFAULT_FRONTEND_UPLOAD_LIMIT_BYTES,
      durationToleranceSeconds: args.durationToleranceSeconds,
    });
    manifest.prepared = {
      path: prepared.path,
      bytes: prepared.bytes,
      sha256: prepared.sha256,
      durationSeconds: prepared.durationSeconds,
      preparedAt: new Date().toISOString(),
    };
  } else {
    const checked = await inspectPrepared(args.preparedPath, source.metadata.durationSeconds, args);
    manifest.prepared = {
      path: args.preparedPath,
      bytes: checked.digest.bytes,
      sha256: checked.digest.sha256,
      durationSeconds: checked.metadata.durationSeconds,
      preparedAt: new Date().toISOString(),
    };
  }
  manifest.stage = "prepared";
  manifest.error = null;
  await saveManifestAtomic(manifestPath, manifest);
  return manifest;
}
