import type { SourceRecord } from "@aistudy/contracts";

type SourceState = Pick<SourceRecord, "uploadState" | "parseState">;
export function shouldRefreshSources(sources: readonly SourceState[]): boolean {
  return sources.some((source) => source.uploadState === "uploaded" &&
    ["not_started", "queued", "running"].includes(source.parseState));
}

/** Serial reads only; disposing never schedules another request or reports late failures. */
export function startSourceRefresh(input: {
  refresh: () => Promise<void>;
  onError: (error: unknown) => void;
  intervalMs?: number;
}): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const schedule = () => { timer = setTimeout(() => { void tick(); }, input.intervalMs ?? 2000); };
  const tick = async () => {
    try { await input.refresh(); }
    catch (error) { if (!stopped) input.onError(error); }
    if (!stopped) schedule();
  };
  schedule();
  return () => { stopped = true; clearTimeout(timer); };
}
