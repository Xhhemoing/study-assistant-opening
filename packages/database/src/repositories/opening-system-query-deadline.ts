/** Bound pool waits and the final permission read, in addition to per-statement SQL timeouts. */
export async function withSystemQueryReadDeadline<T>(outer: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (outer.aborted) throw new Error("system query cancelled");
  const controller = new AbortController();
  let rejectAbort!: (reason: Error) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abort = () => { controller.abort(); rejectAbort(new Error("system query cancelled or timed out")); };
  outer.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 12000);
  try {
    const result = await Promise.race([run(controller.signal), aborted]);
    if (controller.signal.aborted || outer.aborted) throw new Error("system query cancelled");
    return result;
  } finally { clearTimeout(timer); outer.removeEventListener("abort", abort); }
}
