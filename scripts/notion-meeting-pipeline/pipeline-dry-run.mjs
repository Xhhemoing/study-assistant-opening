import { existsSync } from "node:fs";
import { loadManifest } from "./state.mjs";
import { resolveManifestPath } from "./cli-options.mjs";
import {
  assertManifestIdentity,
  assertVerifiedTranscriptArtifact,
  inspectPrepared,
  inspectSource,
  resolveSourcePath,
} from "./pipeline-validation.mjs";

export async function dryRun(args) {
  const manifestPath = resolveManifestPath(args);
  const manifest = await loadManifest(manifestPath);
  assertManifestIdentity(manifest, args);
  if (["upload", "verify"].includes(args.command) && !manifest) {
    throw new Error(`dry-run ${args.command} requires an existing manifest`);
  }

  let source = null;
  if (["prepare", "run"].includes(args.command)) {
    const sourcePath = resolveSourcePath(args, manifest);
    if (args.sourceUrl && !existsSync(sourcePath)) {
      throw new Error("dry-run will not download a remote source; provide --source or a completed download");
    }
    if (!sourcePath) {
      throw new Error("dry-run cannot validate a source; provide --source or resume from a manifest");
    }
    source = await inspectSource(sourcePath, args, manifest);
  }

  if (manifest?.stage === "verified") await assertVerifiedTranscriptArtifact(manifest);

  let prepared = null;
  const preparedPath = manifest?.prepared?.path ?? args.preparedPath;
  if (existsSync(preparedPath)) {
    const expectedDuration = source?.metadata.durationSeconds
      ?? manifest?.source?.durationSeconds
      ?? args.expectedDurationSeconds;
    prepared = await inspectPrepared(
      preparedPath,
      expectedDuration,
      args,
      manifest?.prepared ?? null,
    );
  } else if (["upload", "verify"].includes(args.command)) {
    throw new Error("dry-run requires an existing prepared audio artifact");
  }

  return {
    dryRun: true,
    command: args.command,
    manifestPath,
    manifestStage: manifest?.stage ?? "missing",
    source: source ? {
      bytes: source.digest.bytes,
      sha256: source.digest.sha256,
      durationSeconds: source.metadata.durationSeconds,
    } : null,
    prepared: prepared ? {
      bytes: prepared.digest.bytes,
      sha256: prepared.digest.sha256,
      durationSeconds: prepared.metadata.durationSeconds,
      audioProfile: "16 kHz mono AAC",
    } : { status: "not-present", path: preparedPath },
    notionMutation: "skipped",
  };
}
