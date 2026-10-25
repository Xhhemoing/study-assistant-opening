import type { AiGradingStatus } from "@aistudy/contracts";

// One controller per card, retained across effect cleanup/setup (including StrictMode).
export function createAiGradingPoll(
  read: (isCurrent: () => boolean) => Promise<AiGradingStatus["status"] | null>,
  onError: (reason: unknown) => void,
) {
  let active = false;
  let busy = false;
  let epoch = 0;
  let step = 0;
  let uncertainCost = false;
  let wakeRequested = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const visible = () => document.visibilityState !== "hidden";
  function clearTimer() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }
  function schedule(status: AiGradingStatus["status"] | "error" | null) {
    if (!status || !["queued", "grading", "unknown_cost", "error"].includes(status)) return;
    if (status === "unknown_cost") uncertainCost = true;
    const delay = [2000, 4000, 8000, 15000][Math.min(step++, 3)]!;
    // An uncertain charge must never cause more reads than the pending-job cap.
    timer = setTimeout(wake, uncertainCost ? 15000 : status === "error" ? Math.max(5000, delay) : delay);
  }
  async function poll() {
    if (!active || !visible() || busy) return;
    wakeRequested = false;
    busy = true;
    const requestEpoch = epoch;
    const isCurrent = () => active && visible() && epoch === requestEpoch;
    let status: AiGradingStatus["status"] | "error" | null = null;
    try {
      status = await read(isCurrent);
    } catch (reason) {
      if (isCurrent()) { onError(reason); status = "error"; }
    } finally {
      busy = false;
      if (active && visible()) {
        if (wakeRequested) void poll();
        else if (isCurrent()) schedule(status);
      }
    }
  }
  function wake() {
    clearTimer();
    if (!active || !visible()) return;
    wakeRequested = true;
    void poll();
  }
  function visibilityChanged() {
    epoch++;
    clearTimer();
    wakeRequested = false;
    if (visible()) wake();
  }
  return {
    start() {
      active = true;
      document.addEventListener("visibilitychange", visibilityChanged);
      wake();
    },
    stop() {
      active = false;
      epoch++;
      wakeRequested = false;
      clearTimer();
      document.removeEventListener("visibilitychange", visibilityChanged);
    },
    // Retry shares the same lock as status/history reads; never overlap requests.
    async retry(action: (isCurrent: () => boolean) => Promise<boolean>) {
      if (!active || !visible() || busy) return;
      clearTimer();
      busy = true;
      const requestEpoch = ++epoch;
      const isCurrent = () => active && visible() && epoch === requestEpoch;
      let succeeded = false;
      try { succeeded = await action(isCurrent); }
      finally {
        busy = false;
        step = 0;
        uncertainCost = false;
        if (active && visible() && (succeeded || wakeRequested || !isCurrent())) wake();
      }
    },
  };
}
