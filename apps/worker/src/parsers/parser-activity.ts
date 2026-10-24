import { decodeParserOutput } from "./docling-process";
import type { ParserRunner } from "./types";

/** Only successfully decoded document/segment subprocess output is evidence.
 * Queue occupancy, cached chunks, text/image passthrough and OCR probes are not. */
export function createParserActivity(now: () => number = () => performance.now()) {
  let active = 0;
  let succeededAt = -Infinity;
  return {
    canReuseHealth(maxAgeMs: number) { return active > 0 && now() - succeededAt < maxAgeMs; },
    wrap(run: ParserRunner): ParserRunner {
      return async (argv, signal, stream) => {
        active += 1;
        try {
          const document = argv.includes("--input") && !argv.includes("--inspect-pdf");
          const result = await run(argv, signal, stream ? { onLine: async line => {
            // The consumer validates requested range/order/completeness and commits
            // its fenced write first. Rejected callbacks are never success evidence.
            await stream.onLine(line);
            signal.throwIfAborted();
            if (document) {
              const row = JSON.parse(line) as { pages?: unknown; error?: unknown };
              if (!("error" in row) && Array.isArray(row.pages) && decodeParserOutput(line).length > 0) succeededAt = now();
            }
          } } : undefined);
          signal.throwIfAborted();
          if (!stream && result.exitCode === 0 && document
            && decodeParserOutput(result.stdout).length > 0) succeededAt = now();
          return result;
        } finally { active -= 1; }
      };
    },
  };
}
