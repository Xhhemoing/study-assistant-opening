export const HELP = `Usage:
  node scripts/notion-meeting-pipeline.mjs <command> [options]

Commands:
  prepare   Acquire/hash/inspect the complete source and create upload-safe audio
  upload    Drive Meeting Notes -> Upload audio or video and persist task state
  verify    Require a readable native Transcript and save a local artifact
  run       Resume prepare, upload, and verify in order
  status    Print redacted manifest state

Required options:
  --job-key <key>                    Stable business identity
  --expected-duration-seconds <n>    Complete-source duration gate
  --page-url <url>                   Disposable Meeting page URL
  --block-id <uuid>                  Meeting Notes block ID

Source options (prepare/run):
  --source <path>                    Existing complete MP4/audio source
  --source-url <url>                 HTTP(S) source; downloads to workdir
  --source-bytes <n>                 Expected downloaded source bytes
  --source-sha256 <hex>              Expected downloaded source hash

Operational options:
  --workdir <path>                   State/artifact directory (default .tmp/notion-pipeline)
  --prepared-path <path>             Output M4A path (default <workdir>/prepared.m4a)
  --transcript-path <path>           Native transcript artifact path
  --ffmpeg <path>                    ffmpeg executable
  --ffprobe <path>                   ffprobe executable
  --profile <path>                   Persistent Playwright profile
  --chrome <path>                    Chrome executable
  --duration-tolerance-seconds <n>   Duration tolerance (default 15)
  --task-timeout-ms <n>              Notion task timeout (default 2 hours)
  --poll-ms <n>                      Task polling interval
  --allow-non-disposable             Permit a non-Meeting page (still not real target)
  --allow-real-target                Explicitly permit the known real target (dangerous)
  --no-wait                          Stop after task enqueue; do not poll
  --retry-failed                     Explicitly retry a recorded failed task
  --dry-run                          Validate and report without mutating Notion
  --help                             Show this help
`;

export function redact(value) {
  return String(value ?? "")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "<url>")
    .replace(/(?:ntn|secret)_[A-Za-z0-9_-]+/g, "<token>")
    .replace(/(?:AKIA|ASIA)[A-Z0-9]{8,}/g, "<credential>")
    .replace(/\bBearer\s+[^\s,}]+/ig, "<redacted-auth>")
    .replace(/\b(?:authorization|credential|signature|policy|security-token)\b\s*[:=]?\s*[^,;}\n]*/ig, "<redacted-sensitive-field>");
}

export function formatConfig(args) {
  return {
    command: args.command,
    jobKey: args.jobKey,
    workdir: args.workdir,
    source: args.source ? "<local-source>" : args.sourceUrl ? "<remote-source>" : null,
    expectedDurationSeconds: args.expectedDurationSeconds,
    pageUrl: args.pageUrl,
    blockId: args.blockId,
    dryRun: args.dryRun,
  };
}

export function formatStatus(manifest) {
  return {
    version: manifest?.version,
    jobKey: manifest?.jobKey,
    stage: manifest?.stage,
    updatedAt: manifest?.updatedAt,
    sourceBytes: manifest?.source?.bytes ?? null,
    sourceSha256: manifest?.source?.sha256 ?? null,
    sourceDurationSeconds: manifest?.source?.durationSeconds ?? null,
    preparedBytes: manifest?.prepared?.bytes ?? null,
    preparedSha256: manifest?.prepared?.sha256 ?? null,
    preparedDurationSeconds: manifest?.prepared?.durationSeconds ?? null,
    taskId: manifest?.notion?.taskId ? `${String(manifest.notion.taskId).slice(0, 6)}…` : null,
    taskState: manifest?.notion?.taskState ?? null,
    transcriptAccepted: manifest?.verification?.accepted ?? false,
    transcriptTimestampCount: manifest?.verification?.timestampCount ?? null,
    transcriptLastTimestampSeconds: manifest?.verification?.lastTimestampSeconds ?? null,
    error: manifest?.error ? redact(manifest.error) : null,
  };
}
