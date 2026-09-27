const REAL_TARGET_PAGE_URL = "https://app.notion.com/p/3e2f3b2f-e60f-8106-af39-f48327cf2574";
const REAL_TARGET_BLOCK_ID = "f32103cb-2112-40a2-8ef8-cd7b71030e1b";

export const DEFAULT_FRONTEND_UPLOAD_LIMIT_BYTES = 26_214_400;
export const DEFAULT_DURATION_TOLERANCE_SECONDS = 15;
export const DEFAULT_TRANSCRIPT_TAIL_TOLERANCE_SECONDS = 180;

export class PipelinePolicyError extends Error {
  constructor(message, code = "POLICY_REJECTED") {
    super(message);
    this.name = "PipelinePolicyError";
    this.code = code;
  }
}

function finiteNumber(value, name) {
  if (!Number.isFinite(value)) {
    throw new PipelinePolicyError(`${name} must be a finite number`, "INVALID_NUMBER");
  }
  return value;
}

export function assertCompleteDuration(
  actualSeconds,
  expectedSeconds,
  toleranceSeconds = DEFAULT_DURATION_TOLERANCE_SECONDS,
) {
  finiteNumber(actualSeconds, "actual duration");
  finiteNumber(expectedSeconds, "expected duration");
  finiteNumber(toleranceSeconds, "duration tolerance");
  if (expectedSeconds <= 0 || actualSeconds <= 0 || toleranceSeconds < 0) {
    throw new PipelinePolicyError("duration values must be positive and tolerance must be non-negative", "INVALID_DURATION");
  }
  const differenceSeconds = actualSeconds - expectedSeconds;
  if (Math.abs(differenceSeconds) > toleranceSeconds) {
    throw new PipelinePolicyError(
      `source duration ${actualSeconds.toFixed(2)}s differs from expected ${expectedSeconds.toFixed(2)}s by ${Math.abs(differenceSeconds).toFixed(2)}s`,
      "INCOMPLETE_SOURCE",
    );
  }
  return { complete: true, actualSeconds, expectedSeconds, toleranceSeconds, differenceSeconds };
}

export function assertUploadSize(bytes, limitBytes = DEFAULT_FRONTEND_UPLOAD_LIMIT_BYTES) {
  if (!Number.isInteger(bytes) || bytes <= 0 || !Number.isInteger(limitBytes) || limitBytes <= 0) {
    throw new PipelinePolicyError("upload size and limit must be positive integers", "INVALID_SIZE");
  }
  if (bytes >= limitBytes) {
    throw new PipelinePolicyError(
      `audio size ${bytes} bytes reaches the frontend limit ${limitBytes} bytes`,
      "UPLOAD_TOO_LARGE",
    );
  }
  return { accepted: true, bytes, limitBytes, remainingBytes: limitBytes - bytes };
}

function timestampSeconds(match) {
  const first = match[1] === undefined ? 0 : Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  return first * 3600 + minutes * 60 + seconds;
}

export function parseTranscriptTimestamps(text) {
  const matches = [...String(text ?? "").matchAll(/\b(?:(\d{1,3}):)?(\d{1,2}):(\d{2})\b/g)];
  return matches
    .filter((match) => Number(match[3]) < 60 && Number(match[2]) < 60)
    .map((match) => ({
      label: match[0],
      seconds: timestampSeconds(match),
      index: match.index ?? 0,
    }));
}

export function normalizeTranscriptText(text) {
  return String(text ?? "")
    .replace(/\u200b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function assessTranscript(text, sourceDurationSeconds, options = {}) {
  const normalizedText = normalizeTranscriptText(text);
  const timestamps = parseTranscriptTimestamps(normalizedText);
  const sourceDuration = Number.isFinite(sourceDurationSeconds) && sourceDurationSeconds > 0
    ? sourceDurationSeconds
    : null;
  const lastTimestampSeconds = timestamps.at(-1)?.seconds ?? null;
  const firstTimestampSeconds = timestamps[0]?.seconds ?? null;
  const tailGapSeconds = sourceDuration === null || lastTimestampSeconds === null
    ? null
    : Math.max(0, sourceDuration - lastTimestampSeconds);
  const coverage = sourceDuration === null || lastTimestampSeconds === null
    ? null
    : Math.min(1, lastTimestampSeconds / sourceDuration);
  const minChars = options.minChars ?? 40;
  const minTimestampCount = options.minTimestampCount ?? 1;
  const tailToleranceSeconds = options.tailToleranceSeconds ?? DEFAULT_TRANSCRIPT_TAIL_TOLERANCE_SECONDS;
  const readable = normalizedText.length >= minChars && timestamps.length >= minTimestampCount;
  const coverageAccepted = sourceDuration === null
    || sourceDuration <= tailToleranceSeconds
    || (tailGapSeconds !== null && tailGapSeconds <= tailToleranceSeconds);

  return {
    normalizedText,
    chars: normalizedText.length,
    words: normalizedText ? normalizedText.split(/\s+/u).length : 0,
    timestamps,
    timestampCount: timestamps.length,
    firstTimestampSeconds,
    lastTimestampSeconds,
    tailGapSeconds,
    coverage,
    readable,
    coverageAccepted,
    accepted: readable && coverageAccepted,
  };
}

export function canonicalPageUrl(pageUrl) {
  try {
    const parsed = new URL(pageUrl);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return String(pageUrl ?? "");
  }
}

export function isDisposableMeetingPage(pageUrl) {
  const normalized = canonicalPageUrl(pageUrl);
  return /^https:\/\/app\.notion\.com\/p\/Meeting-[0-9a-f]{32}$/i.test(normalized);
}

export function assertSafeTarget({ pageUrl, blockId, allowNonDisposable = false, allowRealTarget = false } = {}) {
  let parsedPageUrl;
  try {
    parsedPageUrl = new URL(pageUrl);
  } catch {
    throw new PipelinePolicyError("page URL must be an HTTPS app.notion.com URL", "INVALID_TARGET_URL");
  }
  if (
    parsedPageUrl.protocol !== "https:"
    || parsedPageUrl.hostname.toLowerCase() !== "app.notion.com"
    || parsedPageUrl.port
    || parsedPageUrl.username
    || parsedPageUrl.password
  ) {
    throw new PipelinePolicyError("page URL must be an HTTPS app.notion.com URL without embedded credentials", "INVALID_TARGET_URL");
  }
  const normalizedPageUrl = canonicalPageUrl(parsedPageUrl.toString());
  const isRealPage = normalizedPageUrl === REAL_TARGET_PAGE_URL;
  const isRealBlock = blockId === REAL_TARGET_BLOCK_ID;
  const realTarget = isRealPage && isRealBlock;
  if (isRealPage || isRealBlock) {
    if (!realTarget) {
      throw new PipelinePolicyError("real target page and block must be supplied as the exact known pair", "REAL_TARGET_MISMATCH");
    }
    if (!allowRealTarget) {
      throw new PipelinePolicyError("refusing to operate on the real target Meeting; use the explicit real-target override", "REAL_TARGET_BLOCKED");
    }
  }
  const disposable = isDisposableMeetingPage(normalizedPageUrl) && !isRealBlock;
  if (!disposable && !allowNonDisposable && !realTarget) {
    throw new PipelinePolicyError("page is not a disposable Meeting page; refusing mutation", "NON_DISPOSABLE_BLOCKED");
  }
  return { pageUrl: normalizedPageUrl, blockId, disposable, realTarget };
}

export function makePipelineJobKey({ courseId, subId, role = "teacher", sourceSha256 } = {}) {
  for (const [name, value] of Object.entries({ courseId, subId, role, sourceSha256 })) {
    if (!/^[A-Za-z0-9:_-]+$/.test(String(value ?? ""))) {
      throw new PipelinePolicyError(`${name} contains unsupported identity characters`, "INVALID_JOB_KEY");
    }
  }
  return `zhixue:${courseId}:${subId}:${role}:${sourceSha256}`;
}

export function publicId(value) {
  const text = String(value ?? "");
  if (text.length <= 12) return text;
  return `${text.slice(0, 6)}…${text.slice(-4)}`;
}

export const knownRealTarget = Object.freeze({
  pageUrl: REAL_TARGET_PAGE_URL,
  blockId: REAL_TARGET_BLOCK_ID,
});
