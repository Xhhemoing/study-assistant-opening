import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_TRANSCRIPT_TAIL_TOLERANCE_SECONDS,
  assessTranscript,
  assertSafeTarget,
  parseTranscriptTimestamps,
  publicId,
} from "./policy.mjs";

export class NotionUiError extends Error {
  constructor(message, code = "NOTION_UI_FAILED") {
    super(message);
    this.name = "NotionUiError";
    this.code = code;
  }
}

export function pathOf(raw) {
  const value = String(raw ?? "");
  if (value.startsWith("/")) return value.split(/[?#]/, 1)[0] || "/";
  try {
    return new URL(value).pathname;
  } catch {
    return "<url>";
  }
}

export function scrub(value, max = 1_000) {
  return String(value ?? "")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "<url>")
    .replace(/(?:ntn|secret)_[A-Za-z0-9_-]+/g, "<token>")
    .replace(/(?:AKIA|ASIA)[A-Z0-9]{8,}/g, "<credential>")
    .replace(/X-Amz-[A-Za-z-]+/gi, "<signed-field>")
    .replace(/\bBearer\s+[^\s,}]+/ig, "<redacted-auth>")
    .replace(/\b(?:authorization|credential|signature|security-token)\b\s*[:=]?\s*[^,;}\n]*/ig, "<redacted-sensitive-field>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function taskResults(json) {
  if (Array.isArray(json?.results)) return json.results;
  if (Array.isArray(json?.data?.results)) return json.data.results;
  if (Array.isArray(json?.result?.results)) return json.result.results;
  return [];
}

export function normalizeTaskState(value) {
  const state = typeof value === "string" ? value.toLowerCase() : null;
  if (["completed", "complete", "succeeded"].includes(state)) return "success";
  if (["error", "failed", "cancelled", "canceled"].includes(state)) return "failure";
  return state;
}

export function extractTaskId(json) {
  const candidates = [
    json?.taskId,
    json?.data?.taskId,
    json?.result?.taskId,
    json?.result?.id,
    json?.task?.id,
    json?.data?.task?.id,
    json?.result?.task?.id,
  ];
  return candidates.find((value) => typeof value === "string" && value.length > 0) ?? null;
}

function taskFields(item) {
  const task = item?.task && typeof item.task === "object" ? item.task : item;
  const id = task?.id ?? task?.taskId ?? item?.id ?? item?.taskId;
  const status = task?.state ?? task?.taskStatus ?? task?.status ?? item?.state ?? item?.taskStatus ?? item?.status;
  return {
    id: typeof id === "string" ? id : null,
    state: normalizeTaskState(typeof status === "string" ? status : status?.state),
    eventName: typeof (task?.eventName ?? item?.eventName) === "string"
      ? (task?.eventName ?? item.eventName)
      : null,
  };
}

export function summarizeTaskResponse(json) {
  if (!json || typeof json !== "object") return { value: scrub(json) };
  const results = taskResults(json);
  if (results.length === 0) return {};
  return { results: results.slice(0, 50).map(taskFields) };
}

export function extractTaskObservation(json, taskId) {
  const result = taskResults(json).find((item) => taskFields(item).id === taskId);
  return result ? taskFields(result) : null;
}

export function findBlockIndex(blockIds, blockId) {
  return blockIds.findLastIndex((candidate) => candidate === blockId);
}

export function isTranscriptionTaskRequest(body, blockId = null) {
  const task = body?.task ?? body?.data?.task;
  if (task?.eventName !== "transcribeAudio") return false;
  return !blockId || task.request?.transcriptionBlockPointer?.id === blockId;
}

export function resetFailedUploadManifest(manifest) {
  if (!manifest || typeof manifest !== "object") throw new NotionUiError("manifest is required", "INVALID_MANIFEST");
  manifest.notion ??= {};
  manifest.verification = null;
  manifest.notion.taskId = null;
  manifest.notion.taskState = null;
  manifest.notion.uploadStartedAt = null;
  manifest.notion.uploadCompletedAt = null;
  manifest.notion.lastObservedState = "retrying";
  manifest.stage = "prepared";
  manifest.error = null;
  return manifest;
}

export function decideUploadAction(manifest, options = {}) {
  if (manifest?.stage === "verified") return "verified";
  const notion = manifest?.notion ?? {};
  const taskState = String(notion.taskState ?? "").toLowerCase();
  if (notion.taskId) {
    if (["failure", "failed"].includes(taskState)) return options.retryFailed ? "retry-upload" : "failed-task";
    if (["success", "completed"].includes(taskState)) return "completed-task";
    return "resume-task";
  }
  if (notion.uploadCompletedAt) return "untracked-upload";
  if (notion.uploadStartedAt) return "ambiguous-upload";
  return "new-upload";
}

export function meetingTextState(text) {
  const value = String(text ?? "");
  if (/\bError\b|No transcript was captured|Something went wrong/i.test(value)) return "error";
  if (/Uploading|Transcribing|Reading transcript|Summarizing|Reading summary/i.test(value)) return "processing";
  if (/\bSummary\b/i.test(value) && /\bTranscript\b/i.test(value)) return "processed";
  return "clean";
}

export function meetingDomState(observations) {
  const items = Array.isArray(observations) ? observations : [];
  const text = items.map((item) => item?.text ?? "").join(" ");
  const tabs = items.flatMap((item) => Array.isArray(item?.tabs) ? item.tabs : []);
  const controls = items.flatMap((item) => Array.isArray(item?.controls) ? item.controls : []);
  const controlText = controls.map((control) => `${control?.aria ?? ""} ${control?.text ?? ""}`).join(" ");
  const textState = meetingTextState(`${text} ${controlText}`);
  if (textState === "processing") return "processing";
  if (textState === "error") return "error";
  const transcriptPanelText = items.flatMap((item) => Array.isArray(item?.panels) ? item.panels : [])
    .filter((panel) => /transcript/i.test(String(panel?.id ?? panel?.labelledBy ?? "")))
    .map((panel) => panel?.text ?? "")
    .join(" ");
  const hasSummaryOrTranscriptTab = tabs.some((tab) => /^(Summary|Transcript)$/i.test(String(tab?.text ?? "").trim()));
  if (hasSummaryOrTranscriptTab && parseTranscriptTimestamps(transcriptPanelText).length > 0) return "processed";
  if (hasSummaryOrTranscriptTab || items.some((item) => Number(item?.audioCount ?? 0) > 0)) return "occupied";
  return "clean";
}

export function cleanTranscriptForArtifact(text) {
  const normalized = String(text ?? "")
    .replace(/\u200b/g, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .trim();
  return normalized ? `${normalized}\n` : "";
}

export async function writeTranscriptArtifactAtomic(filePath, text) {
  const content = cleanTranscriptForArtifact(text);
  const digest = createHash("sha256").update(content, "utf8").digest("hex");
  const temporary = `${filePath}.${process.pid}.${Date.now()}-${randomUUID()}.tmp`;
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return { bytes: Buffer.byteLength(content, "utf8"), sha256: digest };
}

export function isNativeTranscriptGate({
  selectedTranscript,
  transcriptText,
  sourceDurationSeconds,
  tailToleranceSeconds = DEFAULT_TRANSCRIPT_TAIL_TOLERANCE_SECONDS,
} = {}) {
  const assessment = assessTranscript(transcriptText, sourceDurationSeconds, { tailToleranceSeconds });
  return { ...assessment, accepted: Boolean(selectedTranscript) && assessment.accepted };
}

export function isFailureState(state) {
  return normalizeTaskState(state) === "failure";
}

export { assertSafeTarget, publicId };
