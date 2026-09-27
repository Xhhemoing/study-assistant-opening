import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  cleanTranscriptForArtifact,
  extractTaskId,
  extractTaskObservation,
  buildBrowserContextOptions,
  decideUploadAction,
  findBlockIndex,
  isNativeTranscriptGate,
  isTranscriptionTaskRequest,
  meetingDomState,
  meetingTextState,
  normalizeTaskState,
  pathOf,
  resetFailedUploadManifest,
  scrub,
  summarizeTaskResponse,
  writeTranscriptArtifactAtomic,
} from "./notion-ui.mjs";

describe("Notion UI adapter boundaries", () => {
  it("reduces network URLs and endpoint paths without query or signed material", () => {
    expect(pathOf("https://www.notion.so/api/v3/getTasks?signature=secret-value")).toBe("/api/v3/getTasks");
    expect(pathOf("/api/v3/getTasks?signature=secret-value")).toBe("/api/v3/getTasks");
    expect(pathOf("not-a-url")).toBe("<url>");
  });

  it("redacts authorization values from UI errors", () => {
    expect(scrub("Authorization: Bearer secret-value")).not.toContain("secret-value");
  });

  it("resumes any recorded task instead of uploading a duplicate", () => {
    expect(decideUploadAction({ notion: { taskId: "task", taskState: "success" } })).toBe("completed-task");
    expect(decideUploadAction({ notion: { taskId: "task", taskState: "failure" } })).toBe("failed-task");
    expect(decideUploadAction({ notion: { taskId: "task", taskState: "failure" } }, { retryFailed: true })).toBe("retry-upload");
    expect(decideUploadAction({ notion: { uploadCompletedAt: "2026-09-22T00:00:00.000Z" } })).toBe("untracked-upload");
    expect(decideUploadAction({ notion: { uploadStartedAt: "2026-09-22T00:00:00.000Z" } })).toBe("ambiguous-upload");
    expect(decideUploadAction({ notion: {} })).toBe("new-upload");
  });

  it("clears failed task identity before an explicitly approved clean retry", () => {
    const manifest = {
      stage: "failed",
      notion: {
        taskId: "task",
        taskState: "failure",
        uploadStartedAt: "started",
        uploadCompletedAt: "completed",
        lastObservedState: "failure",
      },
    };
    manifest.verification = { accepted: false };
    expect(resetFailedUploadManifest(manifest)).toBe(manifest);
    expect(manifest).toMatchObject({
      stage: "prepared",
      verification: null,
      notion: {
        taskId: null,
        taskState: null,
        uploadStartedAt: null,
        uploadCompletedAt: null,
        lastObservedState: "retrying",
      },
    });
  });

  it("does not pass the profile path as an unknown Playwright launch option", () => {
    expect(buildBrowserContextOptions({
      profilePath: "profile",
      executablePath: "chrome",
      headless: false,
    })).toEqual({
      profilePath: "profile",
      launchOptions: { executablePath: "chrome", headless: false, viewport: { width: 1440, height: 1200 } },
    });
  });

  it("matches a block by data attribute after enumerating roots, without building a UUID selector", () => {
    expect(findBlockIndex(["other", "3e2f3b2f-e60f-803e-b05f-de720f6b9527"], "3e2f3b2f-e60f-803e-b05f-de720f6b9527")).toBe(1);
    expect(findBlockIndex(["other"], "missing")).toBe(-1);
  });

  it("prefers the latest rerendered root when Notion temporarily keeps an older copy", () => {
    expect(findBlockIndex([
      "3e2f3b2f-e60f-803e-b05f-de720f6b9527",
      "other",
      "3e2f3b2f-e60f-803e-b05f-de720f6b9527",
    ], "3e2f3b2f-e60f-803e-b05f-de720f6b9527")).toBe(2);
  });

  it("classifies existing Meeting UI state before a new upload", () => {
    expect(meetingTextState("Meeting Notes Summary Transcript")).toBe("processed");
    expect(meetingTextState("Meeting Notes Transcribing")).toBe("processing");
    expect(meetingTextState("Transcribing Something went wrong")).toBe("error");
    expect(meetingTextState("Summary Transcript Reading transcript…")).toBe("processing");
    expect(meetingTextState("Summary Transcript Error")).toBe("error");
    expect(meetingTextState("Meeting Notes Notes")).toBe("clean");
  });

  it("extracts task IDs and observations from current and wrapped API responses", () => {
    expect(extractTaskId({ taskId: "task-current" })).toBe("task-current");
    expect(extractTaskId({ data: { taskId: "task-wrapped" } })).toBe("task-wrapped");
    expect(extractTaskId({ result: { task: { id: "task-nested" } } })).toBe("task-nested");
    expect(extractTaskId({ result: { id: "task-result" } })).toBe("task-result");
    expect(extractTaskId({ data: { taskId: "" } })).toBeNull();
    expect(extractTaskObservation({ data: { results: [{ id: "task", taskStatus: "failure" }] } }, "task")).toMatchObject({
      id: "task",
      state: "failure",
    });
    expect(extractTaskObservation({ results: [{ id: "task", status: "success" }] }, "task")).toMatchObject({
      id: "task",
      state: "success",
    });
    expect(extractTaskObservation({ result: { results: [{ task: { id: "task", status: { state: "completed" } } }] } }, "task")).toMatchObject({
      id: "task",
      state: "success",
    });
    expect(normalizeTaskState("completed")).toBe("success");
    expect(normalizeTaskState("failed")).toBe("failure");
  });

  it("requires transcript content before classifying visible tabs as processed", () => {
    expect(meetingDomState([{
      text: "Meeting Summary Transcript",
      tabs: [{ text: "Summary" }, { text: "Transcript" }],
      panels: [{ id: "summary-tabpanel", text: "" }, { id: "transcript-tabpanel", text: "" }],
      controls: [],
      audioCount: 0,
    }])).toBe("occupied");
    expect(meetingDomState([{
      text: "Meeting Summary Transcript",
      tabs: [{ text: "Summary" }, { text: "Transcript" }],
      panels: [{ id: "transcript-tabpanel", text: "99:99 not a timestamp" }],
      controls: [],
      audioCount: 0,
    }])).toBe("occupied");
    expect(meetingDomState([{
      text: "Meeting Summary Transcript 0:00 hello",
      tabs: [{ text: "Summary" }, { text: "Transcript" }],
      panels: [{ id: "transcript-tabpanel", text: "0:00 hello" }],
      controls: [],
      audioCount: 1,
    }])).toBe("processed");
    expect(meetingDomState([{
      text: "Meeting",
      tabs: [{ text: "Notes" }],
      controls: [{ aria: null, text: "Transcribing" }],
      audioCount: 1,
    }])).toBe("processing");
    expect(meetingDomState([{
      text: "Meeting Error",
      tabs: [{ text: "Notes" }],
      controls: [{ aria: "Error", text: "" }],
      audioCount: 1,
    }])).toBe("error");
    expect(meetingDomState([{
      text: "Meeting Notes",
      tabs: [{ text: "Notes" }],
      controls: [],
      audioCount: 0,
    }])).toBe("clean");
  });

  it("recognizes only transcription enqueue requests", () => {
    expect(isTranscriptionTaskRequest({ task: { eventName: "transcribeAudio" } })).toBe(true);
    expect(isTranscriptionTaskRequest({ task: { eventName: "summarizePage" } })).toBe(false);
    expect(isTranscriptionTaskRequest(null)).toBe(false);
  });

  it("keeps only task lifecycle fields from a task response", () => {
    expect(summarizeTaskResponse({
      results: [{
        id: "task-1234567890",
        state: "in_progress",
        eventName: "transcribeAudio",
        status: { signedUrl: "must-not-escape" },
      }],
    })).toEqual({
      results: [{ id: "task-1234567890", state: "in_progress", eventName: "transcribeAudio" }],
    });
    expect(extractTaskObservation({
      results: [{ id: "task", state: "success", eventName: "transcribeAudio" }],
    }, "task")).toMatchObject({ state: "success", eventName: "transcribeAudio" });
    expect(summarizeTaskResponse({ result: { results: [{ taskId: "task", status: "completed" }] } })).toMatchObject({
      results: [{ id: "task", state: "success" }],
    });
  });

  it("requires a selected native Transcript panel rather than Summary text", () => {
    expect(isNativeTranscriptGate({
      selectedTranscript: true,
      transcriptText: "0:00 A readable transcript with enough words.",
      sourceDurationSeconds: 10,
    })).toMatchObject({ accepted: true, readable: true });
    expect(isNativeTranscriptGate({
      selectedTranscript: false,
      transcriptText: "0:00 A readable transcript with enough words.",
      sourceDurationSeconds: 10,
    }).accepted).toBe(false);
  });

  it("cleans zero-width characters while preserving transcript line structure", () => {
    expect(cleanTranscriptForArtifact("0:01\u200b Hello\r\n\r\n0:05 World ")).toBe("0:01 Hello\n\n0:05 World\n");
  });

  it("writes transcript artifacts atomically and returns a digest", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "notion-transcript-artifact-"));
    try {
      const artifact = path.join(dir, "native-transcript.txt");
      const result = await writeTranscriptArtifactAtomic(artifact, "0:00 Hello\n");
      expect(result).toMatchObject({ bytes: 11, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
      await expect(readFile(artifact, "utf8")).resolves.toBe("0:00 Hello\n");
      expect((await readdir(dir)).filter((name) => name.includes(".tmp"))).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
