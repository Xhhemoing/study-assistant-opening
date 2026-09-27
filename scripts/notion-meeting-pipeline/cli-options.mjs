import path from "node:path";
import { DEFAULT_DURATION_TOLERANCE_SECONDS, assertSafeTarget } from "./policy.mjs";
export const CLI_NAME = "notion-meeting-pipeline";
export { HELP, formatConfig, formatStatus, redact } from "./cli-format.mjs";

function requiredValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function positiveNumber(raw, option, integer = false) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`${option} must be a positive ${integer ? "integer" : "number"}`);
  }
  return value;
}

export function parseArgs(argv = process.argv.slice(2)) {
  const command = argv[0] === "--help" ? "help" : (argv[0] ?? "help");
  if (!["prepare", "upload", "verify", "run", "status", "help"].includes(command)) throw new Error(`unknown command: ${command}`);
  const result = {
    command,
    workdir: path.resolve(".tmp/notion-pipeline"),
    preparedPath: null,
    transcriptPath: null,
    ffmpegPath: process.env.FFMPEG_PATH ?? "ffmpeg",
    ffprobePath: process.env.FFPROBE_PATH ?? "ffprobe",
    profilePath: path.resolve(".tmp/notion-browser-profile"),
    chromePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    durationToleranceSeconds: DEFAULT_DURATION_TOLERANCE_SECONDS,
    taskTimeoutMs: 2 * 60 * 60 * 1000,
    pollMs: 2_000,
    allowNonDisposable: false,
    allowRealTarget: false,
    noWait: false,
    retryFailed: false,
    dryRun: false,
    source: null,
    sourceUrl: null,
    sourceBytes: null,
    sourceSha256: null,
    jobKey: null,
    expectedDurationSeconds: null,
    pageUrl: null,
    blockId: null,
    preparedPathExplicit: false,
    transcriptPathExplicit: false,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    switch (option) {
      case "--help": result.command = "help"; break;
      case "--job-key": result.jobKey = requiredValue(argv, index++, option); break;
      case "--source": result.source = path.resolve(requiredValue(argv, index++, option)); break;
      case "--source-url": result.sourceUrl = requiredValue(argv, index++, option); break;
      case "--source-bytes": result.sourceBytes = positiveNumber(requiredValue(argv, index++, option), option, true); break;
      case "--source-sha256": {
        const hash = requiredValue(argv, index++, option).toLowerCase();
        if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("--source-sha256 must be 64 hexadecimal characters");
        result.sourceSha256 = hash;
        break;
      }
      case "--expected-duration-seconds": result.expectedDurationSeconds = positiveNumber(requiredValue(argv, index++, option), option); break;
      case "--page-url": result.pageUrl = requiredValue(argv, index++, option); break;
      case "--block-id": result.blockId = requiredValue(argv, index++, option); break;
      case "--workdir": result.workdir = path.resolve(requiredValue(argv, index++, option)); break;
      case "--prepared-path":
        result.preparedPath = path.resolve(requiredValue(argv, index++, option));
        result.preparedPathExplicit = true;
        break;
      case "--transcript-path":
        result.transcriptPath = path.resolve(requiredValue(argv, index++, option));
        result.transcriptPathExplicit = true;
        break;
      case "--ffmpeg": result.ffmpegPath = requiredValue(argv, index++, option); break;
      case "--ffprobe": result.ffprobePath = requiredValue(argv, index++, option); break;
      case "--profile": result.profilePath = path.resolve(requiredValue(argv, index++, option)); break;
      case "--chrome": result.chromePath = requiredValue(argv, index++, option); break;
      case "--duration-tolerance-seconds": result.durationToleranceSeconds = positiveNumber(requiredValue(argv, index++, option), option); break;
      case "--task-timeout-ms": result.taskTimeoutMs = positiveNumber(requiredValue(argv, index++, option), option, true); break;
      case "--poll-ms": result.pollMs = positiveNumber(requiredValue(argv, index++, option), option, true); break;
      case "--allow-non-disposable": result.allowNonDisposable = true; break;
      case "--allow-real-target": result.allowRealTarget = true; break;
      case "--no-wait": result.noWait = true; break;
      case "--retry-failed": result.retryFailed = true; break;
      case "--dry-run": result.dryRun = true; break;
      default: throw new Error(`unknown option: ${option}`);
    }
  }
  const sourceUrl = result.sourceUrl;
  delete result.sourceUrl;
  Object.defineProperty(result, "sourceUrl", { value: sourceUrl, enumerable: false, writable: true, configurable: true });
  if (result.command === "help") return result;
  if (result.source && result.sourceUrl) throw new Error("provide exactly one of --source or --source-url");
  if (command === "prepare" && !result.source && !result.sourceUrl) throw new Error("prepare requires --source or --source-url");
  if (result.sourceUrl && !result.sourceSha256) throw new Error("--source-url requires --source-sha256 to pin the complete source");
  if (["prepare", "upload", "verify", "run"].includes(command)) {
    if (!result.jobKey) throw new Error("--job-key is required");
    if (!result.expectedDurationSeconds) throw new Error("--expected-duration-seconds is required");
    if (!result.pageUrl) throw new Error("--page-url is required");
    if (!result.blockId) throw new Error("--block-id is required");
  }
  result.preparedPath ??= path.join(result.workdir, "prepared.m4a");
  result.transcriptPath ??= path.join(result.workdir, "native-transcript.txt");
  return result;
}

export function resolveManifestPath({ workdir }) {
  return path.join(workdir, "manifest.json");
}

export function resolveLockPath({ workdir }) {
  return path.join(workdir, "pipeline.lock");
}

export function ensureTarget(args) {
  const target = assertSafeTarget({
    pageUrl: args.pageUrl,
    blockId: args.blockId,
    allowNonDisposable: args.allowNonDisposable,
    allowRealTarget: args.allowRealTarget,
  });
  args.pageUrl = target.pageUrl;
  return target;
}
