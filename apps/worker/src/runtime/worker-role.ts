import type { WorkerRole } from "@aistudy/config";
import { preflightParser } from "../parsers/parser-preflight";
import type { ParserRunner } from "../parsers/types";
import { OPENING_QUEUE_KINDS } from "./queue";
import type { ParserOcrHealth } from "@aistudy/database";
import { probeParserOcr } from "../parsers/ocr-health";
import { createParserActivity } from "../parsers/parser-activity";

const PARSER_QUEUES = new Set<string>(["parse", "parse-media"]);

/** Producer queues remain complete; only consumers and parser dependencies vary. */
export async function prepareWorkerRole(
  role: WorkerRole,
  checkParser: () => Promise<ParserRunner> = preflightParser,
  health: { probe?: (signal?: AbortSignal) => Promise<ParserOcrHealth>; record?: (report: ParserOcrHealth) => Promise<void>; now?: () => number; evidenceTtlMs?: number } = {},
) {
  const queueKinds = new Set<string>(OPENING_QUEUE_KINDS.filter(kind =>
    role === "all" || (role === "parser" ? PARSER_QUEUES.has(kind) : !PARSER_QUEUES.has(kind)),
  ));
  // Record even missing-model/preflight failures before refusing startup. A
  // learning-only worker must not overwrite reports from parser consumers.
  const activity = createParserActivity(health.now);
  const probe = (signal?: AbortSignal) => health.probe ? health.probe(signal) : probeParserOcr(undefined, process.env, signal);
  let lastReport: ParserOcrHealth | null = null;
  const refreshParserHealth = role === "learning" ? null : async (signal?: AbortSignal) => {
    const report = lastReport?.status === "ready" && activity.canReuseHealth(health.evidenceTtlMs ?? 5 * 60_000)
      ? lastReport : await probe(signal);
    signal?.throwIfAborted();
    await health.record?.(report);
    signal?.throwIfAborted();
    lastReport = report;
    return report;
  };
  const parserOcrHealth = role === "learning" ? null : await probe();
  lastReport = parserOcrHealth;
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
  return { queueKinds, parserRunner: parserRunner ? activity.wrap(parserRunner) : null, parserOcrHealth, refreshParserHealth };
}

export const isParserQueue = (kind: string) => PARSER_QUEUES.has(kind);

/** Reconcile existing consumers only; recovery never constructs another Worker. */
export async function reconcileParserConsumers(
  consumers: Array<{ kind: string; pause(): Promise<unknown>; resume(): Promise<unknown> }>,
  isCurrent: () => boolean,
  isStopping: () => boolean,
): Promise<void> {
  for (const consumer of consumers) {
    if (isStopping()) return;
    if (!isParserQueue(consumer.kind)) continue;
    if (isCurrent()) await consumer.resume();
    else await consumer.pause();
  }
}
