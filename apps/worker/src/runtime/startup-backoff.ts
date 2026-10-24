import { setTimeout as delay } from "node:timers/promises";

export async function runStartupWithBackoff(start: () => Promise<void>, settings: { initialMs: number; maxMs: number },
  options: { signal?: AbortSignal; sleep?: (ms: number) => Promise<void>; report?: (error: unknown, ms: number) => void } = {}) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  let wait = settings.initialMs;
  try {
    while (!controller.signal.aborted && !options.signal?.aborted) {
      try { await start(); return; }
      catch (error) {
        if (controller.signal.aborted || options.signal?.aborted) return;
        (options.report ?? ((failure, ms) => console.error("worker startup retry", { error: failure instanceof Error ? failure.name : "unknown", delayMs: ms })))(error, wait);
        try { await (options.sleep ? options.sleep(wait) : delay(wait, undefined, { signal: controller.signal })); }
        catch (error) { if (controller.signal.aborted) return; throw error; }
        wait = Math.min(settings.maxMs, wait * 2);
      }
    }
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}
