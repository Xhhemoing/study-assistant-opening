import {
  assertSafeTarget,
  decideUploadAction,
  extractTaskId,
  isTranscriptionTaskRequest,
  meetingDomState,
  NotionUiError,
  resetFailedUploadManifest,
  pathOf,
  scrub,
} from "./notion-ui-helpers.mjs";
import {
  addSafeEvent,
  closeDialogs,
  findBlock,
  inspectMeetingDom,
  openContext,
} from "./notion-ui-browser.mjs";
import { waitForTask } from "./notion-task.mjs";

function observeResponse(response, blockId, events, getTaskId, setTaskId) {
  const endpoint = pathOf(response.url());
  if (!/\/api\/v3\//i.test(endpoint)) return Promise.resolve();
  if (!/enqueueTask|getTasks|getUserTasks|getUploadSpaceFileUrl|syncRecordValuesSpaceInitial/i.test(endpoint)) return Promise.resolve();
  addSafeEvent(events, {
    kind: "response",
    method: response.request().method(),
    path: endpoint,
    status: response.status(),
  });
  if (endpoint !== "/api/v3/enqueueTask") return Promise.resolve();
  let requestBody = null;
  try {
    requestBody = response.request().postDataJSON?.() ?? null;
  } catch {
    requestBody = null;
  }
  if (!isTranscriptionTaskRequest(requestBody, blockId)) return Promise.resolve();
  return response.json().then((body) => {
    const candidate = extractTaskId(body);
    if (candidate && !getTaskId()) setTaskId(candidate);
  }).catch(() => {});
}

async function flushResponses(pending) {
  if (pending.size === 0) return;
  await Promise.allSettled([...pending]);
}

function updateTaskManifest(manifest, observation, summary, onProgress, events) {
  if (!manifest) return Promise.resolve();
  if (observation?.state) {
    manifest.notion.taskState = observation.state;
    manifest.notion.lastObservedState = observation.state;
  }
  return onProgress?.(manifest, { events, task: summary });
}

export async function uploadMeetingAudio({
  pageUrl,
  blockId,
  audioPath,
  manifest,
  browserOptions = {},
  onProgress,
  waitForCompletion = true,
  retryFailed = false,
  allowNonDisposable = false,
  allowRealTarget = false,
} = {}) {
  assertSafeTarget({ pageUrl, blockId, allowNonDisposable, allowRealTarget });
  if (!audioPath) throw new NotionUiError("audioPath is required", "INVALID_UPLOAD");
  let context = null;
  let taskId = manifest?.notion?.taskId ?? null;
  const events = [];
  const pendingResponses = new Set();
  const startedAt = Date.now();
  try {
    context = await openContext(browserOptions);
    const page = context.pages()[0] ?? await context.newPage();
    const setTaskId = (value) => { taskId = value; };
    const onResponse = (response) => {
      const pending = observeResponse(response, blockId, events, () => taskId, setTaskId);
      pendingResponses.add(pending);
      pending.finally(() => pendingResponses.delete(pending)).catch(() => {});
    };
    page.on("response", onResponse);
    try {
      await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: browserOptions.navigationTimeoutMs ?? 60_000 });
      await page.waitForTimeout(browserOptions.settleMs ?? 5_000);
      await closeDialogs(page);
      const root = await findBlock(page, blockId);
      const initialDom = await inspectMeetingDom(page, blockId);
      const uiState = meetingDomState(initialDom);
      const uploadAction = decideUploadAction(manifest, { retryFailed });
      if (uploadAction === "verified") throw new NotionUiError("manifest is already verified; refusing duplicate upload", "ALREADY_VERIFIED");
      if (uploadAction === "failed-task") throw new NotionUiError("recorded transcription task failed; use --retry-failed after reviewing the Meeting", "FAILED_TASK_REQUIRES_REVIEW");
      if (["processed", "processing", "occupied", "error"].includes(uiState) && ["new-upload", "retry-upload"].includes(uploadAction)) {
        const code = uiState === "processed" ? "EXISTING_TRANSCRIPT" : uiState === "error" ? "UPLOAD_UI_ERROR" : "AMBIGUOUS_UPLOAD";
        throw new NotionUiError(`Meeting is not clean for ${uploadAction}; reset it before uploading again`, code);
      }
      if (uploadAction === "retry-upload") {
        resetFailedUploadManifest(manifest);
        await onProgress?.(manifest, { events, retrying: true });
      }
      if (uploadAction === "completed-task") {
        manifest.stage = "queued";
        manifest.notion.lastObservedState = "success";
        await onProgress?.(manifest, { events, task: { state: "success", resumed: true } });
        return { taskId: manifest.notion.taskId, task: { id: manifest.notion.taskId, state: "success" }, events, resumed: true, elapsedMs: Date.now() - startedAt };
      }
      if (uploadAction === "resume-task") {
        if (waitForCompletion) {
          const observed = await waitForTask(page, manifest.notion.taskId, {
            timeoutMs: browserOptions.taskTimeoutMs,
            pollMs: browserOptions.pollMs,
            onObservation: (observation, summary) => updateTaskManifest(manifest, observation, summary, onProgress, events),
          });
          manifest.notion.taskState = observed.state;
          manifest.notion.lastObservedState = observed.state;
          manifest.stage = "queued";
          await onProgress?.(manifest, { events });
        }
        return { taskId: manifest.notion.taskId, events, resumed: true, elapsedMs: Date.now() - startedAt };
      }
      if (uploadAction === "untracked-upload") throw new NotionUiError("upload completed without a task ID; refusing an untracked duplicate", "UNTRACKED_UPLOAD");
      if (uploadAction === "ambiguous-upload") throw new NotionUiError("a previous upload started without a task ID; inspect the Meeting before retrying", "AMBIGUOUS_UPLOAD");
      if (manifest) {
        manifest.notion.uploadStartedAt = new Date().toISOString();
        manifest.notion.lastObservedState = "upload_intent_recorded";
        await onProgress?.(manifest, { events });
      }
      const optionsButton = root.locator('[aria-label="Options"]:visible').last();
      if (await optionsButton.count() !== 1) throw new NotionUiError("Meeting Notes options control unavailable", "OPTIONS_NOT_FOUND");
      await optionsButton.click({ force: true });
      const uploadItem = page.getByRole("menuitem", { name: "Upload audio or video", exact: true });
      await uploadItem.waitFor({ state: "visible", timeout: 15_000 });
      const chooserPromise = page.waitForEvent("filechooser", { timeout: 10_000 }).catch(() => null);
      await uploadItem.click({ force: true });
      const chooser = await chooserPromise;
      if (chooser) await chooser.setFiles(audioPath);
      else await page.locator('input[type="file"]').last().setInputFiles(audioPath);
      if (manifest) {
        manifest.stage = "uploaded";
        manifest.notion.lastObservedState = "uploading";
        await onProgress?.(manifest, { events });
      }
      const uploadDeadline = Date.now() + (browserOptions.enqueueTimeoutMs ?? 20 * 60 * 1000);
      while (!taskId && Date.now() < uploadDeadline) {
        await page.waitForTimeout(1_000);
        await flushResponses(pendingResponses);
        const state = await inspectMeetingDom(page, blockId);
        const stateKind = meetingDomState(state);
        if (stateKind === "error") throw new NotionUiError("Meeting Notes entered an error state before task enqueue", "UPLOAD_UI_ERROR");
        await onProgress?.(manifest, { state, events });
      }
      await flushResponses(pendingResponses);
      if (!taskId) throw new NotionUiError("upload finished without an observable transcription task ID", "TASK_ID_MISSING");
      if (manifest) {
        manifest.notion.uploadCompletedAt = new Date().toISOString();
        manifest.notion.taskId = taskId;
        manifest.notion.taskState = "queued";
        manifest.notion.lastObservedState = "queued";
        manifest.stage = "queued";
        await onProgress?.(manifest, { events });
      }
      let task = null;
      if (waitForCompletion) {
        task = await waitForTask(page, taskId, {
          timeoutMs: browserOptions.taskTimeoutMs,
          pollMs: browserOptions.pollMs,
          onObservation: (observation, summary) => updateTaskManifest(manifest, observation, summary, onProgress, events),
        });
      }
      return { taskId, task, events, resumed: false, elapsedMs: Date.now() - startedAt };
    } finally {
      page.off("response", onResponse);
      await flushResponses(pendingResponses);
    }
  } catch (error) {
    throw error instanceof NotionUiError ? error : new NotionUiError(`Notion upload failed: ${scrub(error?.message)}`);
  } finally {
    await context?.close();
  }
}
