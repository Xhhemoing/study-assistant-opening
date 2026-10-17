import type { JobStatusResponse } from "../client/api";

export const TERMINAL_JOB_STATUSES = new Set<JobStatusResponse["status"]>([
  "succeeded", "failed", "cancelled", "outcome_unknown",
]);

type Visibility = Pick<Document, "hidden" | "addEventListener" | "removeEventListener">;
type JobPollerOptions = {
  getJob: (signal: AbortSignal) => Promise<JobStatusResponse>;
  onStatus: (job: JobStatusResponse, signal: AbortSignal) => void | Promise<void>;
  onError?: (error: unknown) => void;
  intervalMs?: number;
  maxRetryMs?: number;
  visibility?: Visibility;
};

/** Poll only while visible; retry failed reads without overlapping or replaying the job. */
export function createJobPoller({
  getJob, onStatus, onError, intervalMs = 1_000, maxRetryMs = 5_000,
  visibility = typeof document === "undefined" ? undefined : document,
}: JobPollerOptions) {
  let active = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let request: AbortController | null = null;
  let failures = 0;

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const cancel = () => {
    active = false;
    clearTimer();
    request?.abort();
    visibility?.removeEventListener("visibilitychange", onVisibilityChange);
  };
  const schedule = (delay: number) => {
    if (!active || visibility?.hidden) return;
    clearTimer();
    timer = setTimeout(() => { timer = null; void poll(); }, delay);
  };
  const poll = async (): Promise<void> => {
    if (!active || request || visibility?.hidden) return;
    const controller = new AbortController();
    request = controller;
    let delay = intervalMs;
    try {
      const job = await getJob(controller.signal);
      if (!active || controller.signal.aborted || visibility?.hidden) return;
      await onStatus(job, controller.signal);
      if (!active || controller.signal.aborted || visibility?.hidden) return;
      failures = 0;
      if (TERMINAL_JOB_STATUSES.has(job.status)) cancel();
    } catch (error) {
      if (!active || controller.signal.aborted || visibility?.hidden) return;
      failures += 1;
      delay = Math.min(maxRetryMs, intervalMs * 2 ** Math.min(failures, 16));
      onError?.(error);
    } finally {
      request = null;
      // Becoming visible while an aborted read settles should resume immediately.
      schedule(controller.signal.aborted ? 0 : delay);
    }
  };
  function onVisibilityChange() {
    clearTimer();
    if (visibility?.hidden) request?.abort();
    else if (!request) void poll();
  }

  return {
    start() {
      if (active) return;
      active = true;
      visibility?.addEventListener("visibilitychange", onVisibilityChange);
      void poll();
    },
    cancel,
  };
}
