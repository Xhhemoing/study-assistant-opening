import { PARSER_HEALTH_TTL_MS, type ParserOcrHealth } from "@aistudy/database";

/** A parser may consume only while its Worker report is fresh. This local lease
 * is conservative (starts before the DB write) and checked at dispatch too, so
 * delayed timers/event-loop suspension cannot admit work with an expired report.
 * A failed/hung renewal is fail-stop; late success cannot revive the consumer. */
export function createParserHealthLease(deps: {
  reportedAt: number;
  refresh: () => Promise<ParserOcrHealth>;
  onUnavailable: (error: Error) => void;
  now?: () => number;
  ttlMs?: number;
}) {
  const now = deps.now ?? (() => performance.now());
  const ttl = deps.ttlMs ?? PARSER_HEALTH_TTL_MS - 30_000;
  let expiresAt = deps.reportedAt + ttl;
  let stopped = false;
  let unavailable = false;
  const lifecycle = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const invalidate = () => {
    if (unavailable || stopped) return;
    unavailable = true;
    clearTimeout(timer);
    lifecycle.abort(new Error("Parser health lease unavailable"));
    deps.onUnavailable(new Error("Parser health report expired or renewal failed; restart the Worker after fixing health reporting"));
  };
  const arm = () => {
    clearTimeout(timer);
    if (expiresAt <= now()) { invalidate(); return; }
    timer = setTimeout(invalidate, expiresAt - now());
    timer.unref();
  };
  const assertCurrent = () => {
    if (now() >= expiresAt) invalidate();
    if (unavailable || stopped) throw new Error("Parser consumer has no current Worker health report");
  };
  arm();
  return {
    assertCurrent,
    async renew() {
      assertCurrent();
      const startedAt = now();
      try {
        const report = await new Promise<ParserOcrHealth>((resolve, reject) => {
          const abort = () => reject(lifecycle.signal.reason);
          lifecycle.signal.addEventListener("abort", abort, { once: true });
          // Keep handlers on abandoned work so late rejections are observed.
          Promise.resolve().then(() => {
            lifecycle.signal.throwIfAborted();
            return deps.refresh();
          }).then(resolve, reject).finally(() => {
            lifecycle.signal.removeEventListener("abort", abort);
          });
          if (lifecycle.signal.aborted) abort();
        });
        assertCurrent();
        if (report.status === "missing_files" || report.status === "preflight_failed") throw new Error("Parser OCR preflight failed");
        expiresAt = startedAt + ttl;
        arm();
      } catch (error) {
        invalidate();
        throw error;
      }
    },
    stop() { stopped = true; clearTimeout(timer); lifecycle.abort(new Error("Parser health lease stopped")); },
  };
}
