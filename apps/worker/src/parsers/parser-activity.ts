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
      return async (argv, signal) => {
        active += 1;
        try {
          const result = await run(argv, signal);
          signal.throwIfAborted();
          if (result.exitCode === 0 && argv.includes("--input") && !argv.includes("--inspect-pdf")
            && decodeParserOutput(result.stdout).length > 0) succeededAt = now();
          return result;
        } finally { active -= 1; }
      };
    },
  };
}
