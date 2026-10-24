import type { WorkerRole } from "@aistudy/config";
import { preflightParser } from "../parsers/parser-preflight";
import type { ParserRunner } from "../parsers/types";
import { OPENING_QUEUE_KINDS } from "./queue";
import type { ParserOcrHealth } from "@aistudy/database";
import { probeParserOcr } from "../parsers/ocr-health";

const PARSER_QUEUES = new Set<string>(["parse", "parse-media"]);

/** Producer queues remain complete; only consumers and parser dependencies vary. */
export async function prepareWorkerRole(
  role: WorkerRole,
  checkParser: () => Promise<ParserRunner> = preflightParser,
  health: { probe?: () => Promise<ParserOcrHealth>; record?: (report: ParserOcrHealth) => Promise<void> } = {},
) {
  const queueKinds = new Set<string>(OPENING_QUEUE_KINDS.filter(kind =>
    role === "all" || (role === "parser" ? PARSER_QUEUES.has(kind) : !PARSER_QUEUES.has(kind)),
  ));
  // Record even missing-model/preflight failures before refusing startup. A
  // learning-only worker must not overwrite reports from parser consumers.
  const refreshParserHealth = role === "learning" ? null : async () => {
    const report = await (health.probe ?? probeParserOcr)();
    await health.record?.(report);
    return report;
  };
  const parserOcrHealth = role === "learning" ? null : await (health.probe ?? probeParserOcr)();
  // Do not catch parser failures: all/parser must never start a broken parser consumer.
  let parserRunner: ParserRunner | null = null;
  if (role !== "learning") {
    try { parserRunner = await checkParser(); }
    catch (error) {
      // Preserve import/path preflight before DB access when OCR is disabled.
      // Configured OCR failures need a persisted diagnostic before refusing startup.
      if (parserOcrHealth?.directoryConfigured) await health.record?.(parserOcrHealth.status === "ready"
        ? { ...parserOcrHealth, status: "preflight_failed", inferenceMs: null } : parserOcrHealth);
      throw error;
    }
    if (parserOcrHealth) await health.record?.(parserOcrHealth);
    if (parserOcrHealth?.status === "missing_files" || parserOcrHealth?.status === "preflight_failed") {
      throw new Error("Parser OCR startup failed; check the Worker OCR health report and prepared local models");
    }
  }
  return { queueKinds, parserRunner, parserOcrHealth, refreshParserHealth };
}
