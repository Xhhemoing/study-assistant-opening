import { existsSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_FRONTEND_UPLOAD_LIMIT_BYTES,
  assertCompleteDuration,
  canonicalPageUrl,
} from "./policy.mjs";
import {
  assertFileDigest,
  assertMeetingAudioProfile,
  inspectMedia,
  sha256File,
} from "./media.mjs";

export function assertManifestIdentity(manifest, args) {
  if (!manifest) return;
  if (manifest.jobKey !== args.jobKey) throw new Error("manifest job key does not match requested job key");
  if (manifest.pageUrl && canonicalPageUrl(manifest.pageUrl) !== canonicalPageUrl(args.pageUrl)) {
    throw new Error("manifest page URL does not match requested page URL");
  }
  if (manifest.blockId && manifest.blockId !== args.blockId) {
    throw new Error("manifest block ID does not match requested block ID");
  }
  if (manifest.expectedDurationSeconds && manifest.expectedDurationSeconds !== args.expectedDurationSeconds) {
    throw new Error("manifest expected duration does not match requested duration");
  }
  if (manifest.prepared?.path) {
    const persistedPath = path.resolve(manifest.prepared.path);
    if (args.preparedPathExplicit === false || args.preparedPathExplicit === undefined) {
      args.preparedPath = persistedPath;
    } else if (persistedPath !== path.resolve(args.preparedPath)) {
      throw new Error("manifest prepared path does not match requested prepared path");
    }
  }
  if (manifest.verification?.artifactPath) {
    const persistedPath = path.resolve(manifest.verification.artifactPath);
    if (args.transcriptPathExplicit === false || args.transcriptPathExplicit === undefined) {
      args.transcriptPath = persistedPath;
    } else if (persistedPath !== path.resolve(args.transcriptPath)) {
      throw new Error("manifest transcript path does not match requested transcript path");
    }
  }
}

export function resolveSourcePath(args, manifest = null) {
  if (args.source) return args.source;
  if (args.sourceUrl) return path.join(args.workdir, "source.download");
  return manifest?.source?.path ?? null;
}

export async function inspectSource(filePath, args, manifest = null) {
  if (!filePath || !existsSync(filePath)) throw new Error(`source file does not exist: ${filePath ?? "<missing>"}`);
  const digest = await sha256File(filePath);
  if (manifest?.source?.sha256 && manifest.source.sha256 !== digest.sha256) {
    throw new Error("source hash differs from the persisted job source");
  }
  if (args.sourceBytes !== null && digest.bytes !== args.sourceBytes) {
    throw new Error("source byte count does not match --source-bytes");
  }
  if (args.sourceSha256 && digest.sha256 !== args.sourceSha256) {
    throw new Error("source hash does not match --source-sha256");
  }
  const metadata = await inspectMedia(filePath, { ffprobePath: args.ffprobePath });
  assertCompleteDuration(metadata.durationSeconds, args.expectedDurationSeconds, args.durationToleranceSeconds);
  return { path: filePath, digest, metadata };
}

export async function assertVerifiedTranscriptArtifact(manifest) {
  const verification = manifest?.verification;
  if (!verification?.accepted) {
    throw new Error("verified manifest has no accepted transcript artifact");
  }
  if (
    typeof verification.artifactPath !== "string"
    || !verification.artifactPath
    || !Number.isInteger(verification.artifactBytes)
    || !/^[a-f0-9]{64}$/i.test(String(verification.artifactSha256 ?? ""))
  ) {
    throw new Error("verified manifest has incomplete transcript artifact metadata");
  }
  if (!existsSync(verification.artifactPath)) {
    throw new Error("verified transcript artifact is missing");
  }
  return assertFileDigest(verification.artifactPath, {
    bytes: verification.artifactBytes,
    sha256: verification.artifactSha256,
  });
}

export async function inspectPrepared(filePath, expectedDuration, args, expectedDigest = null) {
  if (!filePath || !existsSync(filePath)) throw new Error(`prepared audio does not exist: ${filePath ?? "<missing>"}`);
  if (expectedDigest) await assertFileDigest(filePath, expectedDigest);
  const metadata = await inspectMedia(filePath, { ffprobePath: args.ffprobePath });
  assertMeetingAudioProfile(metadata);
  assertCompleteDuration(metadata.durationSeconds, expectedDuration, args.durationToleranceSeconds);
  const digest = await sha256File(filePath);
  if (digest.bytes >= DEFAULT_FRONTEND_UPLOAD_LIMIT_BYTES) {
    throw new Error("prepared audio reaches the frontend upload limit");
  }
  return { path: filePath, digest, metadata };
}
