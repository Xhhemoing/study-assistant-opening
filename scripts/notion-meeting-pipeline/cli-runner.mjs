import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  HELP,
  formatStatus,
  redact,
  resolveLockPath,
  resolveManifestPath,
} from "./cli-options.mjs";
import { loadManifest, saveManifestAtomic, withFileLock } from "./state.mjs";
import { canonicalPageUrl } from "./policy.mjs";
import {
  ensureTarget,
  loadOrCreate,
  prepare,
  prepareAndRun,
  dryRun,
  upload,
  verify,
} from "./pipeline-operations.mjs";

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function execute(args) {
  if (args.command === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (args.command === "status") {
    const manifestPath = resolveManifestPath(args);
    const manifest = await loadManifest(manifestPath);
    print(manifest ? formatStatus(manifest) : { stage: "missing", manifestPath });
    return;
  }
  ensureTarget(args);
  if (args.dryRun) {
    print(await dryRun(args));
    return;
  }
  await mkdir(args.workdir, { recursive: true });
  await withFileLock(resolveLockPath(args), async () => {
    const { manifest, manifestPath } = await loadOrCreate(args);
    if (args.command === "prepare") await prepare(args, manifest, manifestPath);
    if (args.command === "upload") await upload(args, manifest, manifestPath);
    if (args.command === "verify") await verify(args, manifest, manifestPath);
    if (args.command === "run") await prepareAndRun(args, manifest, manifestPath);
    print(formatStatus(await loadManifest(manifestPath)));
  });
}

async function recordFailure(args, error) {
  if (!args || args.dryRun || ["help", "status"].includes(args.command)) return;
  if (/^(REAL_TARGET|NON_DISPOSABLE|INVALID_TARGET_URL)/i.test(String(error?.code ?? ""))) return;
  try {
    const manifestPath = resolveManifestPath(args);
    await withFileLock(resolveLockPath(args), async () => {
      const manifest = await loadManifest(manifestPath);
      if (!manifest) return;
      if (
        manifest.jobKey !== args.jobKey
        || (manifest.pageUrl && canonicalPageUrl(manifest.pageUrl) !== canonicalPageUrl(args.pageUrl))
        || (manifest.blockId && manifest.blockId !== args.blockId)
        || (manifest.expectedDurationSeconds && manifest.expectedDurationSeconds !== args.expectedDurationSeconds)
        || (args.preparedPathExplicit && manifest.prepared?.path && path.resolve(manifest.prepared.path) !== path.resolve(args.preparedPath))
        || (args.transcriptPathExplicit && manifest.verification?.artifactPath && path.resolve(manifest.verification.artifactPath) !== path.resolve(args.transcriptPath))
      ) return;
      manifest.stage = "failed";
      manifest.error = redact(error?.message ?? error).slice(0, 2_000);
      await saveManifestAtomic(manifestPath, manifest);
    });
  } catch {
    // Preserve the original error and never replace it with state-write details.
  }
}

export async function main(argv, parseArgs) {
  let args = null;
  try {
    args = parseArgs(argv);
    await execute(args);
    return 0;
  } catch (error) {
    await recordFailure(args, error);
    process.stderr.write(`notion-meeting-pipeline: ${redact(error?.message ?? error)}\n`);
    return 1;
  }
}
