import type { SourceRecord } from "@aistudy/contracts";
import { shouldRefreshSources } from "../inbox/source-refresh";

/** Poll known processing materials serially; hidden or disposed reads cannot publish stale state. */
export function startSourceProcessingRefresh(input: {
  read: () => Promise<SourceRecord[]>;
  accept: (sources: SourceRecord[]) => boolean | void;
  onError: (error: unknown) => void;
  isVisible?: () => boolean;
  subscribeVisibility?: (changed: () => void) => () => void;
  intervalMs?: number;
}) {
  const visible = input.isVisible ?? (() => document.visibilityState !== "hidden");
  const subscribe = input.subscribeVisibility ?? (changed => {
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  });
  let stopped = false, inFlight = false, processing = true, immediate = false, generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function schedule(delay = input.intervalMs ?? 2000) {
    clearTimeout(timer);
    if (!stopped && processing && visible()) timer = setTimeout(() => { void tick(); }, delay);
  }
  async function tick() {
    if (stopped || inFlight || !processing || !visible()) return;
    clearTimeout(timer); immediate = false; inFlight = true;
    const current = generation;
    try {
      const sources = await input.read();
      if (!stopped && current === generation && visible() && input.accept(sources) !== false) processing = shouldRefreshSources(sources);
    } catch (error) {
      if (!stopped && current === generation && visible()) input.onError(error);
    } finally {
      inFlight = false;
      schedule(immediate ? 0 : undefined);
    }
  }
  const unsubscribe = subscribe(() => {
    clearTimeout(timer);
    if (!visible()) { generation++; return; }
    if (inFlight) immediate = true;
    else void tick();
  });
  schedule();
  return {
    retry() {
      if (inFlight) immediate = true;
      else void tick();
    },
    stop() { stopped = true; generation++; clearTimeout(timer); unsubscribe(); },
  };
}
