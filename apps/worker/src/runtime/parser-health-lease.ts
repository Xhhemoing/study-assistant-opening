import { PARSER_HEALTH_TTL_MS, type ParserOcrHealth } from "@aistudy/database";

/** Local admission fence: failures tolerate only a still-fresh prior report.
 * Expiry is checked synchronously as well as by timer (event-loop suspension). */
export function createParserHealthLease(deps: {
  reportedAt: number;
  refresh: (signal: AbortSignal) => Promise<ParserOcrHealth>;
  onUnavailable: (error: Error) => void;
  onAvailable?: () => void;
  now?: () => number;
  ttlMs?: number;
  renewalTimeoutMs?: number;
}) {
  const now = deps.now ?? (() => performance.now());
  const ttl = deps.ttlMs ?? PARSER_HEALTH_TTL_MS - 30_000;
  let expiresAt = deps.reportedAt + ttl;
  let stopped = false;
  let unavailable = false;
  let failures = 0;
  let active: Promise<void> | undefined;
  let attempt: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const invalidate = () => {
    if (unavailable || stopped) return;
    unavailable = true;
    clearTimeout(timer);
    deps.onUnavailable(new Error("Parser health expired or failed three consecutive renewals; parser consumers paused"));
  };
  const isCurrent = () => {
    if (now() >= expiresAt) invalidate();
    return !stopped && !unavailable;
  };
  const arm = () => {
    clearTimeout(timer);
    if (expiresAt <= now()) { invalidate(); return; }
    timer = setTimeout(invalidate, expiresAt - now());
    timer.unref();
  };
  const assertCurrent = () => {
    if (!isCurrent()) throw new Error("Parser consumer has no current Worker health report");
  };
  arm();
  return {
    assertCurrent,
    isCurrent,
    renew(): Promise<void> {
      if (stopped) return Promise.reject(new Error("Parser health lease stopped"));
      if (active) return active;
      const startedAt = now();
      const controller = new AbortController();
      attempt = controller;
      active = (async () => {
        let deadline: ReturnType<typeof setTimeout> | undefined;
        let abort: (() => void) | undefined;
        try {
          const report = await new Promise<ParserOcrHealth>((resolve, reject) => {
            abort = () => reject(controller.signal.reason);
            controller.signal.addEventListener("abort", abort, { once: true });
            deadline = setTimeout(() => controller.abort(new Error("Parser health renewal timed out")), deps.renewalTimeoutMs ?? 150_000);
            deadline.unref();
            // Late resolution/rejection is observed but cannot revive an aborted lease.
            Promise.resolve().then(() => {
              controller.signal.throwIfAborted();
              return deps.refresh(controller.signal);
            }).then(resolve, reject);
          });
          controller.signal.throwIfAborted();
          if (stopped) throw new Error("Parser health lease stopped");
          if (report.status === "missing_files" || report.status === "preflight_failed") throw new Error("Parser OCR preflight failed");
          if (startedAt + ttl <= now()) throw new Error("Parser health renewal report already expired");
          expiresAt = startedAt + ttl;
          failures = 0;
          const recovering = unavailable;
          unavailable = false;
          arm();
          if (recovering) deps.onAvailable?.();
        } catch (error) {
          if (!stopped) {
            failures += 1;
            if (failures >= 3 || now() >= expiresAt) invalidate();
          }
          throw error;
        } finally {
          clearTimeout(deadline);
          if (abort) controller.signal.removeEventListener("abort", abort);
          attempt = undefined;
          active = undefined;
        }
      })();
      return active;
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      attempt?.abort(new Error("Parser health lease stopped"));
    },
  };
}
