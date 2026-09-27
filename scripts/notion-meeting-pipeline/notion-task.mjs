import {
  extractTaskObservation,
  NotionUiError,
  publicId,
  summarizeTaskResponse,
} from "./notion-ui-helpers.mjs";

export async function waitForTask(page, taskId, options = {}) {
  const timeoutMs = options.timeoutMs ?? 2 * 60 * 60 * 1000;
  const pollMs = options.pollMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await page.waitForTimeout(Math.min(pollMs, Math.max(0, remaining)));
    const response = await page.evaluate(async (id) => {
      const result = await fetch("/api/v3/getTasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskIds: [id] }),
        credentials: "include",
      });
      return { status: result.status, body: await result.json().catch(() => null) };
    }, taskId);
    if (response.status < 200 || response.status >= 300) {
      throw new NotionUiError(`task polling returned HTTP ${response.status}`, "TASK_POLL_FAILED");
    }
    last = extractTaskObservation(response.body, taskId);
    if (options.onObservation) await options.onObservation(last, summarizeTaskResponse(response.body));
    if (last?.state === "success") return last;
    if (last?.state === "failure") throw new NotionUiError("Notion transcription task failed", "TASK_FAILED");
  }
  throw new NotionUiError(`task ${publicId(taskId)} did not finish before timeout`, "TASK_TIMEOUT");
}
